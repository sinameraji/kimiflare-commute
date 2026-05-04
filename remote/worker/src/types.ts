export interface RemoteProgressEvent {
  type: string;
  [key: string]: unknown;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  status: "idle" | "running" | "paused" | "done" | "error" | "cancelled";
  prompt: string;
  repo: { owner: string; name: string };
  branch: string;
  artifactsRepo?: { name: string; url: string; writeToken: string };
  sandboxId?: string;
  githubToken?: string;
  progressEvents: RemoteProgressEvent[];
  prUrl?: string;
  errorMessage?: string;
  errorCategory?: "agent-crash" | "sandbox-oom" | "github-api" | "timeout" | "unknown";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  maxTurns: number;
  currentTurn: number;
  model?: string;
  reasoningEffort?: string;
  ttlMinutes: number;
  tokensUsed?: number;
  tokensBudget?: number;
  sandboxInstanceType?: string;
  sandboxActiveSeconds?: number;
}

export interface Env {
  SESSION_DO: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  SANDBOX: DurableObjectNamespace;
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  REMOTE_AUTH_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  ADMIN_GITHUB_ID: string;
  ALLOWED_GITHUB_IDS?: string;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
}

// Artifacts binding types (from Cloudflare docs)
export interface Artifacts {
  create(name: string, opts?: ArtifactsCreateRepoOptions): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;
  import(params: ArtifactsImportParams): Promise<ArtifactsCreateRepoResult>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsCreateRepoOptions {
  description?: string;
  readOnly?: boolean;
  setDefaultBranch?: string;
}

export interface ArtifactsCreateRepoResult {
  name: string;
  remote: string;
  defaultBranch: string;
  token: string;
}

export interface ArtifactsRepo extends ArtifactsCreateRepoResult {
  id: string;
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  listTokens(): Promise<ArtifactsTokenListResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(name: string, opts?: ArtifactsForkOptions): Promise<ArtifactsCreateRepoResult>;
}

export interface ArtifactsCreateTokenResult {
  plaintext: string;
  expiresAt: string;
}

export interface ArtifactsTokenListResult {
  total: number;
  tokens: Array<{ id: string; scope: string; expiresAt: string }>;
}

export interface ArtifactsForkOptions {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
}

export interface ArtifactsRepoListResult {
  repos: Array<{ name: string; status: "ready" | "importing" | "forking" }>;
  cursor?: string;
}

export interface ArtifactsImportParams {
  source: {
    url: string;
    branch?: string;
    depth?: number;
  };
  target: {
    name: string;
    opts?: ArtifactsCreateRepoOptions;
  };
}

// Sandbox types (from @cloudflare/sandbox)
export interface SandboxInstance {
  id: string;
  exec(command: string, args?: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  execStream(command: string, args?: string[], opts?: SandboxExecOptions): Promise<ReadableStream>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  setKeepAlive(keepAlive: boolean): Promise<void>;
  destroy(): Promise<void>;
  terminal(request: Request, options?: { cols?: number; rows?: number }): Promise<Response>;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeout?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}
