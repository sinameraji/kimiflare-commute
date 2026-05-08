import type { SessionState, RemoteProgressEvent, Env } from "./types.js";
import { createPullRequest, createIssue, getDefaultBranch } from "./github.js";
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
  private clients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set();
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

    const sessionId = this.state.id.toString();
    const sandboxId = sessionId.replace(/-/g, "").slice(0, 32);
    const branch = `kimiflare/commute/${sessionId}`;

    // Kick off background work and return immediately
    const backgroundWork = this.runStartWorkflow(body, sessionId, sandboxId, branch);
    this.state.waitUntil(backgroundWork);

    return Response.json({
      sessionId,
      streamUrl: `/api/sessions/${sessionId}/stream`,
      terminalUrl: `/api/sessions/${sessionId}/terminal`,
      status: "starting",
    });
  }

  private async runStartWorkflow(
    body: {
      prompt: string;
      repo: { owner: string; name: string };
      githubToken: string;
      userId: string;
      model?: string;
      maxTurns?: number;
      reasoningEffort?: string;
      ttlMinutes?: number;
      sandboxInstanceType?: string;
    },
    sessionId: string,
    sandboxId: string,
    branch: string
  ): Promise<void> {
    let artifactsRepo: { name: string; remote: string } | undefined;
    let sandbox: Awaited<ReturnType<typeof import("@cloudflare/sandbox").getSandbox>> | undefined;

    const step = (stepId: string, status: "pending" | "running" | "success" | "error", message: string, extra?: Record<string, unknown>) => {
      const ev: RemoteProgressEvent = { type: "step", step: stepId, status, message, ...extra };
      this.broadcast(ev);
      if (this.sessionState) {
        this.sessionState.progressEvents.push(ev);
        if (this.sessionState.progressEvents.length > MAX_EVENTS) {
          this.sessionState.progressEvents.shift();
        }
        this.saveState();
      }
    };

    try {
      const ttlMinutes = body.ttlMinutes ?? 30;
      const instanceType = body.sandboxInstanceType ?? "standard-1";

      step("d1_create", "running", "Creating session record in D1...");
      await createSession(this.env.DB, {
        id: sessionId,
        userId: body.userId,
        repoOwner: body.repo.owner,
        repoName: body.repo.name,
        branch,
        sandboxInstanceType: instanceType,
      });
      step("d1_create", "success", "Session record created");

      step("artifacts_import", "running", "Importing repository into Artifacts...");
      const baselineName = `baseline-${body.userId}-${body.repo.owner}-${body.repo.name}`;
      const importStart = Date.now();

      try {
        const baseline = await this.env.ARTIFACTS.get(baselineName);
        artifactsRepo = await baseline.fork(`session-${sessionId}`, {
          description: `Commute session for ${body.repo.owner}/${body.repo.name}`,
          readOnly: false,
        });
      } catch {
        artifactsRepo = await this.env.ARTIFACTS.import({
          source: {
            url: `https://github.com/${body.repo.owner}/${body.repo.name}.git`,
            branch: "main",
          },
          target: {
            name: `session-${sessionId}`,
          },
        });
        this.createBaseline(body.repo, body.githubToken, baselineName).catch(() => {});
      }
      if (!artifactsRepo) {
        throw new Error("Failed to import repository into Artifacts");
      }
      step("artifacts_import", "success", `Repository imported as "${artifactsRepo.name}"`, { durationMs: Date.now() - importStart });

      step("artifacts_token", "running", "Creating write token for Artifacts...");
      const repoHandle = await this.env.ARTIFACTS.get(artifactsRepo.name);
      const tokenResult = await repoHandle.createToken("write", 4 * 60 * 60);
      step("artifacts_token", "success", "Write token created (4h TTL)");

      step("sandbox_get", "running", "Getting Sandbox DO stub...");
      const { getSandbox } = await import("@cloudflare/sandbox");
      sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, sandboxId, { keepAlive: true });
      step("sandbox_get", "success", `Sandbox stub obtained (ID: ${sandboxId})`);

      step("sandbox_provision", "running", "Waiting for container to provision...");
      const provisionStart = Date.now();
      const provisioned = await this.waitForSandbox(sandbox, step);
      if (!provisioned) {
        throw new Error("Container failed to provision after maximum retries");
      }
      step("sandbox_provision", "success", "Container provisioned and ready", { durationMs: Date.now() - provisionStart });

      const githubRemote = `https://x:${body.githubToken}@github.com/${body.repo.owner}/${body.repo.name}.git`;
      const artifactsRemote = artifactsRepo.remote.replace(
        "https://",
        `https://x:${encodeURIComponent(tokenResult.plaintext)}@`
      );

      step("git_config", "running", "Writing git config...");
      await sandbox.writeFile(
        "/workspace/.gitconfig",
        `[user]\n  name = KimiFlare\n  email = kimiflare@proton.me\n`
      );
      step("git_config", "success", "Git config written");

      step("git_clone", "running", "Cloning repository from Artifacts...");
      await sandbox.exec("rm -rf /workspace");
      const cloneResult = await sandbox.exec(`git clone ${artifactsRemote} /workspace`, { timeout: 120_000 });
      if (cloneResult.exitCode !== 0) {
        throw new Error(`git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr || cloneResult.stdout || "unknown error"}`);
      }
      step("git_clone", "success", "Repository cloned to /workspace");

      step("git_remote", "running", "Adding GitHub remote...");
      const remoteResult = await sandbox.exec(`git remote add github ${githubRemote}`, { cwd: "/workspace" });
      if (remoteResult.exitCode !== 0) {
        await sandbox.exec(`git remote set-url github ${githubRemote}`, { cwd: "/workspace" });
      }
      step("git_remote", "success", "GitHub remote added");

      step("git_branch", "running", `Creating and checking out branch "${branch}"...`);
      const branchResult = await sandbox.exec(`git checkout -B ${branch}`, { cwd: "/workspace" });
      if (branchResult.exitCode !== 0) {
        throw new Error(`git checkout failed (exit ${branchResult.exitCode}): ${branchResult.stderr || branchResult.stdout || "unknown error"}`);
      }
      step("git_branch", "success", `Branch "${branch}" ready`);

      this.sessionState = {
        sessionId,
        userId: body.userId,
        status: "running",
        prompt: body.prompt,
        repo: body.repo,
        branch,
        artifactsRepo: {
          name: artifactsRepo.name,
          url: artifactsRepo.remote,
          writeToken: tokenResult.plaintext,
        },
        sandboxId,
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

      const alarmMs = Math.min(ttlMinutes * 60 * 1000, MAX_SESSION_DURATION_MS);
      await this.state.storage.setAlarm(Date.now() + alarmMs);
      this.startHeartbeat();

      // Start KimiFlare agent in the background
      const host = "commute.kimiflare.com"; // TODO: derive from request headers in production
      const agentEnv: Record<string, string> = {
        SESSION_ID: sessionId,
        ARTIFACTS_URL: artifactsRepo.remote,
        ARTIFACTS_TOKEN: tokenResult.plaintext,
        REPO_OWNER: body.repo.owner,
        REPO_NAME: body.repo.name,
        GITHUB_BRANCH: branch,
        PROMPT: body.prompt,
        MODEL: body.model ?? "@cf/moonshotai/kimi-k2.6",
        MAX_TURNS: String(body.maxTurns ?? 50),
        REASONING_EFFORT: body.reasoningEffort ?? "medium",
        ACCOUNT_ID: this.env.ACCOUNT_ID,
        API_TOKEN: this.env.CF_API_TOKEN,
        PROGRESS_URL: `https://${host}/api/sessions/${sessionId}/progress`,
        FINALIZE_URL: `https://${host}/api/sessions/${sessionId}/finalize`,
      };

      const agentWork = this.runAgent(sandbox, agentEnv, step);
      this.state.waitUntil(agentWork);

      step("session_ready", "success", "KimiFlare agent started — streaming progress", {
        streamUrl: `/api/sessions/${sessionId}/stream`,
        terminalUrl: `/api/sessions/${sessionId}/terminal`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[SessionDO] runStartWorkflow failed:", message);

      step("session_ready", "error", "Session failed to start", { detail: message });

      if (sandbox) {
        try { await sandbox.destroy(); } catch {}
      }
      if (artifactsRepo) {
        try { await this.env.ARTIFACTS.delete(artifactsRepo.name); } catch {}
      }
      await updateSessionStatus(this.env.DB, sessionId, "error", {
        ended_at: Date.now(),
        error_message: message,
        error_category: "agent-crash",
      });
    }
  }

  private async waitForSandbox(
    sandbox: Awaited<ReturnType<typeof import("@cloudflare/sandbox").getSandbox>>,
    step: (stepId: string, status: "pending" | "running" | "success" | "error", message: string, extra?: Record<string, unknown>) => void
  ): Promise<boolean> {
    const maxAttempts = 10;
    let delay = 3000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await sandbox.exec("echo ready", { timeout: 10_000 });
        if (result.exitCode === 0) {
          return true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        step("sandbox_provision", "running", `Container not ready (attempt ${attempt}/${maxAttempts})`, {
          attempt,
          maxAttempts,
          detail: msg,
        });
      }

      if (attempt < maxAttempts) {
        step("sandbox_provision", "running", `Waiting ${delay}ms before retry...`, { attempt, maxAttempts });
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }

    return false;
  }

  private async runAgent(
    sandbox: Awaited<ReturnType<typeof import("@cloudflare/sandbox").getSandbox>>,
    env: Record<string, string>,
    step: (stepId: string, status: "pending" | "running" | "success" | "error", message: string, extra?: Record<string, unknown>) => void
  ): Promise<void> {
    let buffer = "";

    try {
      step("agent_start", "running", "Starting KimiFlare agent...");
      await sandbox.exec("node /opt/kimiflare/remote-agent.mjs", {
        env,
        stream: true,
        onOutput: (stream, data) => {
          if (stream !== "stdout") return;
          buffer += data;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed) as RemoteProgressEvent;
              this.broadcast(event);
              if (this.sessionState) {
                this.sessionState.progressEvents.push(event);
                if (this.sessionState.progressEvents.length > MAX_EVENTS) {
                  this.sessionState.progressEvents.shift();
                }
                if (event.type === "turn_start" && typeof (event as Record<string, unknown>).turn === "number") {
                  this.sessionState.currentTurn = (event as Record<string, unknown>).turn as number;
                }
                if (event.type === "usage" && typeof (event as Record<string, unknown>).promptTokens === "number") {
                  const promptTokens = (event as Record<string, unknown>).promptTokens as number;
                  const completionTokens = (event as Record<string, unknown>).completionTokens as number;
                  this.sessionState.tokensUsed = (this.sessionState.tokensUsed ?? 0) + promptTokens + completionTokens;
                }
                this.saveState().catch(() => {});
              }
            } catch {
              // Not JSON — treat as raw log
              this.broadcast({ type: "log", text: trimmed });
              if (this.sessionState) {
                this.sessionState.sandboxLogs = this.sessionState.sandboxLogs ?? [];
                this.sessionState.sandboxLogs.push(trimmed);
                if (this.sessionState.sandboxLogs.length > 500) {
                  this.sessionState.sandboxLogs.shift();
                }
              }
            }
          }
        },
        onComplete: (result) => {
          if (result.exitCode === 0) {
            step("agent_start", "success", "Agent completed");
          } else {
            step("agent_start", "error", `Agent exited with code ${result.exitCode}`, {
              stderr: result.stderr,
            });
          }
        },
        onError: (error) => {
          step("agent_start", "error", `Agent error: ${error.message}`);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      step("agent_start", "error", `Failed to run agent: ${message}`);
    }
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
    const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);

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
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        // Send existing events
        if (this.sessionState) {
          for (const ev of this.sessionState.progressEvents) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
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

    return new Response(stream, {
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
    const body = await request.json() as RemoteProgressEvent | { events: RemoteProgressEvent[] };

    if (!this.sessionState) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const events = Array.isArray(body) ? body : "events" in body ? body.events : [body];

    for (const ev of events) {
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
    const body = await request.json() as { exitCode: number; hasChanges: boolean; errorLog?: string };

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

    this.stopHeartbeat();
    this.sessionState.finishedAt = Date.now();

    // Calculate active seconds
    if (this.sandboxActiveStart) {
      this.sessionState.sandboxActiveSeconds = (this.sessionState.sandboxActiveSeconds ?? 0) + Math.floor((Date.now() - this.sandboxActiveStart) / 1000);
    }

    const { repo, branch, prompt } = this.sessionState;

    try {
      if (body.exitCode === 0 && body.hasChanges) {
        // Push branch to GitHub first
        this.broadcast({ type: "step", step: "git_push", status: "running", message: "Pushing branch to GitHub..." });
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);
        const pushResult = await sandbox.exec(`git push github ${branch}`, { cwd: "/workspace", timeout: 60_000 });
        if (pushResult.exitCode !== 0) {
          throw new Error(`git push failed: ${pushResult.stderr || pushResult.stdout}`);
        }
        this.broadcast({ type: "step", step: "git_push", status: "success", message: "Branch pushed to GitHub" });

        // Create PR
        const defaultBranch = await getDefaultBranch(githubToken, repo);
        const pr = await createPullRequest(
          githubToken,
          repo,
          branch,
          `kimiflare remote: ${prompt.slice(0, 80)}`,
          buildPrBody(this.sessionState, body.errorLog),
        );
        this.sessionState.prUrl = pr.html_url;
        this.sessionState.status = "done";
      } else if (body.exitCode === 0 && !body.hasChanges) {
        // No changes — open issue with findings
        const issue = await createIssue(
          githubToken,
          repo,
          `kimiflare remote findings: ${prompt.slice(0, 80)}`,
          `No code changes were made.\n\nPrompt: ${prompt}`,
        );
        this.sessionState.prUrl = issue.html_url;
        this.sessionState.status = "done";
      } else if (body.exitCode === 42) {
        // Budget exhausted
        if (body.hasChanges) {
          const { getSandbox } = await import("@cloudflare/sandbox");
          const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);
          await sandbox.exec(`git push github ${branch}`, { cwd: "/workspace", timeout: 60_000 });
          const defaultBranch = await getDefaultBranch(githubToken, repo);
          const pr = await createPullRequest(
            githubToken,
            repo,
            branch,
            `kimiflare remote (budget exhausted): ${prompt.slice(0, 80)}`,
            `Automated changes from kimiflare remote session.\n\nPrompt: ${prompt}\n\nNote: Token budget was exhausted before completion.`,
          );
          this.sessionState.prUrl = pr.html_url;
        } else {
          const issue = await createIssue(
            githubToken,
            repo,
            `kimiflare remote (budget exhausted): ${prompt.slice(0, 80)}`,
            `No code changes were made. Token budget was exhausted.\n\nPrompt: ${prompt}`,
          );
          this.sessionState.prUrl = issue.html_url;
        }
        this.sessionState.status = "done";
      } else {
        // Agent error
        this.sessionState.status = "error";
        this.sessionState.errorMessage = body.errorLog || "Agent failed";
        this.sessionState.errorCategory = "agent-crash";
      }
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

    // Destroy sandbox immediately
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);
      await sandbox.destroy();
    } catch {
      // ignore
    }

    // Schedule cleanup alarm (24h for artifacts + storage deletion)
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
      const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);
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
    const encoder = new TextEncoder();
    const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
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

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
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
      const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId!);
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

    // Destroy sandbox if it still exists (safety net for all terminal states)
    if (this.sessionState.sandboxId) {
      try {
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox = getSandbox(this.env.SANDBOX as DurableObjectNamespace<undefined>, this.sessionState.sandboxId);
        await sandbox.destroy();
      } catch {
        // ignore — may already be destroyed
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
  errorLog?: string,
): string {
  return `## 🚆 KimiFlare Commute Session

**Session ID:** \`${state.sessionId}\`
**Prompt:**
> ${state.prompt}

**Turns:** ${state.currentTurn} / ${state.maxTurns}
**Status:** ${state.status === "done" ? "✅ Completed" : "⚠️ Incomplete"}
${errorLog ? `\n**Error log:**\n\`\`\`\n${errorLog}\n\`\`\`` : ""}

---
*This PR was generated by [kimiflare](https://github.com/sinameraji/kimiflare) in commute mode.*
`;
}
