import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_DIR = path.join(os.homedir(), ".openclaw", "antfarm");
const DB_PATH = path.join(DB_DIR, "antfarm.db");

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
const DB_MAX_AGE_MS = 5000;

export function getDb(): DatabaseSync {
  const now = Date.now();
  if (_db && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  if (_db) { try { _db.close(); } catch {} }

  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_active_sessions (
      agent_id TEXT,
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_id TEXT,
      spawned_at TEXT NOT NULL,
      spawned_by TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, step_id, story_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_daemon_active_sessions_pk
    ON daemon_active_sessions(agent_id, step_id, COALESCE(story_id, ''));

    CREATE INDEX IF NOT EXISTS idx_daemon_active_sessions_run_id ON daemon_active_sessions(run_id);
    CREATE INDEX IF NOT EXISTS idx_daemon_active_sessions_story_id ON daemon_active_sessions(story_id);

    -- Additional indexes for performance
    CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
    CREATE INDEX IF NOT EXISTS idx_steps_agent_id ON steps(agent_id);
    CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
    CREATE INDEX IF NOT EXISTS idx_stories_run_id ON stories(run_id);
  `);

  // Add columns to steps table for backwards compat
  const cols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("type")) {
    db.exec("ALTER TABLE steps ADD COLUMN type TEXT NOT NULL DEFAULT 'single'");
  }
  if (!colNames.has("loop_config")) {
    db.exec("ALTER TABLE steps ADD COLUMN loop_config TEXT");
  }
  if (!colNames.has("current_story_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN current_story_id TEXT");
  }
  if (!colNames.has("abandoned_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN abandoned_count INTEGER DEFAULT 0");
  }

  // Add columns to runs table for backwards compat
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("notify_url")) {
    db.exec("ALTER TABLE runs ADD COLUMN notify_url TEXT");
  }
  if (!runColNames.has("run_number")) {
    db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
    // Backfill existing runs with sequential numbers based on creation order
    db.exec(`
      UPDATE runs SET run_number = (
        SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
      ) WHERE run_number IS NULL
    `);
  }
  
  if (!runColNames.has("scheduler")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduler TEXT");
  }
  
  // Add indexes for performance
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_scheduler ON runs(scheduler)");

  // ============================================================
  // Migration fix v2.1.1: Fix daemon_active_sessions primary key
  // ============================================================
  try {
    // Check if the old unique index exists (indicates old schema with COALESCE PK)
    const indexExists = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index'
      AND name='idx_daemon_active_sessions_pk'
      AND tbl_name='daemon_active_sessions'
    `).get();

    // Check if new schema is already applied ( PRIMARY KEY includes story_id without COALESCE )
    const tableInfo = db.prepare("PRAGMA table_info(daemon_active_sessions)").all() as Array<{ name: string; pk: number; }>;
    const isNewSchema = tableInfo.filter(col => col.pk === 1).some(col => col.name === 'story_id');

    // If old index exists AND new schema not yet applied, migrate
    const isOldSchema = indexExists && !isNewSchema;

    if (isOldSchema) {
      console.log("🔧 Migrating daemon_active_sessions primary key...");

      // Step 1: Create new table with correct schema
      db.exec(`
        CREATE TABLE daemon_active_sessions_new (
          agent_id TEXT,
          step_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(id),
          story_id TEXT,
          spawned_at TEXT NOT NULL,
          spawned_by TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (agent_id, step_id, story_id)
        )
      `);

      // Step 2: Copy data (including any existing data)
      db.exec(`
        INSERT INTO daemon_active_sessions_new
        SELECT * FROM daemon_active_sessions
      `);

      // Check if data was copied
      const rowCount = db.prepare("SELECT COUNT(*) as cnt FROM daemon_active_sessions_new").get() as { cnt: number };
      console.log(`  -> Migrated ${rowCount.cnt} session records`);

      // Step 3: Drop old table
      db.exec(`DROP TABLE daemon_active_sessions`);

      // Step 4: Rename new table
      db.exec(`ALTER TABLE daemon_active_sessions_new RENAME TO daemon_active_sessions`);

      // Step 5: Recreate indexes with correct schema
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_daemon_active_sessions_pk
        ON daemon_active_sessions(agent_id, step_id, COALESCE(story_id, ''));
        CREATE INDEX IF NOT EXISTS idx_daemon_active_sessions_run_id ON daemon_active_sessions(run_id);
        CREATE INDEX IF NOT EXISTS idx_daemon_active_sessions_story_id ON daemon_active_sessions(story_id);
      `);

      console.log("✅ daemon_active_sessions primary key migration complete");
    }
  } catch (error) {
    console.error("⚠️ Failed to migrate daemon_active_sessions:", error);
    // Don't throw - let the system continue with existing schema if migration fails
  }
}

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
}

export function getDbPath(): string {
  return DB_PATH;
}
