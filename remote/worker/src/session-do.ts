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
    };

    const { owner, name, githubToken, userId, sessionId, accountId, apiToken } = body;
    const githubUrl = `https://github.com/${owner}/${name}.git`;

    log("handleSetup — start", { owner, name, userId, sessionId });

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
      install: "Installing KimiFleur",
      config: "Configuring Cloudflare credentials",
      finalize: "Finalizing session",
    };

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
      };
      return this.updateProgress(progress);
    };

    try {
      // ── Step 0: Verify ARTIFACTS binding exists ─────────────────────
      await setProgress("import", "running", "Checking Artifacts binding...");
      log("Step 0 — ARTIFACTS binding check", {
        exists: !!this.env.ARTIFACTS,
        type: typeof this.env.ARTIFACTS,
        keys: this.env.ARTIFACTS ? Object.keys(this.env.ARTIFACTS as unknown as Record<string, unknown>) : null,
      });

      if (!this.env.ARTIFACTS) {
        log("Step 0 — FAIL", "ARTIFACTS binding is undefined");
        await setProgress("import", "error", "Artifacts binding not available", "ARTIFACTS binding not available. Worker may need redeployment.");
        return Response.json(
          { success: false, error: "ARTIFACTS binding not available. Worker may need redeployment." },
          { status: 500 }
        );
      }

      // ── Step 1: Import repo into Artifacts ──────────────────────────
      await setProgress("import", "running", STEP_LABELS.import);
      log("Step 1 — ARTIFACTS.import", { source: githubUrl, branch: "main", target: sessionId });
      let artifact: { name: string; remote: string };
      try {
        artifact = await this.env.ARTIFACTS.import({
          source: { url: githubUrl, branch: "main" },
          target: { name: sessionId },
        });
        log("Step 1 — OK", artifact);
        await setProgress("import", "complete");
      } catch (err) {
        log("Step 1 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("import", "error", STEP_LABELS.import, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 2: Create a write token for the artifact ───────────────
      await setProgress("token", "running", STEP_LABELS.token);
      log("Step 2 — ARTIFACTS.get().createToken", { name: sessionId });
      let tokenRes: { plaintext: string };
      try {
        tokenRes = await this.env.ARTIFACTS.get(sessionId).createToken("read-write", 3600);
        log("Step 2 — OK", { tokenLength: tokenRes.plaintext?.length });
        await setProgress("token", "complete");
      } catch (err) {
        log("Step 2 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("token", "error", STEP_LABELS.token, err instanceof Error ? err.message : String(err));
        throw err;
      }
      const artifactToken = tokenRes.plaintext;

      // ── Step 3: Get a sandbox instance ──────────────────────────────
      await setProgress("sandbox", "running", STEP_LABELS.sandbox);
      log("Step 3 — getSandbox", { sessionId });
      let sandbox: Awaited<ReturnType<typeof getSandbox>>;
      try {
        sandbox = await getSandbox(this.env.SANDBOX as any, sessionId);
        log("Step 3 — OK", { sandboxId: (sandbox as any).id });
        await setProgress("sandbox", "complete");
      } catch (err) {
        log("Step 3 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("sandbox", "error", STEP_LABELS.sandbox, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 4: Clone the artifact repo into the sandbox ────────────
      await setProgress("clone", "running", STEP_LABELS.clone);
      const encodedToken = encodeURIComponent(artifactToken);
      const authArtifactUrl = artifact.remote.replace("https://", `https://token:${encodedToken}@`);
      log("Step 4 — git clone", { url: authArtifactUrl.replace(encodedToken, "***REDACTED***") });
      let cloneRes: Awaited<ReturnType<typeof sandbox.exec>>;
      try {
        cloneRes = await sandbox.exec(`git clone ${authArtifactUrl} /workspace/repo`);
        log("Step 4 — result", { success: cloneRes.success, exitCode: cloneRes.exitCode, stderr: cloneRes.stderr });
        if (!cloneRes.success) {
          throw new Error(`git clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
        }
        await setProgress("clone", "complete");
      } catch (err) {
        log("Step 4 — FAIL", err instanceof Error ? err.message : String(err));
        await setProgress("clone", "error", STEP_LABELS.clone, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // ── Step 5: Run git log to prove it worked ──────────────────────
      await setProgress("verify", "running", STEP_LABELS.verify);
      log("Step 5 — git log");
      let logRes: Awaited<ReturnType<typeof sandbox.exec>>;
      try {
        logRes = await sandbox.exec("cd /workspace/repo && git log --oneline -5");
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

      // ── Step 6: Install KimiFleur globally ──────────────────────────
      await setProgress("install", "running", STEP_LABELS.install);
      log("Step 6 — npm install -g kimiflare");
      try {
        const installRes = await sandbox.exec("npm install -g kimiflare");
        log("Step 6 — result", { success: installRes.success, exitCode: installRes.exitCode });
        if (!installRes.success) {
          log("Step 6 — WARN", installRes.stderr || installRes.stdout);
        }
        await setProgress("install", "complete");
      } catch (err) {
        log("Step 6 — WARN", err instanceof Error ? err.message : String(err));
        await setProgress("install", "complete"); // non-fatal
      }

      // ── Step 7: Write KimiFleur config with Cloudflare credentials ──
      await setProgress("config", "running", STEP_LABELS.config);
      log("Step 7 — write KimiFleur config");
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
        log("Step 7 — result", { success: writeRes.success });
        await setProgress("config", "complete");
      } catch (err) {
        log("Step 7 — WARN", err instanceof Error ? err.message : String(err));
        await setProgress("config", "complete"); // non-fatal
      }

      // ── Step 8: Store minimal session state ─────────────────────────
      await setProgress("finalize", "running", STEP_LABELS.finalize);
      const sessionState: SessionState = {
        sessionId,
        userId,
        repo: { owner, name },
        artifactsRepo: {
          name: sessionId,
          url: artifact.remote,
          writeToken: artifactToken,
        },
        createdAt: Date.now(),
      };
      await this.state.storage.put("state", sessionState);
      log("Step 8 — state stored", { sessionId, userId });
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
}
