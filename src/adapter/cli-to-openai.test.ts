/**
 * Unit tests for the CLI -> OpenAI response adapter (no CLI calls).
 *
 * Run: node --test dist/adapter/cli-to-openai.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cliResultToOpenai, createDoneChunk } from "./cli-to-openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

const result = {
  type: "result",
  subtype: "success",
  result: "PONG",
  usage: { input_tokens: 2, output_tokens: 5 },
  modelUsage: { "claude-sonnet-5-20260901": { inputTokens: 2, outputTokens: 5 } },
} as unknown as ClaudeCliResult;

describe("response model name", () => {
  it("echoes the requested model even when the CLI resolved a newer one", () => {
    assert.equal(cliResultToOpenai(result, "abc", undefined, "claude-sonnet-4").model, "claude-sonnet-4");
  });

  it("keeps a provider-prefixed request model verbatim", () => {
    const res = cliResultToOpenai(result, "abc", undefined, "claude-max/claude-opus-4");
    assert.equal(res.model, "claude-max/claude-opus-4");
  });

  it("falls back to the normalized CLI model when no request model is given", () => {
    assert.equal(cliResultToOpenai(result, "abc").model, "claude-sonnet-5");
  });

  it("reports the done chunk model verbatim", () => {
    assert.equal(createDoneChunk("abc", "claude-sonnet-4").model, "claude-sonnet-4");
  });
});
