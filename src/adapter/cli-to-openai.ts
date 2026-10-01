/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIToolCall } from "../types/openai.js";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming. `model` is reported verbatim
 * (callers pass the model name the client requested).
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 * `responseModel` (the model name the client requested) is reported verbatim
 * when given; otherwise the model the CLI actually used is normalized.
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  toolCalls?: OpenAIToolCall[],
  responseModel?: string
): OpenAIChatResponse {
  const modelName = responseModel
    ?? normalizeModelName(result.modelUsage ? Object.keys(result.modelUsage)[0] : undefined);

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.result,
  };

  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  // When Claude runs internal tool calls, usage.input_tokens may be 0 on the
  // final result turn. modelUsage aggregates across all turns and is reliable.
  const modelUsageValues = Object.values(result.modelUsage || {});
  const promptTokens = result.usage?.input_tokens
    || modelUsageValues.reduce((s, m) => s + (m.inputTokens || 0), 0);
  const completionTokens = result.usage?.output_tokens
    || modelUsageValues.reduce((s, m) => s + (m.outputTokens || 0), 0);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      // Prompt caching is automatic in Claude Code - surface the metrics
      ...(result.usage?.cache_read_input_tokens
        ? { cache_read_input_tokens: result.usage.cache_read_input_tokens }
        : {}),
      ...(result.usage?.cache_creation_input_tokens
        ? { cache_creation_input_tokens: result.usage.cache_creation_input_tokens }
        : {}),
    },
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  // Keep the major version visible: "claude-opus-5-..." -> "claude-opus-5"
  const m = model.match(/claude-(opus|sonnet|haiku)-(\d+)/);
  if (m) return `claude-${m[1]}-${m[2]}`;
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
