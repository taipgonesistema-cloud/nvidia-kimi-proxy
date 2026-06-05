package utils

import "encoding/json"

type ChatRequest struct {
	Model             string          `json:"model"`
	Messages          json.RawMessage `json:"messages"`
	MaxTokens         *int            `json:"max_tokens,omitempty"`
	MaxCompletion     *int            `json:"max_completion_tokens,omitempty"`
	Temperature       *float64        `json:"temperature,omitempty"`
	TopP              *float64        `json:"top_p,omitempty"`
	Stream            *bool           `json:"stream,omitempty"`
	Tools             json.RawMessage `json:"tools,omitempty"`
	ToolChoice        json.RawMessage `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool           `json:"parallel_tool_calls,omitempty"`
	ResponseFormat    json.RawMessage `json:"response_format,omitempty"`
	Stop              json.RawMessage `json:"stop,omitempty"`
	Seed              *int            `json:"seed,omitempty"`
	User              string          `json:"user,omitempty"`
	ReasoningEffort   string          `json:"reasoning_effort,omitempty"`
	StreamOptions     json.RawMessage `json:"stream_options,omitempty"`
}

type ToolCall struct {
	Index    *int         `json:"index,omitempty"`
	ID       string       `json:"id,omitempty"`
	Type     string       `json:"type,omitempty"`
	Function ToolCallFunc `json:"function"`
}

type ToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type OpenAIResponse struct {
	ID      string         `json:"id"`
	Object  string         `json:"object"`
	Created int64          `json:"created"`
	Model   string         `json:"model"`
	Choices []OpenAIChoice `json:"choices"`
	Usage   *Usage         `json:"usage,omitempty"`
}

type OpenAIChoice struct {
	Index        int           `json:"index"`
	Message      OpenAIMessage `json:"message,omitempty"`
	Delta        OpenAIMessage `json:"delta,omitempty"`
	FinishReason *string       `json:"finish_reason,omitempty"`
}

type OpenAIMessage struct {
	Role             string     `json:"role,omitempty"`
	Content          string     `json:"content,omitempty"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type ModelsResponse struct {
	Object string  `json:"object"`
	Data   []Model `json:"data"`
}

type Model struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
}
