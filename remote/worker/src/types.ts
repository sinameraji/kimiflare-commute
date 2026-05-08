/// <reference types="@cloudflare/workers-types" />

export interface ArtifactsRegistry {
  get(name: string): {
    fork(name: string, opts?: { description?: string; readOnly?: boolean }): Promise<{ name: string; remote: string }>;
    createToken(permission: string, ttlSeconds: number): Promise<{ plaintext: string }>;
  };
  import(opts: {
    source: { url: string; branch: string };
    target: { name: string };
  }): Promise<{ name: string; remote: string }>;
  delete(name: string): Promise<void>;
}

export interface Env {
  // Durable Objects
  SESSION_DO: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace;
  WARM_POOL: DurableObjectNamespace;

  // Bindings
  ARTIFACTS: ArtifactsRegistry;
  DB: D1Database;
  OAUTH_KV: KVNamespace;

  // Secrets
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  ALLOWED_GITHUB_IDS?: string;
  ADMIN_GITHUB_ID?: string;
  REMOTE_AUTH_SECRET?: string;
  ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  status: "idle" | "running" | "done" | "error" | "cancelled";
  prompt: string;
  repo: { owner: string; name: string };
  branch: string;
  artifactsRepo?: {
    name: string;
    url: string;
    writeToken: string;
  };
  sandboxId?: string;
  githubToken?: string;
  progressEvents: RemoteProgressEvent[];
  maxTurns: number;
  currentTurn: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  finishedAt?: number;
  model?: string;
  reasoningEffort?: string;
  ttlMinutes: number;
  sandboxInstanceType: string;
  sandboxActiveSeconds: number;
  tokensUsed?: number;
  prUrl?: string;
  errorMessage?: string;
  errorCategory?: string;
  sandboxLogs?: string[];
}

export interface RemoteProgressEvent {
  type: string;
  [key: string]: unknown;
}

export interface StepEvent {
  type: "step_start" | "step_complete" | "step_retry" | "step_error" | "step_wait";
  step: string;
  message: string;
  attempt?: number;
  maxAttempts?: number;
  durationMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface SessionReadyEvent {
  type: "session_ready";
  sessionId: string;
  terminalUrl: string;
  streamUrl: string;
  status: "idle";
  repo: { owner: string; name: string };
  branch: string;
}

export interface SessionErrorEvent {
  type: "session_error";
  sessionId: string;
  error: string;
  failedStep: string;
}
