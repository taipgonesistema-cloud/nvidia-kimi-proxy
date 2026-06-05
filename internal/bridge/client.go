package bridge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"nvidia-proxy/internal/utils"
)

type Client struct {
	BaseURL string
	TabID   string
	http    *http.Client
	mu      sync.Mutex
}

func New(tabID string) *Client {
	return &Client{
		BaseURL: "http://localhost:9223",
		TabID:   tabID,
		http:    &http.Client{Timeout: 120 * time.Second},
	}
}

func (c *Client) Eval(script string, timeoutMs int) (json.RawMessage, error) {
	return c.post(fmt.Sprintf("%s/eval?tabId=%s&timeout=%d", c.BaseURL, c.TabID, timeoutMs), script)
}

func (c *Client) EvalAsync(script string, timeoutMs int) (json.RawMessage, error) {
	return c.post(fmt.Sprintf("%s/evalAsync?tabId=%s&timeout=%d", c.BaseURL, c.TabID, timeoutMs), script)
}

type bridgeResp struct {
	ID     string          `json:"_id"`
	Result json.RawMessage `json:"result"`
}

type bridgeResult struct {
	Ok     bool            `json:"ok"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result"`
}

type commandResult struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type networkResponses struct {
	Ok        bool               `json:"ok"`
	Responses []CapturedResponse `json:"responses"`
	Total     int                `json:"total"`
	Returned  int                `json:"returned"`
}

type CapturedResponse struct {
	RequestID     string         `json:"requestId"`
	URL           string         `json:"url"`
	Status        int            `json:"status"`
	StatusText    string         `json:"statusText"`
	Headers       map[string]any `json:"headers"`
	MimeType      string         `json:"mimeType"`
	Type          string         `json:"type"`
	PostData      string         `json:"postData"`
	Body          string         `json:"body"`
	Base64Encoded bool           `json:"base64Encoded"`
	Timestamp     int64          `json:"timestamp"`
}

func (c *Client) post(url, script string) (json.RawMessage, error) {
	req, err := http.NewRequest("POST", url, bytes.NewReader([]byte(script)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bridge request failed: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 10<<20))

	var br bridgeResp
	if err := json.Unmarshal(raw, &br); err != nil {
		return nil, fmt.Errorf("bridge parse error: %s", string(raw))
	}

	var result bridgeResult
	if err := json.Unmarshal(br.Result, &result); err != nil {
		return nil, fmt.Errorf("result parse error: %s", string(br.Result))
	}

	if !result.Ok {
		return nil, fmt.Errorf("bridge error: %s", result.Error)
	}

	return result.Result, nil
}

func (c *Client) command(method, endpoint string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.BaseURL+endpoint, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bridge command failed: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	var br bridgeResp
	if err := json.Unmarshal(raw, &br); err != nil {
		return nil, fmt.Errorf("bridge command parse error: %s", string(raw))
	}

	var cr commandResult
	if err := json.Unmarshal(br.Result, &cr); err == nil && !cr.Ok {
		return nil, fmt.Errorf("bridge command error: %s", cr.Error)
	}
	return br.Result, nil
}

func (c *Client) rawCDP(method string, params map[string]any) error {
	payload := map[string]any{
		"tabId":  c.TabID,
		"method": method,
		"params": params,
	}
	_, err := c.command(http.MethodPost, "/rawCDP?timeout=10000", payload)
	return err
}

func (c *Client) SendChatMessage(text string) error {
	js, _ := json.Marshal(text)
	script := fmt.Sprintf(`(function(){
		var ta=document.querySelector('[data-testid=nv-text-area-element]');
		if(!ta) return 'no textarea';
		ta.value=%s;
		ta.dispatchEvent(new Event('input',{bubbles:true}));
		ta.dispatchEvent(new Event('change',{bubbles:true}));
		ta.focus();
		var enter=new KeyboardEvent('keydown',{key:'Enter',keyCode:13,code:'Enter',bubbles:true,cancelable:true});
		ta.dispatchEvent(enter);
		return 'sent';
	})()`, string(js))
	_, err := c.Eval(script, 15000)
	return err
}

func (c *Client) Predict(bodyJSON string, model utils.ModelConfig) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.preparePlayground(model); err != nil {
		return "", err
	}
	if err := c.networkStart("predict/models"); err != nil {
		return "", err
	}
	defer c.rewriteFetchStop()

	if err := c.rewriteFetchStart(bodyJSON); err != nil {
		return "", err
	}
	if err := c.triggerPlaygroundRequest(); err != nil {
		return "", err
	}
	return c.waitForPredictBody(bodyJSON, 120*time.Second)
}

func (c *Client) preparePlayground(model utils.ModelConfig) error {
	playgroundURL := model.PlaygroundURL
	script := fmt.Sprintf(`(function(){
		if (!location.href.startsWith(%q)) location.href = %q;
		return "ready";
	})()`, playgroundURL, playgroundURL)
	_, _ = c.Eval(script, 10000)

	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if c.playgroundReady() {
			return nil
		}
		time.Sleep(750 * time.Millisecond)
	}
	return fmt.Errorf("playground did not expose example trigger in time")
}

