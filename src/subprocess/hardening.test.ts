/**
 * Unit tests for request hardening: CLI tool flags, image staging cleanup,
 * tolerant parsing of request fields, fail-closed API key file.
 *
 * Run: node --test dist/subprocess/hardening.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ClaudeSubprocess, cleanupImages, optimizeImage, stageImages } from "./manager.js";
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

describe("large image optimization", () => {
  const solid = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });

  it("downscales an oversized image to IMAGE_MAX_EDGE as JPEG", async () => {
    const big = await solid(6000, 3000).jpeg().toBuffer();
    const out = await optimizeImage(big, "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    assert.equal(out.mime, "image/jpeg");
    assert.equal(meta.width, 2576);
    assert.equal(meta.height, 1288);
  });

  it("keeps PNG for screenshots when the result stays small", async () => {
    const png = await solid(4000, 4000).png().toBuffer();
    const out = await optimizeImage(png, "image/png");
    assert.equal(out.mime, "image/png");
    assert.equal((await sharp(out.buffer).metadata()).width, 2576);
  });

  it("leaves small, supported images byte-for-byte untouched", async () => {
    const small = await solid(800, 600).png().toBuffer();
    const out = await optimizeImage(small, "image/png");
    assert.equal(out.buffer, small);
    assert.equal(out.mime, "image/png");
  });

  it("converts formats Claude can't read (TIFF) to JPEG", async () => {
    const tiff = await solid(500, 500).tiff().toBuffer();
    const out = await optimizeImage(tiff, "image/tiff");
    assert.equal(out.mime, "image/jpeg");
    assert.equal((await sharp(out.buffer).metadata()).format, "jpeg");
  });

  it("applies EXIF rotation", async () => {
    // 600x300 stored, orientation 6 = rotate 90deg on display -> 300x600
    const rotated = await solid(600, 300).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await optimizeImage(rotated, "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.width, 300);
    assert.equal(meta.height, 600);
  });

  it("does nothing when IMAGE_MAX_EDGE=0", async () => {
    process.env.IMAGE_MAX_EDGE = "0";
    try {
      const big = await solid(5000, 5000).jpeg().toBuffer();
      const out = await optimizeImage(big, "image/jpeg");
      assert.equal(out.buffer, big);
    } finally {
      delete process.env.IMAGE_MAX_EDGE;
    }
  });

  it("returns the original for undecodable data", async () => {
    const junk = Buffer.from("not an image");
    const out = await optimizeImage(junk, "image/png");
    assert.equal(out.buffer, junk);
  });

  it("stages a large base64 image already downscaled", async () => {
    const big = await solid(7000, 7000).jpeg().toBuffer();
    const paths = await stageImages([{ mimeType: "image/jpeg", data: big.toString("base64") }]);
    try {
      assert.equal(paths.length, 1);
      const meta = await sharp(readFileSync(paths[0])).metadata();
      assert.equal(Math.max(meta.width!, meta.height!), 2576);
    } finally {
      await cleanupImages(paths);
    }
  });

  it("rejects images above MAX_IMAGE_MB", async () => {
    process.env.MAX_IMAGE_MB = "0.001"; // ~1 KB
    try {
      const img = await solid(400, 400).png({ compressionLevel: 0 }).toBuffer();
      assert.deepEqual(await stageImages([{ mimeType: "image/png", data: img.toString("base64") }]), []);
    } finally {
      delete process.env.MAX_IMAGE_MB;
    }
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
