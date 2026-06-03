/**
 * repo-cache.ts
 *
 * Manages per-repo backup IDs in DO SQLite + R2.
 * Backups are created after a successful clone + config so that subsequent
 * workers (or terminal sessions) can restore in 1–3s instead of re-cloning.
 */

const BACKUP_TTL_SECONDS = 24 * 60 * 60; // 24h

const BACKUP_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS repo_backups (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    backup_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, name)
  )
`;

export function ensureBackupTable(sql: SqlStorage): void {
  sql.exec(BACKUP_TABLE_SQL);
}

export async function getRepoBackup(
  sql: SqlStorage,
  owner: string,
  name: string,
): Promise<string | null> {
  const rows = [
    ...sql.exec(
      "SELECT backup_id FROM repo_backups WHERE owner = ? AND name = ?",
      owner,
      name,
    ),
  ];
  return rows.length > 0 ? (rows[0] as { backup_id: string }).backup_id : null;
}

export async function setRepoBackup(
  sql: SqlStorage,
  owner: string,
  name: string,
  backupId: string,
): Promise<void> {
  sql.exec(
    `INSERT OR REPLACE INTO repo_backups (owner, name, backup_id, created_at)
     VALUES (?, ?, ?, ?)`,
    owner,
    name,
    backupId,
    Date.now(),
  );
}

export async function deleteRepoBackup(
  sql: SqlStorage,
  owner: string,
  name: string,
): Promise<void> {
  sql.exec(
    "DELETE FROM repo_backups WHERE owner = ? AND name = ?",
    owner,
    name,
  );
}

export async function cleanupOldBackups(sql: SqlStorage): Promise<void> {
  const cutoff = Date.now() - BACKUP_TTL_SECONDS * 1000;
  sql.exec("DELETE FROM repo_backups WHERE created_at < ?", cutoff);
}
