import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_DIR = path.join(os.homedir(), ".openclaw", "antfarm");
const DB_PATH = path.join(DB_DIR, "antfarm.db");

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
const DB_MAX_AGE_MS = 5000;

/**
 * Get a database connection.
 * NOTE: This does NOT run migrations. Call runMigration() from migrate.ts at startup.
 */
export function getDb(): DatabaseSync {
  const now = Date.now();
  if (_db && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  if (_db) { try { _db.close(); } catch {} }

  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  // Migrations are now handled separately by migrate.ts
  return _db;
}

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
}

export function getDbPath(): string {
  return DB_PATH;
}

// ============================================================
// Transaction Helper (v2.1.2) - Fix for C-3: Transaction Wrapping
// ============================================================
/**
 * Wrap a database operation in a transaction.
 * All operations are atomic (either all succeed or all rolled back).
 *
 * @param fn - Function to execute within the transaction
 * @returns Result of fn() if successful
 * @throws Error if fn() throws (transaction rolled back)
 *
 * Usage:
 * const result = withTransaction((db) => {
 *   db.prepare('INSERT INTO ...').run(...);
 *   db.prepare('UPDATE ...').run(...);
 *   return { success: true };
 * });
 */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
