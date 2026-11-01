/**
 * Minimal drop-in for the `ws` package on Cloudflare Workers.
 *
 * Workers can't use `ws` (it needs node:net/tls), but they can open outbound
 * WebSockets via fetch() with an `Upgrade: websocket` header — and, unlike the
 * browser WebSocket API, that path lets us send Cookie/Origin headers, which
 * Wanderlog's ShareDB endpoint requires.
 *
 * Only the surface ShareDBClient uses is implemented: constructor(url, {headers}),
 * on/removeAllListeners (EventEmitter), send, terminate, readyState, OPEN, and the
 * "message" | "close" | "error" | "unexpected-response" events.
 */
import { EventEmitter } from "node:events";

type Opts = { headers?: Record<string, string> };

export default class WebSocketShim extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = WebSocketShim.CONNECTING;
  private socket?: WebSocket;
  private terminated = false;

  constructor(url: string, opts: Opts = {}) {
    super();
    void this.open(url, opts);
  }

  private async open(url: string, opts: Opts): Promise<void> {
    try {
      const httpUrl = url.replace(/^ws(s?):\/\//, "http$1://");
      const resp = await fetch(httpUrl, {
        headers: { ...(opts.headers ?? {}), Upgrade: "websocket" },
      });
      const sock = (resp as Response & { webSocket?: WebSocket | null }).webSocket;
      if (!sock) {
        this.readyState = WebSocketShim.CLOSED;
        this.emit("unexpected-response", {}, { statusCode: resp.status });
        return;
      }
      (sock as WebSocket & { accept(): void }).accept();
      this.socket = sock;
      if (this.terminated) {
        sock.close(1000, "terminated");
        this.readyState = WebSocketShim.CLOSED;
        return;
      }
      this.readyState = WebSocketShim.OPEN;

      sock.addEventListener("message", (ev: MessageEvent) => {
        const data =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        this.emit("message", data);
      });
      sock.addEventListener("close", (ev: CloseEvent) => {
        this.readyState = WebSocketShim.CLOSED;
        this.emit("close", ev.code);
      });
      sock.addEventListener("error", (ev: Event) => {
        const msg = (ev as ErrorEvent).message ?? "WebSocket error";
        this.emit("error", new Error(msg));
      });
      this.emit("open");
    } catch (err) {
      this.readyState = WebSocketShim.CLOSED;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  send(data: string): void {
    if (!this.socket || this.readyState !== WebSocketShim.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.socket.send(data);
  }

  close(code = 1000, reason?: string): void {
    this.terminate(code, reason);
  }

  terminate(code = 1000, reason = "terminated"): void {
    this.terminated = true;
    if (this.socket && this.readyState === WebSocketShim.OPEN) {
      this.readyState = WebSocketShim.CLOSING;
      try {
        this.socket.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }
}
