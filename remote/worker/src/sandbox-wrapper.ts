import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./types.js";

/**
 * Subclass of Sandbox that intercepts /ws/pty requests in its fetch()
 * handler so the WebSocket upgrade to the container happens *inside*
 * the Durable Object (required by the Cloudflare Containers runtime).
 */
export class KimiSandbox extends Sandbox<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws/pty") {
      const cols = Number(url.searchParams.get("cols") || "120");
      const rows = Number(url.searchParams.get("rows") || "30");
      const shell = url.searchParams.get("shell") || undefined;
      return this.terminal(request, { cols, rows, shell });
    }

    return super.fetch(request);
  }
}
