/**
 * Worker endpoint handler — receives a mission brief from the KimiFlare
 * coordinator and runs a full kimiflare agent loop inside a Cloudflare
 * Sandbox, with the user's repo cloned in. This is the real thing: the
 * worker can read code, grep, run commands, and (in execute mode) commit
 * and open a PR.
 *
 * Architecture (per request):
 *   1. Import repo into Artifacts (fallback: direct GitHub clone)
 *   2. Get a Sandbox instance keyed by a unique workerId
 *   3. `git clone` the repo into /workspace/repo
 *   4. Write Cloudflare credentials to /root/.config/kimiflare/config.json
 *   5. Exec `kimiflare -p "<wrapped task>" --dangerously-allow-all` inside
 *      the repo. This runs the full agent loop with all tools.
 *   6. Parse the structured JSON the wrapper prompt asks the model to emit
 *   7. (Execute mode) git add/commit/push, open PR via GitHub API
 *   8. rm workspace, return findings/recommendations to the coordinator
 */

import type { Env } from "./types.js";
import { getSandbox } from "@cloudflare/sandbox";
import { createPullRequest } from "./github.js";

export interface WorkerRequest {
  mode: "plan" | "execute";
  task: string;
  context?: string;
  budget?: { maxCostUsd?: number };
  model?: string;
  // Required for sandbox-driven workers:
  githubToken?: string;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  // Execute mode only:
  branchName?: string;
  prTitle?: string;
  prBody?: string;
  /** Optional override for the in-sandbox kimiflare install. Passed to
   *  `npm install -g <kimiflareInstall>` post-clone before the agent runs.
   *  Examples: "kimiflare@latest", "kimiflare@1.2.3",
   *  "github:sinameraji/kimiflare#feat/some-branch". When omitted, the image's
   *  pre-installed kimiflare (built into the Dockerfile) is used. */
  kimiflareInstall?: string;
  /** User's Cloudflare credentials. When set, the in-sandbox kimiflare is
   *  configured with these so worker LLM calls bill the USER's account, not
   *  the Commute operator's. Falls back to the operator's env creds. */
  userAccountId?: string;
  userApiToken?: string;
  /** Batch identifier sent by the coordinator so the Commute worker can
   *  share a single imported artifact across workers in the same batch. */
  batchId?: string;
  /** When true, clone with `--depth 1` to reduce cold-start time. */
  shallowClone?: boolean;
  /** When true (and batchId is set), attempt to fork a shared batch artifact
   *  instead of re-importing the repo for every worker. */
  repoCache?: boolean;
}

export interface WorkerResponse {
  workerId: string;
  status: "completed" | "failed" | "cancelled" | "budget_exhausted";
  task: string;
  findings: Array<{
    topic: string;
    summary: string;
    confidence: "high" | "medium" | "low";
    sources: string[];
    relevance: "critical" | "high" | "medium" | "low";
  }>;
  recommendations: string[];
  filesRead: string[];
  webSources: string[];
  costUsd: number;
  tokensUsed: number;
  reasoning: string;
  prUrl?: string;
  branchName?: string;
  rawOutput?: string;
  error?: string;
  /** Phase timing breakdown for debugging cold-start issues. */
  phases?: Array<{ name: string; ms: number }>;
  /** True when the worker was killed because it exceeded its budget ceiling. */
  budgetExceeded?: boolean;
  /** True when the result contains partial findings produced before budget exhaustion. */
  partialResult?: boolean;
}

function log(label: string, data?: unknown) {
  console.log(`[WorkerEndpoint] ${label}:`, JSON.stringify(data, null, 2));
}

function emptyResponse(
  workerId: string,
  task: string,
  error: string,
  phases?: Array<{ name: string; ms: number }>,
  status: WorkerResponse["status"] = "failed",
): WorkerResponse {
  return {
    workerId,
    status,
    task,
    findings: [],
    recommendations: [],
    filesRead: [],
    webSources: [],
    costUsd: 0,
    tokensUsed: 0,
    reasoning: "",
    error,
    phases,
    budgetExceeded: status === "budget_exhausted",
    partialResult: status === "budget_exhausted",
  };
}

