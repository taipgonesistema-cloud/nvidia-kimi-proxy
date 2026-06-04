package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"nvidia-proxy/internal/bridge"
	"nvidia-proxy/internal/utils"
)

type Handler struct {
	bridge *bridge.Client
}

func New(b *bridge.Client) *Handler {
	return &Handler{bridge: b}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/models", h.Models)
	mux.HandleFunc("/v1/chat/completions", h.ChatCompletions)
	mux.HandleFunc("/v1/chat/completions/", h.ChatCompletions)
}

func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	utils.SetCORS(w.Header().Set)
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	models := utils.ModelsResponse{
		Object: "list",
		Data: []utils.Model{{
			ID:      "moonshotai/kimi-k2.6",
			Object:  "model",
			Created: utils.CreatedTime(),
			OwnedBy: "nvidia",
		}},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

func (h *Handler) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	utils.SetCORS(w.Header().Set)
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	if r.Method != "POST" {
		writeError(w, 405, "Method not allowed, use POST")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, 400, fmt.Sprintf("read error: %v", err))
		return
	}

	var req utils.ChatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, 400, fmt.Sprintf("invalid JSON: %v", err))
		return
	}

	if len(req.Messages) == 0 {
		writeError(w, 400, "messages is required")
		return
	}

	payload := utils.BuildPredictPayload(req)
	jsonBody, _ := json.Marshal(payload)

	respText, err := h.bridge.Predict(string(jsonBody))
	if err != nil {
		log.Printf("predict error: %v", err)
		writeError(w, 502, fmt.Sprintf("predict failed: %v", err))
		return
	}

	oaiResp := utils.ConvertJSONToResponse(respText)
	if oaiResp == nil {
		writeError(w, 502, "response parse error")
		return
	}

	if req.Stream {
		h.writeStream(w, oaiResp)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(oaiResp)
	}
}

func (h *Handler) writeStream(w http.ResponseWriter, resp *utils.OpenAIResponse) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	choice := resp.Choices[0]
	content := choice.Message.Content
	toolCalls := choice.Message.ToolCalls

	roleChunk := map[string]any{
		"id":      resp.ID,
		"object":  "chat.completion.chunk",
		"created": resp.Created,
		"model":   resp.Model,
		"choices": []map[string]any{{
			"index":         0,
			"delta":         map[string]string{"role": "assistant"},
			"finish_reason": nil,
		}},
	}
	data, _ := json.Marshal(roleChunk)
	fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()

	if len(toolCalls) > 0 {
		toolChunk := map[string]any{
			"id":      resp.ID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]any{{
				"index": 0,
				"delta": map[string]any{
					"tool_calls": utils.ToolCallsForStream(toolCalls),
				},
				"finish_reason": nil,
			}},
		}
		data, _ = json.Marshal(toolChunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	} else if content != "" {
		contentChunk := map[string]any{
			"id":      resp.ID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]any{{
				"index":         0,
				"delta":         map[string]string{"content": content},
				"finish_reason": nil,
			}},
		}
		data, _ = json.Marshal(contentChunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	finishReason := any(nil)
	if choice.FinishReason != nil {
		finishReason = *choice.FinishReason
	}
	finishChunk := map[string]any{
		"id":      resp.ID,
		"object":  "chat.completion.chunk",
		"created": resp.Created,
		"model":   resp.Model,
		"choices": []map[string]any{{
			"index": 0,
			"delta": map[string]any{
				"content": "",
			},
			"finish_reason": finishReason,
		}},
	}
	data, _ = json.Marshal(finishChunk)
	fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()

	if resp.Usage != nil {
		usageChunk := map[string]any{
			"id":      resp.ID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]any{},
			"usage":   resp.Usage,
		}
		data, _ := json.Marshal(usageChunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(utils.ErrorResponse{
		Error: utils.ErrorDetail{Message: msg, Type: "error", Code: fmt.Sprintf("%d", status)},
	})
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "nvidia-proxy"})
}

func init() {
}
