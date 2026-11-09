import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";

const DEFAULT_PORT = 49777;

/**
 * Every request must carry `Authorization: Bearer <token>`. The token lives in a file only this
 * user can read, shared by every VS Code window (so one window can ask another to release the
 * port) and by the MCP client config. Without it, any local process could run code in the kernel.
 */
export const TOKEN_PATH = path.join(os.homedir(), ".config", "notebook-mcp", "token");

export function loadOrCreateToken(): string {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      fs.chmodSync(TOKEN_PATH, 0o600);
      return existing;
    }
  } catch {
    // missing: create below
  }
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

let authToken: string | undefined;
function token(): string {
  authToken ??= loadOrCreateToken();
  return authToken;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` };
}

/**
 * Refuse anything a browser could send (it always attaches Origin to cross-origin requests),
 * any Host other than loopback (DNS rebinding), and any request without the bearer token.
 */
export function rejectReason(req: http.IncomingMessage, port: number, expected: string): string | undefined {
  if (req.headers.origin !== undefined) {
    return "browser requests are not allowed";
  }
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return "bad host";
  }
  const auth = req.headers.authorization ?? "";
  const got = Buffer.from(auth);
  const want = Buffer.from(`Bearer ${expected}`);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return "unauthorized";
  }
  return undefined;
}

export interface ServerStartResult {
  port: number;
  isExistingServer: boolean;
}

/**
 * Check if an MCP server is already running on the given port
 */
export async function isServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers: authHeaders(),
        timeout: 1000
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.server === "notebook-mcp-server" && json.status === "ok");
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Request another MCP server to release (stop) so this window can take over
 */
export async function requestServerRelease(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/release",
        method: "POST",
        headers: authHeaders(),
        timeout: 2000
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

let httpServer: http.Server | undefined;
const transports = new Map<string, StreamableHTTPServerTransport>();

// Callback to notify extension when server is released
let onReleaseCallback: (() => void) | undefined;

export function setOnReleaseCallback(callback: () => void): void {
  onReleaseCallback = callback;
}

export function createMCPServer(): McpServer {
  const server = new McpServer({
    name: "notebook-mcp-server",
    version: "0.1.0"
  });

  // Register all MCP tools
  registerAllTools(server);
  console.log("MCP Server: Created with tools registered");

  return server;
}

export async function startMCPServer(port: number = DEFAULT_PORT): Promise<ServerStartResult> {
  // Check if a server is already running on the configured port
  const existingServerRunning = await isServerRunning(port);
  if (existingServerRunning) {
    console.log(`MCP Server: Found existing server on port ${port}, deferring to it`);
    return { port, isExistingServer: true };
  }

  return new Promise((resolve, reject) => {
    const expected = token();
    httpServer = http.createServer(async (req, res) => {
      const reason = rejectReason(req, port, expected);
      if (reason) {
        res.writeHead(reason === "unauthorized" ? 401 : 403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: reason }));
        return;
      }

      // Handle MCP requests
      if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        try {
          // Existing session
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
            return;
          }

          // New session (POST without session ID)
          if (req.method === "POST") {
            const newSessionId = crypto.randomUUID();
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => newSessionId,
              enableJsonResponse: true
            });

            transports.set(newSessionId, transport);

            // Clean up on close
            transport.onclose = () => {
              transports.delete(newSessionId);
            };

            // A fresh server per session: a shared instance leaks state across clients
            // (GHSA advisory against SDK <=1.31.0).
            await createMCPServer().connect(transport);
            await transport.handleRequest(req, res);
            return;
          }

          // GET/DELETE without session - not valid
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing session ID" }));
        } catch (error) {
          console.error("MCP request error:", error);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      } else if (req.method === "GET" && req.url === "/health") {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          server: "notebook-mcp-server",
          workspace: workspaceFolders?.[0]?.uri.fsPath ?? null,
          activeNotebook: vscode.window.activeNotebookEditor?.notebook.uri.fsPath ?? null
        }));
      } else if (req.method === "POST" && req.url === "/release") {
        // Another window is requesting to take over - gracefully stop
        console.log("MCP Server: Received release request, stopping server synchronously");

        // Close all transports first
        for (const transport of transports.values()) {
          transport.close();
        }
        transports.clear();

        // Respond success
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ released: true }));

        // Close HTTP server after response is sent
        httpServer?.close(() => {
          httpServer = undefined;
          console.log("MCP Server: Released and stopped");
          // Notify extension of release
          if (onReleaseCallback) {
            onReleaseCallback();
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    httpServer.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        httpServer?.close();
        // Check if the port is used by another notebook-mcp-server
        const isOurServer = await isServerRunning(port);
        if (isOurServer) {
          console.log(`MCP Server: Found existing server on port ${port}, deferring to it`);
          resolve({ port, isExistingServer: true });
        } else {
          console.log(`Port ${port} in use by another application, trying ${port + 1}`);
          startMCPServer(port + 1).then(resolve).catch(reject);
        }
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, "127.0.0.1", () => {
      console.log(`MCP Server: Listening on http://127.0.0.1:${port}/mcp`);
      resolve({ port, isExistingServer: false });
    });
  });
}

export async function stopMCPServer(): Promise<void> {
  return new Promise((resolve) => {
    // Close all transports
    for (const transport of transports.values()) {
      transport.close();
    }
    transports.clear();

    if (httpServer) {
      httpServer.close(() => {
        httpServer = undefined;
        console.log("MCP Server: Stopped");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export function getPort(): number | undefined {
  const addr = httpServer?.address();
  if (addr && typeof addr === "object") {
    return addr.port;
  }
  return undefined;
}
