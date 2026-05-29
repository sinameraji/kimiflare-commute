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

  // Bindings
  ARTIFACTS?: ArtifactsRegistry;
  OAUTH_KV: KVNamespace;

  // Secrets
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  ALLOWED_GITHUB_IDS?: string;
  ADMIN_GITHUB_ID?: string;
  REMOTE_AUTH_SECRET?: string;

  // Cloudflare BYOK credentials
  ACCOUNT_ID: string;
  CF_API_TOKEN: string;

  // Multi-agent worker endpoint auth
  WORKER_API_KEY?: string;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  repo: { owner: string; name: string };
  artifactsRepo?: {
    name: string;
    url: string;
    writeToken: string;
  };
  sandboxId?: string;
  githubToken?: string;
  createdAt: number;
}

export interface SetupProgress {
  step: string;
  stepIndex: number;
  totalSteps: number;
  status: "running" | "complete" | "error";
  message: string;
  completedSteps: string[];
  error?: string;
  sessionId?: string;
  output?: string;
  logs?: string[];
}
