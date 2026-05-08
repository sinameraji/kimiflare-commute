/// <reference types="@cloudflare/workers-types" />

export interface SessionRecord {
  id: string;
  user_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  branch: string | null;
  status: string;
  sandbox_instance_type: string;
  started_at: number | null;
  ended_at: number | null;
  sandbox_active_seconds: number;
  ai_input_tokens: number;
  ai_output_tokens: number;
  tool_calls_count: number;
  pr_url: string | null;
  error_message: string | null;
  error_category: string | null;
  cost_estimate_usd: number;
  created_at: number;
  updated_at: number;
}

export interface DailyUsageRecord {
  user_id: string;
  date: string;
  sessions_count: number;
  total_active_seconds: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost_usd: number;
}

/**
 * Create or update a user record.
 */
export async function upsertUser(
  db: D1Database,
  userId: string,
  githubLogin: string,
  githubAvatar?: string
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO users (id, github_login, github_avatar, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_avatar = excluded.github_avatar,
       updated_at = excluded.updated_at`
  ).bind(userId, githubLogin, githubAvatar ?? null, now, now).run();
}

/**
 * Create a new session record.
 */
export async function createSession(
  db: D1Database,
  session: {
    id: string;
    userId: string;
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    sandboxInstanceType?: string;
  }
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO sessions (id, user_id, repo_owner, repo_name, branch, status, sandbox_instance_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    session.id,
    session.userId,
    session.repoOwner ?? null,
    session.repoName ?? null,
    session.branch ?? null,
    "idle",
    session.sandboxInstanceType ?? "standard-1",
    now,
    now
  ).run();
}

/**
 * Update session status.
 */
export async function updateSessionStatus(
  db: D1Database,
  sessionId: string,
  status: string,
  updates?: Partial<SessionRecord>
): Promise<void> {
  const fields: string[] = ["status = ?", "updated_at = ?"];
  const values: (string | number | null)[] = [status, Date.now()];

  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
  }

  values.push(sessionId);

  await db.prepare(
    `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...values).run();
}

/**
 * Record a usage event (per-turn granularity).
 */
export async function recordUsageEvent(
  db: D1Database,
  event: {
    sessionId: string;
    turnNumber?: number;
    eventType: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
  }
): Promise<void> {
  await db.prepare(
    `INSERT INTO usage_events (session_id, turn_number, event_type, model, tokens_in, tokens_out, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    event.sessionId,
    event.turnNumber ?? null,
    event.eventType,
    event.model ?? null,
    event.tokensIn ?? 0,
    event.tokensOut ?? 0,
    event.latencyMs ?? null,
    Date.now()
  ).run();
}

/**
 * Upsert daily usage aggregation.
 */
export async function upsertDailyUsage(
  db: D1Database,
  userId: string,
  date: string,
  activeSeconds: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_usage (user_id, date, sessions_count, total_active_seconds, total_input_tokens, total_output_tokens, estimated_cost_usd)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       sessions_count = sessions_count + 1,
       total_active_seconds = total_active_seconds + excluded.total_active_seconds,
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd`
  ).bind(userId, date, activeSeconds, inputTokens, outputTokens, costUsd).run();
}

/**
 * List recent sessions for a user.
 */
export async function listUserSessions(
  db: D1Database,
  userId: string,
  limit = 20
): Promise<SessionRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(userId, limit).all<SessionRecord>();

  return result.results ?? [];
}

/**
 * Get a single session by ID.
 */
export async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRecord | null> {
  const result = await db.prepare(
    `SELECT * FROM sessions WHERE id = ?`
  ).bind(sessionId).first<SessionRecord>();

  return result ?? null;
}

/**
 * Get daily usage for a user.
 */
export async function getUserDailyUsage(
  db: D1Database,
  userId: string,
  days = 30
): Promise<DailyUsageRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM daily_usage WHERE user_id = ? AND date >= date('now', '-${days} days') ORDER BY date DESC`
  ).bind(userId).all<DailyUsageRecord>();

  return result.results ?? [];
}

/**
 * Calculate estimated cost for a session.
 */
export function estimateSessionCost(
  activeSeconds: number,
  inputTokens: number,
  outputTokens: number,
  instanceType = "standard-1"
): number {
  // Sandbox cost: $0.000020/vCPU-sec + $0.0000025/GiB-sec
  // standard-1: 0.5 vCPU, 4 GiB
  const vcpuSeconds = instanceType === "standard-1" ? activeSeconds * 0.5 : activeSeconds;
  const gibSeconds = instanceType === "standard-1" ? activeSeconds * 4 : activeSeconds;
  const sandboxCost = vcpuSeconds * 0.000020 + gibSeconds * 0.0000025;

  // AI cost: ~$0.50/1M input tokens, ~$1.50/1M output tokens (Kimi K2.6)
  const aiCost = (inputTokens / 1_000_000) * 0.50 + (outputTokens / 1_000_000) * 1.50;

  return sandboxCost + aiCost;
}