/** Resolve the effective budget for a worker, applying the server-side hard ceiling.
 *
 *  - Client-sent maxCostUsd is honored up to the hard ceiling.
 *  - If no budget is sent, defaults to 1.0.
 *  - The hard ceiling comes from WORKER_BUDGET_MAX_USD env (default 5.0).
 */
function resolveBudgetUsd(req: WorkerRequest, env: Env): number {
  const DEFAULT_BUDGET = 1.0;
  const HARD_CEILING = parseFloat(env.WORKER_BUDGET_MAX_USD ?? "5.0");
  const client = req.budget?.maxCostUsd ?? DEFAULT_BUDGET;
  return Math.min(client, HARD_CEILING);
}

/** Rough cost estimate from log file bytes.
 *
 *  Uses a conservative blended rate ($3.00 / M tokens) and assumes
 *  ~3 chars per token. This is intentionally pessimistic so we kill
 *  the sandbox *before* the real cost exceeds the budget.
 */
function estimateCostUsd(logBytes: number): number {
  const tokens = logBytes / 3;
  const blendedRatePerMtok = 3.0; // conservative blended input+output rate
  return (tokens / 1_000_000) * blendedRatePerMtok;
}

export async function handleWorkerRequest(
  c: import("hono").Context<{ Bindings: Env }>,
): Promise<Response> {
  const apiKey = c.req.header("X-Worker-Api-Key");
  if (c.env.WORKER_API_KEY && apiKey !== c.env.WORKER_API_KEY) {
    log("auth failed", { provided: apiKey ? "present" : "missing" });
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: WorkerRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.task || !body.mode) {
    return c.json({ error: "Missing required fields: task, mode" }, 400);
  }
  if (!body.githubToken || !body.owner || !body.repo) {
    return c.json(
      { error: "Missing required fields for sandbox-driven workers: githubToken, owner, repo" },
      400,
    );
  }
  if (!c.env.SANDBOX) {
    return c.json({ error: "SANDBOX binding not configured on this Worker" }, 500);
  }
  if (!c.env.ACCOUNT_ID || !c.env.CF_API_TOKEN) {
    return c.json({ error: "ACCOUNT_ID or CF_API_TOKEN not configured" }, 500);
  }

  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  log("request", { workerId, mode: body.mode, task: body.task.slice(0, 100), repo: `${body.owner}/${body.repo}` });

  try {
    const result = await runWorker(c.env, body, workerId);
    log("completed", { workerId, status: result.status, prUrl: result.prUrl });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("failed", { workerId, error: message });
    // Distinguish DO reset / sandbox crashes from application errors so the
    // coordinator retry logic can treat them appropriately.
    const isSandboxCrash =
      message.includes("Network connection lost") ||
      message.includes("Durable Object storage") ||
      message.includes("reset") ||
      message.includes("sandbox");
    const statusCode = isSandboxCrash ? 503 : 500;
    return c.json(emptyResponse(workerId, body.task, message), statusCode);
  }
}

