/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import { apiKeyAuth, adminAuth, initApiKey } from "./auth.js";
import { createAdminRouter } from "./admin.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseList(value: string | undefined): string[] {
  return (value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Host names (without port) the server answers to. Blocks DNS rebinding:
 * a hostile page that re-points its own domain at 127.0.0.1 still sends its
 * own domain in the Host header.
 * - ALLOWED_HOSTS env (comma-separated, "*" disables the check) wins.
 * - Bound to loopback: only localhost names.
 * - Bound to a routable address (e.g. 0.0.0.0 in Docker): not checked,
 *   the API key is the protection there.
 */
function allowedHostnames(bindHost: string): Set<string> | null {
  const configured = parseList(process.env.ALLOWED_HOSTS).map((h) => h.toLowerCase());
  if (configured.includes("*")) return null;
  if (configured.length > 0) return new Set(configured);
  if (LOOPBACK_HOSTS.has(bindHost)) return new Set(LOOPBACK_HOSTS);
  return null;
}

function hostnameOf(hostHeader: string): string {
  // "[::1]:3456" -> "::1", "localhost:3456" -> "localhost"
  const bracketed = hostHeader.match(/^\[([^\]]+)\]/);
  if (bracketed) return bracketed[1].toLowerCase();
  return hostHeader.replace(/:\d+$/, "").toLowerCase();
}

/**
 * Create and configure the Express app
 */
function createApp(bindHost: string): Express {
  const app = express();

  // Reject requests addressed to a foreign Host (DNS rebinding)
  const hosts = allowedHostnames(bindHost);
  if (hosts) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (hosts.has(hostnameOf(req.headers.host || ""))) return next();
      res.status(403).json({
        error: { message: "Host not allowed", type: "invalid_request_error", code: "host_not_allowed" },
      });
    });
  }

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      if (process.env.DEBUG) {
        console.log("[Body raw]:", raw.substring(0, 200));
      }
      try {
        req.body = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Body parse error]:", msg);
        if (process.env.DEBUG) {
          console.error("[Body raw]:", raw.substring(0, 300));
        } else {
          console.error("[Body metadata]:", {
            length: raw.length,
            method: req.method,
            url: req.originalUrl,
          });
        }
        return next(err);
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS: browsers may only call the proxy from explicitly allowed origins
  // (CORS_ORIGINS env, comma-separated). By default no origin is allowed, so a
  // web page the user happens to visit cannot drive the local CLI.
  const corsOrigins = new Set(parseList(process.env.CORS_ORIGINS));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const allowed = !!origin && corsOrigins.has(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(allowed ? 204 : 403);
      return;
    }
    next();
  });

  // API key authentication (protects all routes except /health, see auth.ts)
  app.use(apiKeyAuth);

  // Admin routes (relogin flow) - separate key requirement
  app.use("/admin", adminAuth, createAdminRouter());

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  // Every entry point (standalone, OpenClaw plugin, CLI command) goes through
  // here, so auth can't be skipped by starting the server another way
  initApiKey();

  const app = createApp(host);

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
