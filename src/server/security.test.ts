/**
 * Security tests for the HTTP layer: API key, CORS, Host checks and image
 * URL SSRF guard. No Claude CLI calls are made (no tokens used).
 *
 * Run: node --test dist/server/security.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "./index.js";
import { stageImages } from "../subprocess/manager.js";

const KEY = "sk-proxy-test-key";
let port: number;

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, unknown> }> {
  // node:http (not fetch) so the Host header can be forged
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  process.env.PROXY_API_KEY = KEY;
  delete process.env.CORS_ORIGINS;
  delete process.env.ALLOWED_HOSTS;
  const server = await startServer({ port: 0 });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await stopServer();
});

describe("API key", () => {
  it("rejects requests without a key", async () => {
    assert.equal((await call("GET", "/v1/models")).status, 401);
  });

  it("rejects a wrong key", async () => {
    const res = await call("GET", "/v1/models", { Authorization: "Bearer nope" });
    assert.equal(res.status, 401);
  });

  it("accepts the configured key", async () => {
    const res = await call("GET", "/v1/models", { Authorization: `Bearer ${KEY}` });
    assert.equal(res.status, 200);
  });

  it("rejects unauthenticated chat completions before spawning the CLI", async () => {
    const res = await call("POST", "/v1/chat/completions", { "Content-Type": "application/json" });
    assert.equal(res.status, 401);
  });

  it("keeps /health public", async () => {
    assert.equal((await call("GET", "/health")).status, 200);
  });
});

describe("CORS", () => {
  it("refuses preflight from an arbitrary origin", async () => {
    const res = await call("OPTIONS", "/v1/chat/completions", {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  it("sends no CORS headers on normal responses", async () => {
    const res = await call("GET", "/health", { Origin: "https://evil.example" });
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});

describe("Host header (DNS rebinding)", () => {
  it("rejects a foreign Host", async () => {
    const res = await call("GET", "/health", { Host: `evil.example:${port}` });
    assert.equal(res.status, 403);
  });

  it("accepts localhost names", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      assert.equal((await call("GET", "/health", { Host: host })).status, 200, host);
    }
  });
});

describe("image URL SSRF guard", () => {
  it("does not fetch loopback, private or metadata addresses", async () => {
    const paths = await stageImages([
      { mimeType: "", data: "", sourceUrl: `http://127.0.0.1:${port}/health` },
      { mimeType: "", data: "", sourceUrl: `http://localhost:${port}/health` },
      { mimeType: "", data: "", sourceUrl: "http://169.254.169.254/latest/meta-data/" },
      { mimeType: "", data: "", sourceUrl: "http://10.0.0.1/x.png" },
      { mimeType: "", data: "", sourceUrl: "http://[::1]/x.png" },
      { mimeType: "", data: "", sourceUrl: "http://[::ffff:127.0.0.1]/x.png" },
    ]);
    assert.deepEqual(paths, []);
  });

  it("still stages inline base64 images", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const paths = await stageImages([{ mimeType: "image/png", data: png }]);
    assert.equal(paths.length, 1);
  });
});
