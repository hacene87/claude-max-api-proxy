/**
 * Security tests for the HTTP layer: API key, CORS, Host checks and image
 * URL SSRF guard. No Claude CLI calls are made (no tokens used).
 *
 * Run: node --test dist/server/security.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "./index.js";
import { cleanupImages, stageImages } from "../subprocess/manager.js";

const KEY = "sk-proxy-test-key";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
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
  process.env.MAX_BODY_SIZE = "10mb"; // keep the oversized-body test cheap
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

function post(
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("request body errors", () => {
  it("answers malformed JSON with 400 invalid_request_error", async () => {
    const res = await post("/v1/chat/completions", "{bad", { Authorization: `Bearer ${KEY}` });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.type, "invalid_request_error");
    assert.equal(res.json.error.code, "invalid_json");
  });

  it("answers an oversized body with 413, not 500", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
    const res = await post("/v1/chat/completions", big, { Authorization: `Bearer ${KEY}` });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.type, "invalid_request_error");
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

  it("with ALLOW_PRIVATE_IMAGE_URLS, stages images but never non-image bodies", async () => {
    const png = Buffer.from(PNG, "base64");
    const imgServer = createServer((req, res) => {
      if (req.url === "/img.png") {
        res.writeHead(200, { "Content-Type": "image/png" }).end(png);
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/img.png" }).end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("secret");
      }
    });
    await new Promise<void>((r) => imgServer.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(imgServer.address() as AddressInfo).port}`;
    process.env.ALLOW_PRIVATE_IMAGE_URLS = "true";
    try {
      const paths = await stageImages([
        { mimeType: "", data: "", sourceUrl: `${base}/img.png` },
        { mimeType: "", data: "", sourceUrl: `${base}/redirect` },
        { mimeType: "", data: "", sourceUrl: `${base}/secret.txt` },
      ]);
      assert.equal(paths.length, 2);
      assert.ok(paths.every((p) => p.endsWith(".png")));
      await cleanupImages(paths);
    } finally {
      delete process.env.ALLOW_PRIVATE_IMAGE_URLS;
      imgServer.close();
    }
  });

  it("still stages inline base64 images", async () => {
    const paths = await stageImages([{ mimeType: "image/png", data: PNG }]);
    assert.equal(paths.length, 1);
    await cleanupImages(paths);
  });
});
