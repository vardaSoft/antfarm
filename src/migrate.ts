import { DatabaseSync } from "node:sqlite";

// ============================================================
// Schema Version
// ============================================================
// Increment this when making schema changes
// Version history:
//   1: Initial schema (runs, steps, stories, daemon_active_sessions)
//   2: Added type, loop_config, current_story_id, abandoned_count to steps
//   3: Fixed daemon_active_sessions primary key
const SCHEMA_VERSION = 3;

// ============================================================
// Migration Function
// ============================================================
/**
 * Run all database migrations.
 * This should be called ONCE at application startup, not on every getDb() call.
 * 
 * @param db - Database connection
 */
export function migrate(db: DatabaseSync): void {
  // Ensure config table exists for version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Check current schema version
  const current = db.prepare("SELECT value FROM config WHERE key='schema_version'").get() as { value: string } | undefined;
  const currentVersion = current ? parseInt(current.value, 10) : 0;

  if (currentVersion >= SCHEMA_VERSION) {
    // Schema is up to date, skip migrations
    return;
  }

  console.log(`🔧 Migrating database from version ${currentVersion} to ${SCHEMA_VERSION}...`);

  // ============================================================
  // Base Schema (Version 1)
  // ============================================================
  if (currentVersion < 1) {
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

      CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
      CREATE INDEX IF NOT EXISTS idx_steps_agent_id ON steps(agent_id);
      CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
      CREATE INDEX IF NOT EXISTS idx_stories_run_id ON stories(run_id);
    `);
  }

  // ============================================================
  // Version 2: Add columns to steps and runs tables
  // ============================================================
  if (currentVersion < 2) {
    // Add columns to steps table
    const stepsCols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
    const stepsColNames = new Set(stepsCols.map(c => c.name));

    if (!stepsColNames.has("type")) {
      db.exec("ALTER TABLE steps ADD COLUMN type TEXT NOT NULL DEFAULT 'single'");
    }
    if (!stepsColNames.has("loop_config")) {
      db.exec("ALTER TABLE steps ADD COLUMN loop_config TEXT");
    }
    if (!stepsColNames.has("current_story_id")) {
      db.exec("ALTER TABLE steps ADD COLUMN current_story_id TEXT");
    }
    if (!stepsColNames.has("abandoned_count")) {
      db.exec("ALTER TABLE steps ADD COLUMN abandoned_count INTEGER DEFAULT 0");
    }

    // Add columns to runs table
    const runsCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const runsColNames = new Set(runsCols.map(c => c.name));

    if (!runsColNames.has("notify_url")) {
      db.exec("ALTER TABLE runs ADD COLUMN notify_url TEXT");
    }
    if (!runsColNames.has("run_number")) {
      db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
      db.exec(`
        UPDATE runs SET run_number = (
          SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
        ) WHERE run_number IS NULL
      `);
    }
    if (!runsColNames.has("scheduler")) {
      db.exec("ALTER TABLE runs ADD COLUMN scheduler TEXT");
    }

    // Add indexes for performance
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_scheduler ON runs(scheduler)");
  }

  // ============================================================
  // Version 3: Fix daemon_active_sessions primary key
  // ============================================================
  if (currentVersion < 3) {
    try {
      // Check if the old unique index exists (indicates old schema with COALESCE PK)
      const indexExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index'
        AND name='idx_daemon_active_sessions_pk'
        AND tbl_name='daemon_active_sessions'
      `).get();

      // Check if new schema is already applied (PRIMARY KEY includes story_id without COALESCE)
      const tableInfo = db.prepare("PRAGMA table_info(daemon_active_sessions)").all() as Array<{ name: string; pk: number }>;
      const isNewSchema = tableInfo.some(col => col.name === 'story_id' && col.pk > 0);

      // If old index exists AND new schema not yet applied, migrate
      const isOldSchema = indexExists && !isNewSchema;

      if (isOldSchema) {
        console.log("🔧 Migrating daemon_active_sessions primary key...");

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

        db.exec(`
          INSERT INTO daemon_active_sessions_new
          SELECT * FROM daemon_active_sessions
        `);

        const rowCount = db.prepare("SELECT COUNT(*) as cnt FROM daemon_active_sessions_new").get() as { cnt: number };
        console.log(`  -> Migrated ${rowCount.cnt} session records`);

        db.exec(`DROP TABLE daemon_active_sessions`);
        db.exec(`ALTER TABLE daemon_active_sessions_new RENAME TO daemon_active_sessions`);

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
    }
  }

  // Update schema version
  db.exec(`INSERT OR REPLACE INTO config (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
  console.log(`✅ Database migrated to version ${SCHEMA_VERSION}`);
}