func (c *Client) playgroundReady() bool {
	raw, err := c.Eval(`(function(){
		return JSON.stringify({
			ready: document.readyState,
			textarea: !!(document.querySelector('[data-testid="nv-text-area-element"]') || document.querySelector('.nv-text-area-element') || document.querySelector('textarea')),
			send: !![...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Send')
		});
	})()`, 10000)
	if err != nil {
		return false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	var state struct {
		Ready    string `json:"ready"`
		Textarea bool   `json:"textarea"`
		Send     bool   `json:"send"`
	}
	if err := json.Unmarshal([]byte(s), &state); err != nil {
		return false
	}
	return state.Ready == "complete" && state.Textarea && state.Send
}

func (c *Client) networkStart(filter string) error {
	endpoint := fmt.Sprintf("/networkStart?tabId=%s&filter=%s&timeout=10000", url.QueryEscape(c.TabID), url.QueryEscape(filter))
	_, err := c.command(http.MethodGet, endpoint, nil)
	return err
}

func (c *Client) networkResponses(max int) ([]CapturedResponse, error) {
	endpoint := fmt.Sprintf("/networkResponses?max=%d&timeout=10000", max)
	raw, err := c.command(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	var nr networkResponses
	if err := json.Unmarshal(raw, &nr); err != nil {
		return nil, err
	}
	return nr.Responses, nil
}

func (c *Client) rewriteFetchStart(postData string) error {
	payload := map[string]any{
		"tabId":      c.TabID,
		"urlPattern": "*://api.ngc.nvidia.com/v2/predict/models/*",
		"filter":     "predict/models",
		"postData":   postData,
		"once":       true,
	}
	_, err := c.command(http.MethodPost, "/rewriteFetchStart?timeout=10000", payload)
	return err
}

func (c *Client) rewriteFetchStop() {
	_, _ = c.command(http.MethodPost, "/rewriteFetchStop?timeout=10000", nil)
}

func (c *Client) triggerPlaygroundRequest() error {
	script := `(function(){
		var ta = document.querySelector('[data-testid="nv-text-area-element"]') || document.querySelector('.nv-text-area-element') || document.querySelector('textarea');
		if (!ta) return JSON.stringify({ok:false,error:'textarea not found'});
		ta.scrollIntoView({block:'center', inline:'center'});
		ta.focus();
		ta.value = '';
		ta.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'deleteContentBackward'}));
		ta.dispatchEvent(new Event('change', {bubbles:true}));
		return JSON.stringify({ok:true});
	})()`
	raw, err := c.Eval(script, 15000)
	if err != nil {
		return err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	var result struct {
		Ok    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(s), &result); err != nil {
		return err
	}
	if !result.Ok {
		return fmt.Errorf(result.Error)
	}

	if err := c.rawCDP("Input.insertText", map[string]any{"text": "bridge trigger"}); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)

	script = `(function(){
		var button = [...document.querySelectorAll('button')].find(function(item){ return item.getAttribute('aria-label') === 'Send'; });
		if (!button) return JSON.stringify({ok:false,error:'send button not found'});
		if (button.disabled) return JSON.stringify({ok:false,error:'send button disabled'});
		button.click();
		return JSON.stringify({ok:true});
	})()`
	raw, err = c.Eval(script, 15000)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(s), &result); err != nil {
		return err
	}
	if !result.Ok {
		return fmt.Errorf(result.Error)
	}
	return nil
}

func (c *Client) waitForPredictBody(expectedPostData string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	var last *CapturedResponse
	for time.Now().Before(deadline) {
		responses, err := c.networkResponses(20)
		if err != nil {
			return "", err
		}
		for i := len(responses) - 1; i >= 0; i-- {
			res := responses[i]
			if !strings.Contains(res.URL, "predict/models") || res.Type == "Preflight" {
				continue
			}
			if expectedPostData != "" && res.PostData != expectedPostData {
				continue
			}
			last = &res
			if res.Status != 200 && res.Body != "" {
				return "", fmt.Errorf("predict HTTP %d: %s", res.Status, res.Body)
			}
			if res.Status == 200 && res.Body != "" {
				if strings.Contains(res.MimeType, "text/event-stream") && !strings.Contains(res.Body, "data: [DONE]") {
					continue
				}
				if res.Base64Encoded {
					decoded, err := base64.StdEncoding.DecodeString(res.Body)
					if err != nil {
						return "", err
					}
					return string(decoded), nil
				}
				return res.Body, nil
			}
		}
		time.Sleep(750 * time.Millisecond)
	}
	if last != nil {
		return "", fmt.Errorf("predict timed out waiting for response body (last status %d, mime %s)", last.Status, last.MimeType)
	}
	return "", fmt.Errorf("predict timed out before request was captured")
}

func unquoteJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) > 0 && raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return json.RawMessage(s)
		}
	}
	return raw
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (c *Client) GetNVCookies() (map[string]string, error) {
	raw, err := c.Eval("(function(){return document.cookie})()", 10000)
	if err != nil {
		return nil, err
	}
	var cookieStr string
	json.Unmarshal(raw, &cookieStr)

	cookies := map[string]string{}
	for _, part := range strings.Split(cookieStr, "; ") {
		part = strings.TrimSpace(part)
		if k, v, ok := strings.Cut(part, "="); ok && (strings.Contains(k, "nv") || strings.Contains(k, "_gd_") || strings.Contains(k, "session")) {
			cookies[k] = v
		}
	}
	return cookies, nil
}
