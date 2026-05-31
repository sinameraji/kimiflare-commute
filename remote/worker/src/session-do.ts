import type { SessionState, SetupProgress, Env } from "./types.js";
import { getSandbox } from "@cloudflare/sandbox";

function log(label: string, data?: unknown) {
  console.log(`[SessionDO] ${label}:`, JSON.stringify(data, null, 2));
}

export class SessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // ── CRITICAL: log every binding we receive ────────────────────────
    const envKeys = Object.keys(env as unknown as Record<string, unknown>);
    log("CONSTRUCTOR — env keys", envKeys);
    log("CONSTRUCTOR — ARTIFACTS type", typeof (env as unknown as Record<string, unknown>).ARTIFACTS);
    log("CONSTRUCTOR — ARTIFACTS value", (env as unknown as Record<string, unknown>).ARTIFACTS);
    log("CONSTRUCTOR — SANDBOX type", typeof (env as unknown as Record<string, unknown>).SANDBOX);
    log("CONSTRUCTOR — OAUTH_KV type", typeof (env as unknown as Record<string, unknown>).OAUTH_KV);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    log("fetch", { path, method: request.method });

    if (path.endsWith("/setup") && request.method === "POST") {
      return this.handleSetup(request);
    }

    if (path.endsWith("/progress") && request.method === "GET") {
      return this.handleProgress();
    }

    if (path.endsWith("/verify") && request.method === "GET") {
      return this.handleVerify();
    }

    if (path.endsWith("/disconnect") && request.method === "POST") {
      return this.handleDisconnect();
    }

    return new Response("Not found", { status: 404 });
  }

  private async updateProgress(progress: SetupProgress): Promise<void> {
    await this.state.storage.put("progress", progress);
  }

  private async handleSetup(request: Request): Promise<Response> {
    const body = await request.json() as {
      owner: string;
      name: string;
      githubToken: string;
      userId: string;
      sessionId: string;
      accountId: string;
      apiToken: string;
      force?: boolean;
    };

    const { owner, name, githubToken, userId, sessionId, accountId, apiToken, force } = body;
    const githubUrl = `https://github.com/${owner}/${name}.git`;

    log("handleSetup — start", { owner, name, userId, sessionId, force: !!force });

    const STEPS = [
      "import",
      "token",
      "sandbox",
      "clone",
      "verify",
      "install",
      "config",
      "finalize",
    ];
    const STEP_LABELS: Record<string, string> = {
      import: "Importing repository into Artifacts",
      token: "Creating write token",
      sandbox: "Starting Cloudflare Sandbox",
      clone: "Cloning repository into sandbox",
      verify: "Verifying repository",
      install: "Installing KimiFlare",
      config: "Configuring Cloudflare credentials",
      finalize: "Finalizing session",
    };

    const logs: string[] = [];

    const setProgress = (step: string, status: SetupProgress["status"], message?: string, error?: string) => {
      const stepIndex = STEPS.indexOf(step);
      const completedSteps = STEPS.slice(0, stepIndex).filter((s) => s !== step || status === "complete");
      if (status === "complete" && !completedSteps.includes(step)) {
        completedSteps.push(step);
      }
      const progress: SetupProgress = {
        step,
        stepIndex: stepIndex + 1,
        totalSteps: STEPS.length,
        status,
        message: message ?? STEP_LABELS[step] ?? step,
        completedSteps,
        error,
        sessionId,
        logs: [...logs],
      };
      return this.updateProgress(progress);
    };

    const appendLog = (msg: string) => {
      logs.push(msg);
      log("sub-log", msg);
    };

    // ── Fast path: check for existing session ─────────────────────────
    if (!force) {
      const existing = await this.state.storage.get<SessionState>("state");
      if (existing) {
        log("handleSetup — existing state found", { sessionId: existing.sessionId });
        try {
          const sandbox = await getSandbox(this.env.SANDBOX as any, sessionId);
          const verifyRes = await sandbox.exec("test -d /workspace/repo && echo ok || echo missing");
          if (verifyRes.stdout?.trim() === "ok") {
            appendLog("Resuming existing session — repo verified");
            log("handleSetup — repo verified, resuming");
            await setProgress("finalize", "complete", "Session resumed");
            return Response.json({ success: true, resumed: true, sessionId });
          }
          log("handleSetup — repo missing, clearing old state");
          await this.state.storage.delete("state");
        } catch (err) {
          log("handleSetup — verify failed, falling back to full setup", err instanceof Error ? err.message : String(err));
          await this.state.storage.delete("state");
        }
      }
    } else {
      log("handleSetup — force=true, skipping fast path");
      appendLog("Force reset requested — cleaning up...");
      await this.state.storage.delete("state");
      await this.state.storage.delete("progress");
      try {
        const sandbox = await getSandbox(this.env.SANDBOX as any, sessionId);
        await sandbox.exec("rm -rf /workspace/repo");
        appendLog("Old workspace removed");
      } catch (err) {
        log("handleSetup — force cleanup warning", err instanceof Error ? err.message : String(err));
      }
    }

    const useArtifacts = !!this.env.ARTIFACTS;
    let artifact: { name: string; remote: string } | undefined;
    let artifactToken: string | undefined;

    try {
      // ── Step 0: Verify ARTIFACTS binding (optional) ─────────────────
      await setProgress("import", "running", "Checking Artifacts binding...");
      appendLog(`Repository: ${owner}/${name}`);
      appendLog(`Artifacts binding: ${useArtifacts ? "available" : "not available"}`);
      log("Step 0 — ARTIFACTS binding check", {
        exists: useArtifacts,
        type: typeof this.env.ARTIFACTS,
        keys: this.env.ARTIFACTS ? Object.keys(this.env.ARTIFACTS as unknown as Record<string, unknown>) : null,
      });

      if (!useArtifacts) {
        log("Step 0 — WARN", "ARTIFACTS binding is undefined; falling back to direct GitHub clone");
        appendLog("Falling back to direct GitHub clone");
      }

      // ── Step 1: Import repo into Artifacts (fast path) ──────────────
      if (useArtifacts) {
        await setProgress("import", "running", STEP_LABELS.import);
        appendLog(`Importing ${githubUrl} (branch: main)`);
        log("Step 1 — ARTIFACTS.import", { source: githubUrl, branch: "main", target: sessionId });
        try {
          artifact = await this.env.ARTIFACTS!.import({
            source: { url: githubUrl, branch: "main" },
            target: { name: sessionId },
          });
          appendLog(`Artifact created: ${artifact.name}`);
          log("Step 1 — OK", artifact);
          await setProgress("import", "complete");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("Step 1 — artifact import failed, attempting refresh", { name: sessionId, msg });
          appendLog(`Artifact import issue: ${msg}`);
          appendLog("Attempting to refresh artifact...");
          try {
            await this.env.ARTIFACTS!.delete(sessionId);
            artifact = await this.env.ARTIFACTS!.import({
              source: { url: githubUrl, branch: "main" },
              target: { name: sessionId },
            });
            appendLog(`Artifact refreshed: ${artifact.name}`);
            log("Step 1 — OK (refreshed)", artifact);
            await setProgress("import", "complete");
          } catch (refreshErr) {
            const refreshMsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            log("Step 1 — refresh failed, falling back to direct clone", refreshMsg);
            appendLog(`Artifact refresh failed: ${refreshMsg}`);
            appendLog("Falling back to direct GitHub clone");
            await setProgress("import", "complete", "Artifact unavailable — using direct clone");
          }
        }

        // ── Step 2: Create a write token for the artifact ─────────────
        if (artifact) {
          await setProgress("token", "running", STEP_LABELS.token);
          appendLog("Creating read-write token for artifact...");
          log("Step 2 — ARTIFACTS.get().createToken", { name: sessionId });
          try {
            const tokenRes = await this.env.ARTIFACTS!.get(sessionId).createToken("read-write", 3600);
            artifactToken = tokenRes.plaintext;
            appendLog("Write token created");
            log("Step 2 — OK", { tokenLength: artifactToken?.length });
            await setProgress("token", "complete");
          } catch (err) {
            log("Step 2 — FAIL", err instanceof Error ? err.message : String(err));
            await setProgress("token", "error", STEP_LABELS.token, err instanceof Error ? err.message : String(err));
            throw err;
          }
        } else {
          await setProgress("token", "complete", "Skipped — using direct GitHub clone");
        }
      } else {
        // Fallback: skip Artifacts steps, clone directly from GitHub later
        await setProgress("import", "complete", "Artifacts not available — using direct GitHub clone");
        await setProgress("token", "complete", "Skipped (no Artifacts binding)");
      }

      // ── Step 3: Get a sandbox instance ──────────────────────────────
      await setProgress("sandbox", "running", STEP_LABELS.sandbox);
      appendLog("Requesting Cloudflare Sandbox instance...");
      log("Step 3 — getSandbox", { sessionId });
      let sandbox: Awaited<ReturnType<typeof getSandbox>>;
      try {
        sandbox = await getSandbox(this.env.SANDBOX as any, sessionId);
        const sandboxId = (sandbox as any).id ?? "unknown";
        appendLog(`Sandbox ready (id: ${sandboxId})`);
        log("Step 3 — OK", { sandboxId });
        await setProgress("sandbox", "complete");
      } catch (err) {
        log("Step 3 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("sandbox", "error", STEP_LABELS.sandbox, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 4: Clone the repo into the sandbox ─────────────────────
      await setProgress("clone", "running", STEP_LABELS.clone);
      appendLog("Cloning repository into /workspace/repo...");
      let cloneUrl: string;
      if (artifact && artifactToken) {
        const encodedToken = encodeURIComponent(artifactToken);
        cloneUrl = artifact.remote.replace("https://", `https://token:${encodedToken}@`);
        appendLog("Using Artifacts remote for clone");
        log("Step 4 — git clone (Artifacts)", { url: cloneUrl.replace(encodedToken, "***REDACTED***") });
      } else {
        // Fallback: clone directly from GitHub using the user's token
        const encodedToken = encodeURIComponent(githubToken);
        cloneUrl = githubUrl.replace("https://", `https://${encodedToken}@`);
        appendLog("Using GitHub direct clone (fallback)");
        log("Step 4 — git clone (GitHub fallback)", { url: cloneUrl.replace(encodedToken, "***REDACTED***") });
      }
      let cloneRes: Awaited<ReturnType<typeof sandbox.exec>>;
      try {
        cloneRes = await sandbox.exec(`git clone ${cloneUrl} /workspace/repo`);
        appendLog(`Clone finished (exit code: ${cloneRes.exitCode})`);
        log("Step 4 — result", { success: cloneRes.success, exitCode: cloneRes.exitCode, stderr: cloneRes.stderr });
        if (!cloneRes.success) {
          throw new Error(`git clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
        }
        // Ensure git remote points to GitHub so pull/push always use live source
        const encodedToken = encodeURIComponent(githubToken);
        const githubRemote = githubUrl.replace("https://", `https://${encodedToken}@`);
        const originRes = await sandbox.exec(
          `cd /workspace/repo && git remote set-url origin ${githubRemote}`
        );
        if (originRes.success) {
          appendLog("Git remote set to GitHub origin");
        } else {
          appendLog("Warning: could not update git remote");
        }
        await setProgress("clone", "complete");
      } catch (err) {
        log("Step 4 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("clone", "error", STEP_LABELS.clone, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 5: Run git log to prove it worked ──────────────────────
      await setProgress("verify", "running", STEP_LABELS.verify);
      appendLog("Verifying repository contents...");
      log("Step 5 — git log");
      let logRes: Awaited<ReturnType<typeof sandbox.exec>>;
      try {
        logRes = await sandbox.exec("cd /workspace/repo && git log --oneline -5");
        const lines = logRes.stdout?.trim().split("\n").length ?? 0;
        appendLog(`Verified ${lines} commits`);
        log("Step 5 — result", { success: logRes.success, exitCode: logRes.exitCode, stdout: logRes.stdout });
        if (!logRes.success) {
          throw new Error(`git log failed: ${logRes.stderr || logRes.stdout}`);
        }
        await setProgress("verify", "complete");
      } catch (err) {
        log("Step 5 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("verify", "error", STEP_LABELS.verify, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 6: Install KimiFlare globally ──────────────────────────
      await setProgress("install", "running", STEP_LABELS.install);
      appendLog("Running npm install -g kimiflare...");
      log("Step 6 — npm install -g kimiflare");
      try {
        const installRes = await sandbox.exec("npm install -g kimiflare");
        appendLog(installRes.success ? "KimiFlare installed successfully" : `Install warning (exit ${installRes.exitCode})`);
        log("Step 6 — result", { success: installRes.success, exitCode: installRes.exitCode });
        if (!installRes.success) {
          log("Step 6 — WARN", installRes.stderr || installRes.stdout);
        }
        await setProgress("install", "complete");
      } catch (err) {
        log("Step 6 — WARN", err instanceof Error ? err.message : String(err));
        appendLog("Install skipped (non-fatal)");
        await setProgress("install", "complete"); // non-fatal
      }

      // ── Step 7: Write KimiFlare config with Cloudflare credentials ──
      await setProgress("config", "running", STEP_LABELS.config);
      appendLog("Writing Cloudflare credentials to ~/.config/kimiflare/config.json...");
      log("Step 7 — write KimiFlare config");
      try {
        await sandbox.exec("mkdir -p /root/.config/kimiflare");
        const config = JSON.stringify({
          accountId,
          apiToken,
          model: "@cf/moonshotai/kimi-k2.6",
        }, null, 2);
        const writeRes = await sandbox.exec(
          `cat > /root/.config/kimiflare/config.json << 'KIMIEOF'\n${config}\nKIMIEOF`
        );
        appendLog("Credentials configured");
        log("Step 7 — result", { success: writeRes.success });
        await setProgress("config", "complete");
      } catch (err) {
        log("Step 7 — WARN", err instanceof Error ? err.message : String(err));
        appendLog("Config write skipped (non-fatal)");
        await setProgress("config", "complete"); // non-fatal
      }

      // ── Step 8: Store minimal session state ─────────────────────────
      await setProgress("finalize", "running", STEP_LABELS.finalize);
      appendLog("Saving session state...");
      const sessionState: SessionState = {
        sessionId,
        userId,
        repo: { owner, name },
        githubToken,
        createdAt: Date.now(),
      };
      if (artifact && artifactToken) {
        sessionState.artifactsRepo = {
          name: sessionId,
          url: artifact.remote,
          writeToken: artifactToken,
        };
      }
      await this.state.storage.put("state", sessionState);
      appendLog("Session ready — opening terminal...");
      log("Step 8 — state stored", { sessionId, userId, hasArtifacts: !!sessionState.artifactsRepo });
      await setProgress("finalize", "complete", "Ready!");

      log("handleSetup — SUCCESS", { sessionId, outputLines: logRes.stdout?.split("\n").length });
      return Response.json({ success: true, output: logRes.stdout, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("handleSetup — UNCAUGHT ERROR", message);
      return Response.json({ success: false, error: message }, { status: 500 });
    }
  }

  private async handleProgress(): Promise<Response> {
    log("handleProgress — checking progress");
    const progress = await this.state.storage.get<SetupProgress>("progress");
    if (!progress) {
      log("handleProgress — NOT FOUND");
      return new Response("Not found", { status: 404 });
    }
    log("handleProgress — OK", { step: progress.step, status: progress.status });
    return Response.json(progress);
  }

  private async handleVerify(): Promise<Response> {
    log("handleVerify — checking state");
    const state = await this.state.storage.get<SessionState>("state");
    if (!state) {
      log("handleVerify — NOT FOUND");
      return new Response("Not found", { status: 404 });
    }
    log("handleVerify — OK", { userId: state.userId, sessionId: state.sessionId });
    return Response.json({ userId: state.userId, sessionId: state.sessionId });
  }

  private async handleDisconnect(): Promise<Response> {
    log("handleDisconnect — start");
    const state = await this.state.storage.get<SessionState>("state");

    if (state?.artifactsRepo && this.env.ARTIFACTS) {
      try {
        await this.env.ARTIFACTS.delete(state.artifactsRepo.name);
        log("handleDisconnect — artifact deleted", { name: state.artifactsRepo.name });
      } catch (err) {
        log("handleDisconnect — artifact delete warning", err instanceof Error ? err.message : String(err));
      }
    }

    await this.state.storage.delete("state");
    await this.state.storage.delete("progress");
    log("handleDisconnect — DO storage cleared");

    if (state) {
      try {
        const sandbox = await getSandbox(this.env.SANDBOX as any, state.sessionId);
        await sandbox.exec("rm -rf /workspace/repo /root/.config/kimiflare");
        log("handleDisconnect — sandbox cleaned");
      } catch (err) {
        log("handleDisconnect — sandbox cleanup warning", err instanceof Error ? err.message : String(err));
      }
    }

    return Response.json({ success: true });
  }
}
