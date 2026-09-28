/**
 * Unit tests for request hardening: CLI tool flags, image staging cleanup,
 * tolerant parsing of request fields, fail-closed API key file.
 *
 * Run: node --test dist/subprocess/hardening.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeSubprocess, stageImages } from "./manager.js";
import { extractEffort, extractImages } from "../adapter/openai-to-cli.js";

function argsFor(options: Record<string, unknown>): string[] {
  return (new ClaudeSubprocess() as any).buildArgs({ model: "sonnet", ...options });
}

describe("CLI tool flags", () => {
  it("client tools disable built-ins and MCP servers", () => {
    const args = argsFor({ disableBuiltinTools: true });
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(args.includes("--strict-mcp-config"));
  });

  it("client tools with staged images keep only Read", () => {
    const args = argsFor({ disableBuiltinTools: true, allowImageRead: true });
    assert.equal(args[args.indexOf("--tools") + 1], "Read");
  });

  it("default requests keep all tools", () => {
    const args = argsFor({});
    assert.ok(!args.includes("--tools"));
    assert.ok(!args.includes("--strict-mcp-config"));
  });
});

describe("image staging", () => {
  it("leaves no temp dir behind when nothing is staged", async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("cmap-img-")).length;
    const paths = await stageImages([{ mimeType: "", data: "", sourceUrl: "http://127.0.0.1/x.png" }]);
    assert.deepEqual(paths, []);
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("cmap-img-")).length;
    assert.equal(after, before);
  });
});

describe("request field parsing", () => {
  it("ignores non-string effort values", () => {
    assert.equal(extractEffort({ model: "x", messages: [], reasoning_effort: 5 } as any), undefined);
    assert.equal(extractEffort({ model: "x", messages: [], effort: "HIGH" } as any), "high");
  });

  it("ignores non-string image URLs", () => {
    const images = extractImages([
      { role: "user", content: [{ type: "image_url", image_url: { url: { evil: 1 } } }] },
    ] as any);
    assert.deepEqual(images, []);
  });
});

describe("API key file", () => {
  it("refuses to start with an empty key file", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "keyfile-")), "api-key");
    writeFileSync(file, "");
    delete process.env.PROXY_API_KEY;
    process.env.PROXY_API_KEY_FILE = file;
    // Fresh module instance - initApiKey caches its first result
    const auth = await import(`../server/auth.js?empty=${Date.now()}`);
    assert.throws(() => auth.initApiKey(), /empty/);
  });

  it("creates the key file with owner-only permissions", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "keyfile-")), "sub", "api-key");
    delete process.env.PROXY_API_KEY;
    process.env.PROXY_API_KEY_FILE = file;
    const auth = await import(`../server/auth.js?create=${Date.now()}`);
    const status = auth.initApiKey();
    assert.ok(status.generated && existsSync(file));
    const { statSync } = await import("node:fs");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
