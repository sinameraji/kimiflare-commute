import type { Env } from "./types.js";
import { runWorker } from "./worker-handler.js";

function log(label: string, data?: unknown) {
  console.log(`[WorkerDO] ${label}:`, JSON.stringify(data, null, 2));
}

export interface WorkerProgress {
  workerId: string;
  status: "pending" | "running" | "completed" | "failed";
  step: string;
  stepIndex: number;
  totalSteps: number;
  message: string;
  logs: string[];
  completedSteps: string[];
  error?: string;
  result?: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
}

const STEPS = [
  "artifact-import",
  "sandbox-acquire",
  "clone",
  "install-config",
  "agent-run",
  "finalize",
];

const STEP_LABELS: Record<string, string> = {
  "artifact-import": "Importing repository into Artifacts",
  "sandbox-acquire": "Starting Cloudflare Sandbox (cold start — this can take 30-60s)",
  clone: "Cloning repository into sandbox",
  "install-config": "Installing KimiFlare and configuring credentials",
  "agent-run": "Running KimiFlare agent loop",
  finalize: "Finalizing and cleaning up",
};

export class WorkerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private abortController?: AbortController;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(request);
    }

    if (path.endsWith("/progress") && request.method === "GET") {
      return this.handleProgress();
    }

    if (path.endsWith("/cancel") && request.method === "POST") {
      return this.handleCancel();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleCancel(): Promise<Response> {
    log("handleCancel", { hasController: !!this.abortController });
    if (this.abortController) {
      this.abortController.abort();
    }
    // Update progress to show cancelled status
    const progress = await this.state.storage.get<WorkerProgress>("progress");
    if (progress) {
      progress.status = "failed";
      progress.error = "Cancelled by user";
      progress.logs.push(`[${new Date().toISOString()}] Cancelled by user`);
      progress.updatedAt = Date.now();
      await this.state.storage.put("progress", progress);
    }
    return Response.json({ success: true, cancelled: !!this.abortController });
  }

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const workerId = body.workerId as string;

    log("handleStart", { workerId, task: (body.task as string)?.slice(0, 80) });

    // Store the request payload for the background worker
    await this.state.storage.put("payload", body);

    // Initialize progress
    const progress: WorkerProgress = {
      workerId,
      status: "pending",
      step: STEPS[0],
      stepIndex: 1,
      totalSteps: STEPS.length,
      message: STEP_LABELS[STEPS[0]],
      logs: [`[${new Date().toISOString()}] Worker started`],
      completedSteps: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.state.storage.put("progress", progress);

    // Kick off background work — DO fetch handler returns immediately
    const ctx = this.state as unknown as { waitUntil: (p: Promise<unknown>) => void };
    ctx.waitUntil(this.runBackground(body, workerId));

    return Response.json({ workerId, status: "started" });
  }

  private async handleProgress(): Promise<Response> {
    const progress = await this.state.storage.get<WorkerProgress>("progress");
    if (!progress) {
      return Response.json({ error: "Worker not found" }, { status: 404 });
    }
    return Response.json(progress);
  }

  private async runBackground(payload: Record<string, unknown>, workerId: string): Promise<void> {
    const appendLog = async (msg: string) => {
      const progress = await this.state.storage.get<WorkerProgress>("progress");
      if (!progress) return;
      progress.logs.push(`[${new Date().toISOString()}] ${msg}`);
      progress.updatedAt = Date.now();
      await this.state.storage.put("progress", progress);
    };

    const setStep = async (step: string, status: WorkerProgress["status"], message?: string, error?: string) => {
      const stepIndex = STEPS.indexOf(step);
      const progress = await this.state.storage.get<WorkerProgress>("progress");
      if (!progress) return;
      progress.step = step;
      progress.stepIndex = stepIndex + 1;
      progress.status = status;
      progress.message = message ?? STEP_LABELS[step] ?? step;
      if (error) progress.error = error;
      if (status === "completed" || status === "failed") {
        progress.completedSteps = [...STEPS.slice(0, stepIndex + 1)];
      } else {
        progress.completedSteps = [...STEPS.slice(0, stepIndex)];
      }
      progress.updatedAt = Date.now();
      await this.state.storage.put("progress", progress);
    };

    try {
      // Create abort controller for cancellation support
      this.abortController = new AbortController();

      await setStep("artifact-import", "running");
      await appendLog("Importing repository into Artifacts (or falling back to direct clone)");

      // Run the actual worker — runWorker will handle all phases
      // We wrap it to capture phase updates and real-time logs
      const result = await runWorker(this.env, payload as any, workerId, {
        onPhase: async (phase: string, msg?: string) => {
          if (STEPS.includes(phase)) {
            await setStep(phase, "running", msg);
          }
          if (msg) await appendLog(msg);
        },
        onLog: async (line: string) => {
          await appendLog(line);
        },
        signal: this.abortController.signal,
      });

      this.abortController = undefined;
      await setStep("finalize", result.status === "completed" ? "completed" : "failed");
      await appendLog(`Worker finished with status: ${result.status}`);

      // Store the final result
      const progress = await this.state.storage.get<WorkerProgress>("progress");
      if (progress) {
        progress.result = result as unknown as Record<string, unknown>;
        progress.status = result.status;
        await this.state.storage.put("progress", progress);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("background work failed", { workerId, error: message });
      await setStep("finalize", "failed", "Worker failed", message);
      await appendLog(`Error: ${message}`);
    }
  }
}