export interface WorkerCallbacks {
  onPhase?: (phase: string, message?: string) => void | Promise<void>;
  onLog?: (line: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function runWorker(
  env: Env,
  req: WorkerRequest,
  workerId: string,
  callbacks?: WorkerCallbacks,
): Promise<WorkerResponse> {
  const startMs = Date.now();
  const phases: Array<{ name: string; ms: number }> = [];
  const mark = async (name: string, msg?: string) => {
    const now = Date.now();
    phases.push({ name, ms: now - startMs });
    log(`phase: ${name}`, { workerId, elapsedMs: now - startMs });
    if (callbacks?.onPhase) {
      await callbacks.onPhase(name, msg);
    }
  };

  const owner = req.owner!;
  const repo = req.repo!;
  const githubToken = req.githubToken!;
  const baseBranch = req.baseBranch ?? "main";
  const githubUrl = `https://github.com/${owner}/${repo}.git`;

  // Budget enforcement setup
  const budgetUsd = resolveBudgetUsd(req, env);
  log("budget resolved", { workerId, budgetUsd, clientBudget: req.budget?.maxCostUsd });

  // 1. Import repo into Artifacts (with fallback to direct GitHub clone)
  //    When repoCache + batchId are set, try to fork a shared batch artifact
  //    so multiple workers in the same batch don't each re-import the repo.
  let artifact: { name: string; remote: string } | undefined;
  let artifactToken: string | undefined;
  const batchArtifactName = req.batchId && req.repoCache ? `batch-${req.batchId}` : undefined;
  if (env.ARTIFACTS) {
    try {
      if (batchArtifactName) {
        // Try to fork an existing batch artifact first
        try {
          const forked = await env.ARTIFACTS.get(batchArtifactName).fork(workerId, { readOnly: false });
          artifact = forked;
          log("artifact forked from batch cache", { workerId, batchArtifactName, name: artifact.name });
        } catch {
          // Batch artifact doesn't exist yet — import it as the batch artifact
          artifact = await env.ARTIFACTS.import({
            source: { url: githubUrl, branch: baseBranch },
            target: { name: batchArtifactName },
          });
          log("artifact imported as batch cache", { workerId, batchArtifactName, name: artifact.name });
        }
      } else {
        artifact = await env.ARTIFACTS.import({
          source: { url: githubUrl, branch: baseBranch },
          target: { name: workerId },
        });
        log("artifact imported", { workerId, name: artifact.name });
      }
      const tokenRes = await env.ARTIFACTS.get(artifact.name).createToken("read-write", 3600);
      artifactToken = tokenRes.plaintext;
    } catch (err) {
      log("artifact import failed — falling back to direct clone", { error: err instanceof Error ? err.message : String(err) });
      artifact = undefined;
      artifactToken = undefined;
    }
  }
  await mark("artifact-import");

  // 2. Get a Sandbox instance for this worker
  const sandbox = await getSandbox(env.SANDBOX as any, workerId);
  await mark("sandbox-acquire");

  try {
    // 3. Clone the repo into the sandbox
    let cloneUrl: string;
    if (artifact && artifactToken) {
      cloneUrl = artifact.remote.replace("https://", `https://token:${encodeURIComponent(artifactToken)}@`);
    } else {
      cloneUrl = githubUrl.replace("https://", `https://${encodeURIComponent(githubToken)}@`);
    }
    const depthFlag = req.shallowClone !== false ? "--depth 1" : "--depth 50";
    const cloneRes = await sandbox.exec(`rm -rf /workspace/repo && git clone ${depthFlag} ${cloneUrl} /workspace/repo`);
    if (!cloneRes.success) {
      throw new Error(`git clone failed: ${(cloneRes.stderr || cloneRes.stdout || "").slice(0, 300)}`);
    }
    log("repo cloned", { workerId });
    // Ensure remote uses the GitHub token so push works in execute mode
    const encodedGhToken = encodeURIComponent(githubToken);
    const githubRemote = githubUrl.replace("https://", `https://${encodedGhToken}@`);
    await sandbox.exec(`cd /workspace/repo && git remote set-url origin ${githubRemote}`);
    await sandbox.exec(`cd /workspace/repo && git config user.email "kimiflare-worker@proton.me" && git config user.name "kimiflare-worker"`);
    await mark("clone");

    // 3b. Ensure the in-sandbox kimiflare is current. End users always get
    // the latest published version; devs/CI can pin via the
    // `kimiflareInstall` request field (e.g. KIMIFLARE_CLI_REF env on the
    // client side). Non-fatal — if the install fails we continue with the
    // image-baked version.
    const installSpec = req.kimiflareInstall ?? "kimiflare@latest";
    const installArg = shellEscapeArg(installSpec);
    // Skip npm install if the image already has kimiflare and the user isn't
    // requesting a specific override. This saves ~60s of CPU/memory pressure
    // inside the Sandbox, reducing the chance of DO reset.
    const versionRes = await sandbox.exec("kimiflare --version");
    const hasKimi = versionRes.success && (versionRes.stdout ?? "").trim().length > 0;
    if (hasKimi && !req.kimiflareInstall) {
      log("kimiflare already installed in sandbox image", { workerId, version: (versionRes.stdout ?? "").trim() });
    } else {
      log("installing kimiflare in sandbox", { workerId, install: installSpec, reason: hasKimi ? "override requested" : "not present" });
      const installRes = await sandbox.exec(`npm install -g --force --ignore-scripts ${installArg}`);
      if (!installRes.success) {
        log("kimiflare install failed (continuing with image-baked version)", {
          workerId,
          stderr: (installRes.stderr ?? "").slice(0, 300),
        });
      }
    }

    // 4. Write Cloudflare credentials so the kimiflare CLI inside can call
    // Workers AI. Prefer the user's creds (so they're billed for their own
    // worker runs); fall back to the operator's env if the client didn't
    // send them (older clients).
    const config = JSON.stringify({
      accountId: req.userAccountId ?? env.ACCOUNT_ID,
      apiToken: req.userApiToken ?? env.CF_API_TOKEN,
      model: req.model ?? "@cf/moonshotai/kimi-k2.6",
    });
    await sandbox.exec("mkdir -p /root/.config/kimiflare");
    await sandbox.exec(`cat > /root/.config/kimiflare/config.json << 'KIMICONFIG_EOF'\n${config}\nKIMICONFIG_EOF`);
    await mark("install-config");

    // 5. Build the wrapped prompt and run kimiflare -p
    const wrapped = req.mode === "plan"
      ? wrapPlanPrompt(req.task, req.context)
      : wrapExecutePrompt(req.task, req.context);
    // Single-quote escape: replace each ' with '\''
    const escapedPrompt = wrapped.replace(/'/g, `'\\''`);
    const kimiCmd = `cd /workspace/repo && kimiflare -p '${escapedPrompt}' --dangerously-allow-all --continue-on-limit`;
    log("running kimiflare", {
      workerId,
      cmdLength: kimiCmd.length,
      mode: req.mode,
      model: req.model ?? "@cf/moonshotai/kimi-k2.6",
      inSandboxVersion: (versionRes.stdout ?? "").trim() || "(unknown)",
      // The config we write (above) does not set `codeMode`, so the in-sandbox
      // kimiflare uses its headless default (codeMode=true). Surfaced here so a
      // wrangler tail makes the active execution strategy obvious.
      codeModeNote: "in-sandbox default (config.json does not override codeMode)",
    });
    await mark("agent-run");

    // ── Stream kimiflare output in real-time ───────────────────────────
    // sandbox.exec() is blocking — we get zero visibility for 5-10 min.
    // Instead: run kimiflare in background, redirect to a file, and tail
    // the file in a loop, reporting new lines via onLog callback.
    const logFile = "/tmp/kimi-output.log";
    const pidFile = "/tmp/kimi.pid";
    const escapedCmd = kimiCmd.replace(/'/g, `'\\''`);
    const shallowEnv = req.shallowClone !== false ? "SHALLOW_CLONE=1 " : "";
    const startCmd = `nohup sh -c '${shallowEnv}${escapedCmd}' > ${logFile} 2>&1 & echo $! > ${pidFile}`;

    log("starting kimiflare in background", { workerId, logFile });
    const startRes = await sandbox.exec(startCmd);
    if (!startRes.success) {
      throw new Error(`Failed to start kimiflare: ${startRes.stderr || startRes.stdout}`);
    }

    // Verify PID was written
    const pidRes = await sandbox.exec(`cat ${pidFile}`);
    const pid = (pidRes.stdout ?? "").trim();
    if (!pid) {
      throw new Error("Failed to get kimiflare PID");
    }
    log("kimiflare started", { workerId, pid });

    // Tail the log file in real-time
    let lastSize = 0;
    const pollMs = 3000;
    const maxWaitMs = 600_000; // 10 min safety cap
    const agentStart = Date.now();
    let runSuccess = false;
    let runExitCode = -1;

    let budgetKilled = false;

    while (Date.now() - agentStart < maxWaitMs) {
      // Check cancellation
      if (callbacks?.signal?.aborted) {
        log("kimiflare cancelled by signal", { workerId });
        await sandbox.exec(`kill -9 ${pid} 2>/dev/null || true`);
        throw new Error("Cancelled by user");
      }

      // Check if process is still running
      const checkRes = await sandbox.exec(`kill -0 ${pid} 2>/dev/null && echo running || echo done`);
      const isRunning = checkRes.stdout?.trim() === "running";

      // Get current file size
      const sizeRes = await sandbox.exec(`stat -c %s ${logFile} 2>/dev/null || echo 0`);
      const currentSize = parseInt((sizeRes.stdout ?? "0").trim(), 10);

      if (currentSize > lastSize) {
        // Read new content
        const newBytes = currentSize - lastSize;
        const tailRes = await sandbox.exec(`tail -c ${newBytes} ${logFile}`);
        const newContent = tailRes.stdout ?? "";
        lastSize = currentSize;

        // Report each new line
        const lines = newContent.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          if (callbacks?.onLog) {
            await callbacks.onLog(line);
          }
        }

        // ── Budget enforcement ──
        // Estimate cost from log size and kill the sandbox if we've blown
        // the budget. This is a conservative heuristic (intentionally
        // over-estimates) so we act *before* the real Cloudflare bill
        // exceeds the ceiling.
        const estimatedCost = estimateCostUsd(currentSize);
        if (estimatedCost >= budgetUsd) {
          log("budget exceeded — killing sandbox", {
            workerId,
            estimatedCostUsd: estimatedCost.toFixed(4),
            budgetUsd,
            logBytes: currentSize,
          });
          await sandbox.exec(`kill -9 ${pid} 2>/dev/null || true`);
          budgetKilled = true;
          break;
        }
      }

      if (!isRunning) {
        // Process finished — get exit code
        const exitRes = await sandbox.exec(`wait ${pid} 2>/dev/null; echo $?`);
        runExitCode = parseInt((exitRes.stdout ?? "-1").trim(), 10);
        runSuccess = runExitCode === 0;
        log("kimiflare finished", { workerId, exitCode: runExitCode, success: runSuccess, logSize: currentSize });
        break;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Read full output for parsing
    const fullOutputRes = await sandbox.exec(`cat ${logFile}`);
    const rawOutput = (fullOutputRes.stdout ?? "").trim();
    const rawStderr = ""; // stderr is merged into stdout via 2>&1

    if (Date.now() - agentStart >= maxWaitMs) {
      log("kimiflare timed out", { workerId });
      await sandbox.exec(`kill -9 ${pid} 2>/dev/null || true`);
      throw new Error("KimiFlare agent timed out after 10 minutes");
    }
    // Full diagnostics for `wrangler tail`. Previously only `stdoutLen` was
    // logged, so failures were invisible — we could not tell a code-mode hang
    // from a slow-but-legit run, an API error, or an OOM. Log exit code, both
    // stream lengths, and generous head/tail slices of each. Tail matters most:
    // the real error (stack trace, budget message, kill notice) lands at the end.
    log("kimiflare done", {
      workerId,
      exitCode: runExitCode,
      success: runSuccess,
      stdoutLen: rawOutput.length,
      stderrLen: rawStderr.length,
      stdoutTail: rawOutput.slice(-4000),
      stderrTail: rawStderr.slice(-4000),
      stdoutHead: rawOutput.slice(0, 1000),
    });
    if (!runSuccess) {
      // Surface the failure prominently and in full so the cause is unmissable
      // in a tail. The coordinator only ever saw a 500-char slice before.
      log("kimiflare FAILED — full stderr", { workerId, exitCode: runExitCode, stderr: rawStderr });
      log("kimiflare FAILED — full stdout", { workerId, stdout: rawOutput });
    }

    // 6. Parse structured JSON the wrapper asked the model to emit
    const parsed = extractJsonBlock(rawOutput) ?? {};

    // 7. Execute mode: commit + push + open PR
    let prUrl: string | undefined;
    let branchName: string | undefined;
    if (req.mode === "execute") {
      branchName = req.branchName ?? `kimiflare/${workerId}`;
      // Stage any changes the agent made
      const diffRes = await sandbox.exec("cd /workspace/repo && git status --porcelain");
      const hasChanges = (diffRes.stdout ?? "").trim().length > 0;
      if (hasChanges) {
        const commitMsg = (parsed.commitMessage as string) ?? `kimiflare worker: ${req.task.slice(0, 60)}`;
        const commitMsgEscaped = commitMsg.replace(/'/g, `'\\''`);
        const branchRes = await sandbox.exec(`cd /workspace/repo && git checkout -b ${shellEscapeArg(branchName)}`);
        if (!branchRes.success) throw new Error(`git checkout -b failed: ${branchRes.stderr || branchRes.stdout}`);
        const addRes = await sandbox.exec(`cd /workspace/repo && git add -A`);
        if (!addRes.success) throw new Error(`git add failed: ${addRes.stderr || addRes.stdout}`);
        const commitRes = await sandbox.exec(`cd /workspace/repo && git commit -m '${commitMsgEscaped}'`);
        if (!commitRes.success) throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
        const pushRes = await sandbox.exec(`cd /workspace/repo && git push -u origin ${shellEscapeArg(branchName)}`);
        if (!pushRes.success) throw new Error(`git push failed: ${(pushRes.stderr || pushRes.stdout).slice(0, 300)}`);
        const pr = await createPullRequest({
          owner, repo,
          title: req.prTitle ?? commitMsg,
          body: req.prBody ?? `Generated by kimiflare worker ${workerId}.\n\nTask:\n> ${req.task}`,
          head: branchName,
          base: baseBranch,
          token: githubToken,
        });
        prUrl = pr.html_url;
      } else {
        log("execute mode: agent made no file changes", { workerId });
      }
    }

    // 8. Build response
    const findings = Array.isArray(parsed.findings) && parsed.findings.length > 0
      ? parsed.findings
      : [{
          topic: req.task.slice(0, 60),
          summary: rawOutput.slice(0, 1500) || "(no output captured)",
          confidence: "medium" as const,
          sources: [],
          relevance: "high" as const,
        }];
    const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    const filesRead = Array.isArray(parsed.filesRead) ? parsed.filesRead : [];
    // Rough estimates — Workers AI accounting flows through the model's own
    // billing; this is a token-count heuristic for the coordinator's UI.
    const tokensUsed = Math.ceil(rawOutput.length / 4);
    const costUsd = (tokensUsed / 1_000_000) * 1.0;

    await mark("total");

    if (budgetKilled) {
      return {
        workerId,
        status: "budget_exhausted",
        task: req.task,
        findings,
        recommendations,
        filesRead,
        webSources: [],
        costUsd,
        tokensUsed,
        reasoning: (parsed.reasoning as string) ?? rawOutput.slice(0, 2000),
        prUrl,
        branchName,
        rawOutput,
        error: `Worker exceeded its ${budgetUsd.toFixed(2)} budget ceiling and was terminated. ` +
          `Results below are partial — whatever the agent had produced before the kill signal.`,
        phases,
        budgetExceeded: true,
        partialResult: true,
      };
    }

    return {
      workerId,
      status: runSuccess ? "completed" : "failed",
      task: req.task,
      findings,
      recommendations,
      filesRead,
      webSources: [],
      costUsd,
      tokensUsed,
      reasoning: (parsed.reasoning as string) ?? rawOutput.slice(0, 2000),
      prUrl,
      branchName,
      rawOutput,
      // On failure, surface the END of stderr (the real error/stack/kill
      // notice lands last) plus the exit code — not the first 500 chars, which
      // were just startup/progress noise (e.g. a truncated `[tool execute_code(`).
      error: runSuccess
        ? undefined
        : `kimiflare exited ${runExitCode}. stderr tail:\n${(rawStderr || rawOutput || "(no output)").slice(-1500)}`,
      phases,
    };
  } catch (err) {
    await mark("total");
    const message = err instanceof Error ? err.message : String(err);
    return emptyResponse(workerId, req.task, message, phases);
  } finally {
    // 9. Cleanup — best-effort; non-fatal.
    // `sandbox.destroy()` is the documented way to release the underlying
    // container; @cloudflare/sandbox README warns: "You MUST call
    // sandbox.destroy() when done to avoid resource leaks". Without it the
    // Durable Object keeps the container slot until the platform recycles
    // it idle, which under parallel /worker fan-out can exhaust
    // max_instances. The `rm -rf` is belt-and-braces; destroy alone tears
    // down the workspace too.
    try {
      await sandbox.exec("rm -rf /workspace/repo /root/.config/kimiflare");
    } catch (err) {
      log("cleanup warning (sandbox files)", err instanceof Error ? err.message : String(err));
    }
    try {
      await sandbox.destroy();
      log("sandbox destroyed", { workerId });
    } catch (err) {
      log("sandbox.destroy() threw — slot will reclaim on idle timeout instead",
          err instanceof Error ? err.message : String(err));
    }
    if (env.ARTIFACTS && artifact) {
      try {
        // When repoCache is enabled with a batchId, the artifact is shared
        // across workers in the same batch. Deleting it here would break
        // subsequent workers. The batch artifact is ephemeral and will be
        // cleaned up by the platform's artifact lifecycle.
        if (batchArtifactName && req.repoCache) {
          log("skipping artifact delete (batch cache)", { workerId, batchArtifactName });
        } else {
          await env.ARTIFACTS.delete(workerId);
          log("artifact deleted", { workerId });
        }
      } catch (err) {
        log("cleanup warning (artifact)", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

function wrapPlanPrompt(task: string, context: string | undefined): string {
  return [
    "You are a research worker. Investigate the following task in this codebase.",
    "Use read, grep, bash, and web-search tools to explore. Do NOT modify files.",
    "CRITICAL: Do NOT use tasks_set. Do NOT create todo lists or planning tasks. Just explore and read directly.",
    "",
    `Task: ${task}`,
    context ? `\nAdditional context: ${context}` : "",
    "",
    "When you are done investigating, end your reply with a single fenced JSON block in EXACTLY this format (no extra text after it):",
    "```json",
    "{",
    '  "findings": [{"topic": "short label", "summary": "what you found", "confidence": "high|medium|low", "sources": ["path/to/file:line", "..."], "relevance": "critical|high|medium|low"}],',
    '  "recommendations": ["actionable rec 1", "actionable rec 2"],',
    '  "filesRead": ["path/to/file", "..."],',
    '  "reasoning": "1-3 sentences of why these findings matter"',
    "}",
    "```",
  ].join("\n");
}

function wrapExecutePrompt(task: string, context: string | undefined): string {
  return [
    "You are an executor worker. Implement the following task in this codebase.",
    "Read whatever code you need, then make the edits. Keep changes minimal and focused.",
    "Do NOT commit or push — the worker harness will commit your changes after you finish.",
    "CRITICAL: Do NOT use tasks_set. Do NOT create todo lists or planning tasks. Just read and edit directly.",
    "",
    `Task: ${task}`,
    context ? `\nAdditional context: ${context}` : "",
    "",
    "When you are done, end your reply with a single fenced JSON block in EXACTLY this format (no extra text after it):",
    "```json",
    "{",
    '  "commitMessage": "concise commit message",',
    '  "filesRead": ["path/to/file", "..."],',
    '  "reasoning": "1-3 sentences of what you changed and why"',
    "}",
    "```",
  ].join("\n");
}

/** Pull the first {...} or ```json fenced block out of the model's stdout. */
function extractJsonBlock(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const last = text.lastIndexOf("{");
  if (last >= 0) candidates.push(text.slice(last));
  for (const c of candidates) {
    try { return JSON.parse(c) as Record<string, unknown>; } catch { /* try next */ }
  }
  return null;
}

function shellEscapeArg(s: string): string {
  // Branch names from us are kebab-case + `/`, but be defensive.
  if (/^[a-zA-Z0-9._/-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
