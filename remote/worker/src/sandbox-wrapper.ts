import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { Env } from "./types.js";

/**
 * Subclass of Sandbox that intercepts /ws/pty requests in its fetch()
 * handler so the WebSocket upgrade to the container happens *inside*
 * the Durable Object (required by the Cloudflare Containers runtime).
 *
 * The terminal() method exists at runtime but is not declared in the
 * public type definitions, so we use @ts-ignore.
 */
export class Sandbox extends BaseSandbox<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws/pty") {
      const cols = Number(url.searchParams.get("cols") || "120");
      const rows = Number(url.searchParams.get("rows") || "30");
      const shell = url.searchParams.get("shell") || undefined;
      // @ts-ignore — terminal() exists at runtime but is not in the public types
      return this.terminal(request, { cols, rows, shell });
    }

    // @ts-ignore — fetch() exists on the parent Container class but TS can't resolve it
    return super.fetch(request);
  }
}
