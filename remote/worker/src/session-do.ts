import type { SessionState, RemoteProgressEvent, Env } from "./types.js";
import { createPullRequest, getDefaultBranch } from "./github.js";
import { decryptToken } from "./auth.js";
import {
  createSession,
  updateSessionStatus,
  recordUsageEvent,
  upsertDailyUsage,
  estimateSessionCost,
} from "./telemetry.js";

const MAX_EVENTS = 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const IDLE_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const SLEEP_DESTROY_MS = 60 * 60 * 1000; // 1 hour after sleep

export class SessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessionState: SessionState | null = null;
  private clients: Set<ReadableStreamDefaultController<string>> = new Set();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;
  private sandboxActiveStart: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Restore state from storage if available
    if (!this.sessionState) {
      const stored = await this.state.storage.get<SessionState>("state");
      if (stored) this.sessionState = stored;
    }

    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(request);
    }
    if (path.endsWith("/stream") && request.method === "GET") {
      return this.handleStream();
    }
    if (path.endsWith("/terminal") && request.method === "GET") {
      return this.handleTerminal(request);
    }
    if (path.endsWith("/cancel") && request.method === "POST") {
      return this.handleCancel();
    }
    if (path.endsWith("/status") && request.method === "GET") {
      return this.handleStatus();
    }
    if (path.endsWith("/progress") && request.method === "POST") {
      return this.handleProgress(request);
    }
    if (path.endsWith("/finalize") && request.method === "POST") {
      return this.handleFinalize(request);
    }
    if (path.endsWith("/relay") && request.method === "POST") {
      return this.handleRelay(request);
    }
    if (path.endsWith("/message") && request.method === "POST") {
      return this.handleMessage(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as {
      prompt: string;
      repo: { owner: string; name: string };
      githubToken: string;
      userId: string;
      model?: string;
      maxTurns?: number;
      reasoningEffort?: string;
      ttlMinutes?: number;
      sandboxInstanceType?: string;
    };

    const ttlMinutes = body.ttlMinutes ?? 30;
    const sessionId = this.state.id.toString();
    const branch = `kimiflare/commute/${sessionId}`;
    const instanceType = body.sandboxInstanceType ?? "standard-1";

    // Create session record in D1
    await createSession(this.env.DB, {
      id: sessionId,
      userId: body.userId,
      repoOwner: body.repo.owner,
      repoName: body.repo.name,
      branch,
      sandboxInstanceType: instanceType,
    });

    // Import GitHub repo into Artifacts (or fork from baseline)
    const baselineName = `baseline-${body.userId}-${body.repo.owner}-${body.repo.name}`;
    let artifactsRepo;

    try {
      // Try to fork from existing baseline
      const baseline = await this.env.ARTIFACTS.get(baselineName);
      artifactsRepo = await baseline.fork(`session-${sessionId}`, {
        description: `Commute session for ${body.repo.owner}/${body.repo.name}`,
        readOnly: false,
      });
    } catch {
      // Baseline doesn't exist — import from GitHub
      artifactsRepo = await this.env.ARTIFACTS.import({
        source: {
          url: `https://github.com/${body.repo.owner}/${body.repo.name}.git`,
          branch: "main",
        },
        target: {
          name: `session-${sessionId}`,
        },
      });

      // Also create baseline for future sessions (fire and forget)
      this.createBaseline(body.repo, body.githubToken, baselineName).catch(() => {
        // ignore baseline creation failures
      });
    }

    // Create write token for Artifacts
    const repoHandle = await this.env.ARTIFACTS.get(artifactsRepo.name);
    const tokenResult = await repoHandle.createToken("write", 4 * 60 * 60); // 4h TTL

    // Get Sandbox
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(this.env.SANDBOX, sessionId, {
      keepAlive: true,
    });

    // Write git config and setup remotes
    const githubRemote = `https://x:${body.githubToken}@github.com/${body.repo.owner}/${body.repo.name}.git`;
    const artifactsRemote = artifactsRepo.remote.replace(
      "https://",
      `https://x:${tokenResult.plaintext}@`
    );

    await sandbox.writeFile(
      "/workspace/.gitconfig",
      `[user]
  name = KimiFlare
  email = kimiflare@proton.me
`
    );

    // Clone from Artifacts and add GitHub remote
    await sandbox.exec("git", ["clone", artifactsRemote, "/workspace/repo"], {
      timeout: 120_000,
    });

    await sandbox.exec("git", ["remote", "add", "github", githubRemote], {
      cwd: "/workspace/repo",
    });

    await sandbox.exec("git", ["checkout", "-b", branch], {
      cwd: "/workspace/repo",
    });

    this.sessionState = {
      sessionId,
      userId: body.userId,
      status: "idle",
      prompt: body.prompt,
      repo: body.repo,
      branch,
      artifactsRepo: {
        name: artifactsRepo.name,
        url: artifactsRepo.remote,
        writeToken: tokenResult.plaintext,
      },
      sandboxId: sessionId,
      githubToken: body.githubToken,
      progressEvents: [],
      maxTurns: body.maxTurns ?? 50,
      currentTurn: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      ttlMinutes,
      sandboxInstanceType: instanceType,
      sandboxActiveSeconds: 0,
    };

    await this.saveState();

    // Set alarm for max session duration
    const alarmMs = Math.min(ttlMinutes * 60 * 1000, MAX_SESSION_DURATION_MS);
    await this.state.storage.setAlarm(Date.now() + alarmMs);

    // Start heartbeat
    this.startHeartbeat();

    return Response.json({
      sessionId,
      streamUrl: `/api/sessions/${sessionId}/stream`,
      terminalUrl: `/api/sessions/${sessionId}/terminal`,
      status: "idle",
    });
  }

  private async createBaseline(
    repo: { owner: string; name: string },
    githubToken: string,
    baselineName: string
  ): Promise<void> {
    await this.env.ARTIFACTS.import({
      source: {
        url: `https://x:${githubToken}@github.com/${repo.owner}/${repo.name}.git`,
        branch: "main",
      },
      target: {
        name: baselineName,
      },
    });
  }

  private async handleTerminal(request: Request): Promise<Response> {
    if (!this.sessionState) {
      return new Response("Session not found", { status: 404 });
    }

    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(this.env.SANDBOX, this.sessionState.sandboxId!);

    // Ensure keepAlive is true while user is connected
    await sandbox.setKeepAlive(true);
    this.clearIdleTimeout();

    // Track active time
    this.sandboxActiveStart = Date.now();

    // Proxy terminal WebSocket
    return sandbox.terminal(request, { cols: 80, rows: 24 });
  }

  private async handleMessage(request: Request): Promise<Response> {
    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const body = await request.json() as { message: string };

    // For now, messages are sent through the terminal
    // In the future, we could support headless mode with structured responses
    this.sessionState.status = "running";
    this.sessionState.updatedAt = Date.now();
    await this.saveState();

    await updateSessionStatus(this.env.DB, this.sessionState.sessionId, "running");

    return Response.json({ ok: true });
  }

  private handleStream(): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<string>({
      start: (controller) => {
        this.clients.add(controller);
        // Send existing events
        if (this.sessionState) {
          for (const ev of this.sessionState.progressEvents) {
            controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`);
          }
        }
      },
      cancel: () => {
        for (const client of this.clients) {
          try {
            client.close();
          } catch {
            // ignore
          }
        }
        this.clients.clear();
      },
    });

    return new Response(stream as unknown as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async handleCancel(): Promise<Response> {
    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    await this.endSession("cancelled", "User cancelled");
    return Response.json({ status: "cancelled" });
  }

  private handleStatus(): Response {
    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Don't expose sensitive tokens
    const { githubToken, artifactsRepo, ...safe } = this.sessionState;
    return Response.json({
      ...safe,
      artifactsRepo: artifactsRepo ? { name: artifactsRepo.name, url: artifactsRepo.url } : undefined,
    });
  }

  private async handleProgress(request: Request): Promise<Response> {
    const body = await request.json() as { events: RemoteProgressEvent[] };

    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    for (const ev of body.events) {
      this.sessionState.progressEvents.push(ev);
      if (this.sessionState.progressEvents.length > MAX_EVENTS) {
        this.sessionState.progressEvents.shift();
      }
      this.broadcast(ev);

      if (ev.type === "turn_start" && typeof ev.turn === "number") {
        this.sessionState.currentTurn = ev.turn;
      }

      if (ev.type === "usage" && typeof ev.promptTokens === "number") {
        const promptTokens = ev.promptTokens;
        const completionTokens = typeof ev.completionTokens === "number" ? ev.completionTokens : 0;
        this.sessionState.tokensUsed = (this.sessionState.tokensUsed ?? 0) + promptTokens + completionTokens;

        // Record in D1
        await recordUsageEvent(this.env.DB, {
          sessionId: this.sessionState.sessionId,
          turnNumber: this.sessionState.currentTurn,
          eventType: "llm_call",
          model: this.sessionState.model ?? "@cf/moonshotai/kimi-k2.6",
          tokensIn: promptTokens,
          tokensOut: completionTokens,
        });
      }
    }

    this.sessionState.updatedAt = Date.now();
    await this.saveState();

    return Response.json({ ok: true });
  }

  private async handleFinalize(request: Request): Promise<Response> {
    const body = await request.json() as { summary: string; commitCount: number };

    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Decrypt GitHub token
    let githubToken: string;
    try {
      githubToken = await decryptToken(this.sessionState.githubToken!, this.env.ENCRYPTION_KEY);
    } catch {
      githubToken = this.sessionState.githubToken!;
    }

    this.sessionState.status = "done";
    this.sessionState.finishedAt = Date.now();

    // Calculate active seconds
    if (this.sandboxActiveStart) {
      this.sessionState.sandboxActiveSeconds = (this.sessionState.sandboxActiveSeconds ?? 0) + Math.floor((Date.now() - this.sandboxActiveStart) / 1000);
    }

    // Create PR
    try {
      const defaultBranch = await getDefaultBranch(githubToken, this.sessionState.repo);

      const pr = await createPullRequest(
        githubToken,
        this.sessionState.repo,
        this.sessionState.branch,
        `feat: ${this.sessionState.prompt.slice(0, 60)}`,
        buildPrBody(this.sessionState, body.summary, body.commitCount),
      );

      this.sessionState.prUrl = pr.html_url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sessionState.errorMessage = message;
      this.sessionState.status = "error";
      this.sessionState.errorCategory = "github-api";
    }

    await this.saveState();

    // Update D1
    const cost = estimateSessionCost(
      this.sessionState.sandboxActiveSeconds ?? 0,
      this.sessionState.tokensUsed ?? 0,
      0,
      this.sessionState.sandboxInstanceType
    );

    await updateSessionStatus(this.env.DB, this.sessionState.sessionId, this.sessionState.status, {
      ended_at: this.sessionState.finishedAt,
      sandbox_active_seconds: this.sessionState.sandboxActiveSeconds,
      ai_input_tokens: this.sessionState.tokensUsed,
      pr_url: this.sessionState.prUrl ?? null,
      error_message: this.sessionState.errorMessage ?? null,
      error_category: this.sessionState.errorCategory ?? null,
      cost_estimate_usd: cost,
    });

    await upsertDailyUsage(
      this.env.DB,
      this.sessionState.userId,
      new Date().toISOString().split("T")[0],
      this.sessionState.sandboxActiveSeconds ?? 0,
      this.sessionState.tokensUsed ?? 0,
      0,
      cost
    );

    this.broadcast({
      type: "done",
      prUrl: this.sessionState.prUrl,
      tokensUsed: this.sessionState.tokensUsed,
    });

    // Schedule cleanup alarm (24h for artifacts, then destroy)
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);

    return Response.json({
      status: this.sessionState.status,
      prUrl: this.sessionState.prUrl,
    });
  }

  private async handleRelay(request: Request): Promise<Response> {
    const body = await request.json() as {
      model: string;
      messages: unknown[];
      tools?: unknown[];
      temperature?: number;
      maxCompletionTokens?: number;
      reasoningEffort?: string;
    };

    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Use Workers AI binding or API token
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.ACCOUNT_ID}/ai/run/${body.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: body.messages,
          tools: body.tools,
          temperature: body.temperature,
          max_tokens: body.maxCompletionTokens,
          reasoning_effort: body.reasoningEffort,
        }),
      },
    );

    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      },
    });
  }

  private async endSession(status: "done" | "error" | "cancelled", errorMessage?: string): Promise<void> {
    if (!this.sessionState) return;

    // Calculate active seconds
    if (this.sandboxActiveStart) {
      this.sessionState.sandboxActiveSeconds = (this.sessionState.sandboxActiveSeconds ?? 0) + Math.floor((Date.now() - this.sandboxActiveStart) / 1000);
    }

    this.sessionState.status = status;
    this.sessionState.finishedAt = Date.now();
    if (errorMessage) {
      this.sessionState.errorMessage = errorMessage;
    }

    await this.saveState();

    // Destroy sandbox
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(this.env.SANDBOX, this.sessionState.sandboxId!);
      await sandbox.destroy();
    } catch {
      // ignore
    }

    // Update D1
    const cost = estimateSessionCost(
      this.sessionState.sandboxActiveSeconds ?? 0,
      this.sessionState.tokensUsed ?? 0,
      0,
      this.sessionState.sandboxInstanceType
    );

    await updateSessionStatus(this.env.DB, this.sessionState.sessionId, status, {
      ended_at: this.sessionState.finishedAt,
      sandbox_active_seconds: this.sessionState.sandboxActiveSeconds,
      error_message: this.sessionState.errorMessage ?? null,
      error_category: this.sessionState.errorCategory ?? null,
      cost_estimate_usd: cost,
    });

    this.broadcast({ type: status, message: errorMessage });

    // Schedule cleanup
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  private broadcast(event: RemoteProgressEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.enqueue(data);
      } catch {
        // Client disconnected
      }
    }
  }

  private async saveState(): Promise<void> {
    if (this.sessionState) {
      await this.state.storage.put("state", this.sessionState);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: "heartbeat" });
    }, 30000);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  private setIdleTimeout(): void {
    this.clearIdleTimeout();
    this.idleTimeout = setTimeout(() => {
      this.handleIdle();
    }, IDLE_GRACE_MS);
  }

  private async handleIdle(): Promise<void> {
    if (!this.sessionState || this.sessionState.status === "running") return;

    // Allow sandbox to sleep
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(this.env.SANDBOX, this.sessionState.sandboxId!);
      await sandbox.setKeepAlive(false);
    } catch {
      // ignore
    }

    // Schedule destroy after sleep
    await this.state.storage.setAlarm(Date.now() + SLEEP_DESTROY_MS);
  }

  async alarm(): Promise<void> {
    if (!this.sessionState) return;

    // If session is still running, it's a timeout
    if (this.sessionState.status === "running") {
      await this.endSession("error", `Session timed out after ${this.sessionState.ttlMinutes} minutes`);
      return;
    }

    // If session is idle, destroy sandbox
    if (this.sessionState.status === "idle" || this.sessionState.status === "paused") {
      try {
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox = getSandbox(this.env.SANDBOX, this.sessionState.sandboxId!);
        await sandbox.destroy();
      } catch {
        // ignore
      }
    }

    // Clean up artifacts repo after TTL
    if (this.sessionState.artifactsRepo) {
      try {
        await this.env.ARTIFACTS.delete(this.sessionState.artifactsRepo.name);
      } catch {
        // ignore
      }
    }

    // Clean up storage
    await this.state.storage.deleteAll();
  }
}

function buildPrBody(
  state: SessionState,
  summary: string,
  commitCount: number,
): string {
  return `## 🚆 KimiFlare Commute Session

**Session ID:** \`${state.sessionId}\`
**Prompt:**
> ${state.prompt}

**Summary:**
${summary}

**Commits:** ${commitCount}
**Turns:** ${state.currentTurn} / ${state.maxTurns}
**Status:** ${state.status === "done" ? "✅ Completed" : "⚠️ Incomplete"}

---
*This PR was generated by [kimiflare](https://github.com/sinameraji/kimiflare) in commute mode.*
`;
}
