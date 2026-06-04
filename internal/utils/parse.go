package utils

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"
)

func EnvOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func EnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func RandomID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func CreatedTime() int64 {
	return time.Now().Unix()
}

func SetCORS(headers func(key, value string)) {
	headers("Access-Control-Allow-Origin", "*")
	headers("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	headers("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func MakeToolCallID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "call_" + hex.EncodeToString(b)
}

func hasRawJSON(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return trimmed != "" && trimmed != "null"
}

func BuildPredictPayload(req ChatRequest) map[string]any {
	thinking := strings.EqualFold(EnvOr("NVIDIA_THINKING", "false"), "true") || EnvOr("NVIDIA_THINKING", "false") == "1"
	payload := map[string]any{
		"model":                "moonshotai/kimi-k2.6",
		"messages":             req.Messages,
		"stream":               true,
		"chat_template_kwargs": map[string]any{"thinking": thinking},
	}
	if req.MaxTokens != nil {
		payload["max_tokens"] = *req.MaxTokens
	}
	if req.MaxCompletion != nil {
		payload["max_completion_tokens"] = *req.MaxCompletion
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if req.Seed != nil {
		payload["seed"] = *req.Seed
	}
	if req.User != "" {
		payload["user"] = req.User
	}
	if hasRawJSON(req.Stop) {
		payload["stop"] = req.Stop
	}
	if hasRawJSON(req.ResponseFormat) {
		payload["response_format"] = req.ResponseFormat
	}
	if req.ParallelToolCalls != nil {
		payload["parallel_tool_calls"] = *req.ParallelToolCalls
	}
	if hasRawJSON(req.Tools) {
		payload["tools"] = req.Tools
	}
	if hasRawJSON(req.ToolChoice) {
		payload["tool_choice"] = req.ToolChoice
	}
	return payload
}

func mergeToolCall(toolCalls []ToolCall, delta ToolCall, fallbackIndex int) []ToolCall {
	match := -1
	if delta.Index != nil {
		for i := range toolCalls {
			if toolCalls[i].Index != nil && *toolCalls[i].Index == *delta.Index {
				match = i
				break
			}
		}
	}
	if match == -1 && delta.ID != "" {
		for i := range toolCalls {
			if toolCalls[i].ID == delta.ID {
				match = i
				break
			}
		}
	}
	if match == -1 {
		if delta.Index == nil {
			idx := fallbackIndex
			delta.Index = &idx
		}
		if delta.Type == "" {
			delta.Type = "function"
		}
		return append(toolCalls, delta)
	}

	current := &toolCalls[match]
	if current.Index == nil && delta.Index != nil {
		idx := *delta.Index
		current.Index = &idx
	}
	if delta.ID != "" {
		current.ID = delta.ID
	}
	if delta.Type != "" {
		current.Type = delta.Type
	} else if current.Type == "" {
		current.Type = "function"
	}
	if delta.Function.Name != "" {
		current.Function.Name = delta.Function.Name
	}
	if delta.Function.Arguments != "" {
		current.Function.Arguments += delta.Function.Arguments
	}
	return toolCalls
}

func toolCallsForMessage(toolCalls []ToolCall) []ToolCall {
	out := make([]ToolCall, len(toolCalls))
	copy(out, toolCalls)
	for i := range out {
		out[i].Index = nil
		if out[i].Type == "" {
			out[i].Type = "function"
		}
	}
	return out
}

func ToolCallsForStream(toolCalls []ToolCall) []ToolCall {
	out := make([]ToolCall, len(toolCalls))
	copy(out, toolCalls)
	for i := range out {
		idx := i
		out[i].Index = &idx
		if out[i].Type == "" {
			out[i].Type = "function"
		}
	}
	return out
}

func ConvertSSEToResponse(sseText string) *OpenAIResponse {
	resp := &OpenAIResponse{
		ID:      "chatcmpl-" + RandomID(),
		Object:  "chat.completion",
		Created: CreatedTime(),
		Model:   "moonshotai/kimi-k2.6",
		Choices: []OpenAIChoice{{Index: 0, Message: OpenAIMessage{Role: "assistant"}, FinishReason: strPtr("stop")}},
	}

	if sseText == "" {
		return resp
	}

	var fullContent string
	var toolCalls []ToolCall
	var finishReason *string

	for _, line := range strings.Split(sseText, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				FinishReason *string `json:"finish_reason"`
				Delta        struct {
					Content   string     `json:"content"`
					ToolCalls []ToolCall `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *Usage `json:"usage,omitempty"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			resp.Usage = chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		if chunk.Choices[0].FinishReason != nil {
			finishReason = chunk.Choices[0].FinishReason
		}
		delta := chunk.Choices[0].Delta
		fullContent += delta.Content
		for i, tc := range delta.ToolCalls {
			toolCalls = mergeToolCall(toolCalls, tc, i)
		}
	}

	if fullContent != "" {
		resp.Choices[0].Message.Content = fullContent
	}
	if len(toolCalls) > 0 {
		resp.Choices[0].Message.ToolCalls = toolCallsForMessage(toolCalls)
		resp.Choices[0].Message.Content = ""
		if finishReason == nil || *finishReason == "stop" {
			finishReason = strPtr("tool_calls")
		}
	}
	if finishReason != nil {
		resp.Choices[0].FinishReason = finishReason
	}
	return resp
}

func ConvertJSONToResponse(jsonBody string) *OpenAIResponse {
	var oaiResp OpenAIResponse
	if err := json.Unmarshal([]byte(jsonBody), &oaiResp); err == nil && oaiResp.ID != "" {
		return &oaiResp
	}
	return ConvertSSEToResponse(jsonBody)
}

func ConvertToStreamChunk(resp *OpenAIResponse) string {
	var sb strings.Builder
	for i, choice := range resp.Choices {
		chunk := map[string]any{
			"id":      resp.ID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]any{{
				"index": i,
				"delta": map[string]any{
					"role":    "assistant",
					"content": choice.Message.Content,
				},
			}},
		}
		if len(choice.Message.ToolCalls) > 0 {
			chunk["choices"].([]map[string]any)[0]["delta"] = map[string]any{
				"role":       "assistant",
				"content":    "",
				"tool_calls": choice.Message.ToolCalls,
			}
		}
		data, _ := json.Marshal(chunk)
		sb.WriteString("data: ")
		sb.Write(data)
		sb.WriteString("\n\n")
	}
	sb.WriteString("data: [DONE]\n\n")
	return sb.String()
}

func strPtr(s string) *string {
	return &s
}

func init() {
}
