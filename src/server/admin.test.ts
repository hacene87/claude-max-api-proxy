/**
 * Admin relogin flow tests against a fake `claude` binary (CLAUDE_BIN),
 * so no real login happens and no tokens are used.
 *
 * Run: node --test dist/server/admin.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "./index.js";

const KEY = "sk-proxy-admin-test";
let baseUrl: string;

// Prints an OAuth URL, waits for a code line on stdin, exits 0 if it is "good"
const FAKE_CLAUDE = `#!/usr/bin/env node
console.log("Open this URL: https://claude.ai/oauth/authorize?fake=1");
process.stdin.once("data", (d) => {
  setTimeout(() => process.exit(d.toString().trim() === "good" ? 0 : 1), 200);
});
`;

function post(p: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.PROXY_API_KEY = KEY;
  const server = await startServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await post("/admin/relogin/cancel");
  await stopServer();
});

describe("admin relogin", () => {
  it("requires the admin key", async () => {
    const res = await fetch(`${baseUrl}/admin/relogin/status`);
    assert.equal(res.status, 401);
  });

  it("a restarted flow is not clobbered by the killed predecessor", async () => {
    assert.equal((await post("/admin/relogin/start")).status, 200);
    await post("/admin/relogin/cancel");
    const res = await post("/admin/relogin/start");
    assert.equal(res.status, 200);
    // Give the cancelled process time to exit and fire its close handler
    await new Promise((r) => setTimeout(r, 300));
    const status = await (await fetch(`${baseUrl}/admin/relogin/status`, {
      headers: { Authorization: `Bearer ${KEY}` },
    })).json() as { state: string };
    assert.equal(status.state, "awaiting_code");
  });

  it("rejects a second code instead of crashing", async () => {
    const first = post("/admin/relogin/complete", { code: "good" });
    const second = await post("/admin/relogin/complete", { code: "good" });
    assert.equal(second.status, 409);
    assert.equal((await first).status, 200);
    // Server still alive
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  });
});
