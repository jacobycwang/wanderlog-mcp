/**
 * Cloudflare Workers entry point for wanderlog-mcp (Streamable HTTP, stateless).
 *
 * Auth is the same as the Node HTTP server: the client sends its Wanderlog
 * `connect.sid` cookie as `Authorization: Bearer <cookie>` (or `?token=`).
 *
 * Workers can't share a WebSocket between requests, so every request builds a
 * fresh context and closes its ShareDB sockets before returning. Responses use
 * JSON mode so the whole tool call finishes inside handleRequest().
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { normalizeCookie, type Config } from "../config.js";
import { RestClient } from "../transport/rest.js";
import { ShareDBPool } from "../transport/sharedb.js";
import { TripCache } from "../cache/trip-cache.js";
import type { AppContext } from "../context.js";
import { WanderlogError, loginFailureStatus } from "../errors.js";
import { buildServer } from "../server.js";

export interface Env {
  WANDERLOG_BASE_URL?: string;
  WANDERLOG_WS_BASE_URL?: string;
  WANDERLOG_USER_AGENT?: string;
  WANDERLOG_DEFAULT_CURRENCY?: string;
  /** Optional: if set, clients must also send `X-API-Key` / `X-Access-Key: <value>` (or ?key=). */
  ACCESS_KEY?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

// userId lookups are plain data, so they can be cached across requests in an isolate.
const userIdCache = new Map<string, { id: number; at: number }>();
const USER_TTL_MS = 10 * 60 * 1000;

async function hashCookie(cookie: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function extractCookie(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) return m[1];
  return url.searchParams.get("token");
}

function rpcError(status: number, message: string, code = -32000): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

async function buildContext(cookieRaw: string, env: Env): Promise<AppContext> {
  const cookie = normalizeCookie(cookieRaw);
  const config: Config = {
    cookieHeader: cookie,
    baseUrl: env.WANDERLOG_BASE_URL ?? "https://wanderlog.com",
    wsBaseUrl: env.WANDERLOG_WS_BASE_URL ?? "wss://wanderlog.com",
    userAgent: env.WANDERLOG_USER_AGENT ?? DEFAULT_UA,
    defaultCurrency: env.WANDERLOG_DEFAULT_CURRENCY,
  };
  const rest = new RestClient(config);
  const pool = new ShareDBPool(config);
  const tripCache = new TripCache(rest, pool);

  const key = await hashCookie(cookie);
  const hit = userIdCache.get(key);
  let userId: number;
  if (hit && Date.now() - hit.at < USER_TTL_MS) {
    userId = hit.id;
  } else {
    userId = (await rest.getUser()).id;
    userIdCache.set(key, { id: userId, at: Date.now() });
  }
  return { config, rest, pool, tripCache, userId, authenticated: true };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    if (env.ACCESS_KEY) {
      const key = req.headers.get("x-api-key") ?? req.headers.get("x-access-key") ?? url.searchParams.get("key");
      if (key !== env.ACCESS_KEY) return rpcError(401, "Invalid or missing access key.");
    }

    const cookie = extractCookie(req, url);
    if (!cookie) {
      return rpcError(
        401,
        "Missing Authorization header. Set Bearer token to your Wanderlog connect.sid cookie value.",
      );
    }

    let ctx: AppContext;
    try {
      ctx = await buildContext(cookie, env);
    } catch (err) {
      const msg = err instanceof WanderlogError ? err.toUserMessage() : (err as Error).message;
      const status = loginFailureStatus(err);
      const label = status === 403 ? "Authentication failed" : "Wanderlog unavailable";
      return rpcError(status, `${label}: ${msg}`);
    }

    const server = buildServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(req);
    } catch (error) {
      console.error("[wanderdog] error handling request:", error);
      return rpcError(500, "Internal server error", -32603);
    } finally {
      ctx.pool.closeAll();
      void transport.close();
      void server.close();
    }
  },
};
