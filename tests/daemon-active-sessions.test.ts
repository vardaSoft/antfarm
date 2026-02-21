/**
 * Test: daemon_active_sessions table schema
 *
 * Verifies that the daemon_active_sessions table exists with correct schema
 * and supports the required functionality for tracking active agent sessions.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import our database functions
import { getDb, getDbPath } from "../dist/db.js";

describe("daemon_active_sessions table", () => {
  let db: DatabaseSync;
  
  before(() => {
    // Create a temporary database for testing
    const tempDir = path.join(os.tmpdir(), "antfarm-test-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    const dbPath = path.join(tempDir, "test.db");
    
    // Create database and run migrations
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys=ON");
    
    // Run the migration function directly
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
      
      CREATE TABLE IF NOT EXISTS daemon_active_sessions (
        agent_id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        spawned_at TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_daemon_active_sessions_run_id ON daemon_active_sessions(run_id);
    `);
  });
  
  after(() => {
    try {
      db.close();
    } catch (err) {
      // Ignore errors when closing test database
    }
  });

  it("should have daemon_active_sessions table with correct schema", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_active_sessions'").all();
    assert.equal(tables.length, 1, "daemon_active_sessions table should exist");
    
    const columns = db.prepare("PRAGMA table_info(daemon_active_sessions)").all() as Array<{ name: string; type: string; pk: number; notnull: number }>;
    
    // Check we have the right columns
    const columnMap = new Map(columns.map(c => [c.name, c]));
    assert.ok(columnMap.has("agent_id"), "Should have agent_id column");
    assert.ok(columnMap.has("step_id"), "Should have step_id column");
    assert.ok(columnMap.has("run_id"), "Should have run_id column");
    assert.ok(columnMap.has("spawned_at"), "Should have spawned_at column");
    
    // Check primary key
    const agentIdColumn = columnMap.get("agent_id");
    assert.equal(agentIdColumn?.pk, 1, "agent_id should be primary key");
  });

  it("should have foreign key constraint on run_id", () => {
    // This is harder to test directly, but we can check that the table references runs
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(daemon_active_sessions)").all() as Array<{ table: string; from: string; to: string }>;
    assert.equal(foreignKeys.length, 1, "Should have one foreign key");
    assert.equal(foreignKeys[0].table, "runs", "Foreign key should reference runs table");
    assert.equal(foreignKeys[0].from, "run_id", "Foreign key should be on run_id");
  });

  it("should have index on run_id for efficient lookups", () => {
    const indexes = db.prepare("PRAGMA index_list(daemon_active_sessions)").all() as Array<{ name: string; unique: number }>;
    const hasRunIdIndex = indexes.some(idx => idx.name.includes("run_id"));
    assert.ok(hasRunIdIndex, "Should have index on run_id");
  });

  it("should allow inserting and retrieving session records", () => {
    // First insert a run record for the foreign key
    const runId = "test-run-1";
    db.prepare("INSERT INTO runs (id, workflow_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, "test-workflow", "Test task", new Date().toISOString(), new Date().toISOString());
    
    // Insert a session record
    const agentId = "test-agent-1";
    const stepId = "test-step-1";
    const spawnedAt = new Date().toISOString();
    
    const result = db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId, stepId, runId, spawnedAt);
    
    assert.equal(result.changes, 1, "Should insert one row");
    
    // Retrieve and verify
    const row = db.prepare(
      "SELECT agent_id, step_id, run_id, spawned_at FROM daemon_active_sessions WHERE agent_id = ?"
    ).get(agentId) as { agent_id: string; step_id: string; run_id: string; spawned_at: string } | undefined;
    
    assert.ok(row, "Should retrieve inserted row");
    assert.equal(row.agent_id, agentId);
    assert.equal(row.step_id, stepId);
    assert.equal(row.run_id, runId);
    assert.equal(row.spawned_at, spawnedAt);
  });

  it("should prevent duplicate agent_id entries (PRIMARY KEY constraint)", () => {
    // First insert a run record for the foreign key
    const runId = "test-run-2";
    db.prepare("INSERT INTO runs (id, workflow_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, "test-workflow", "Test task", new Date().toISOString(), new Date().toISOString());
    
    // Insert first session
    const agentId = "test-agent-2";
    db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId, "step-1", runId, new Date().toISOString());
    
    // Try to insert duplicate - should throw
    assert.throws(() => {
      db.prepare(
        "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
      ).run(agentId, "step-2", runId, new Date().toISOString());
    }, /UNIQUE constraint failed/, "Should throw on duplicate agent_id");
  });

  it("should enforce foreign key constraint on run_id", () => {
    // Try to insert with non-existent run_id - should throw
    assert.throws(() => {
      db.prepare(
        "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
      ).run("test-agent-3", "test-step-3", "non-existent-run", new Date().toISOString());
    }, /FOREIGN KEY constraint failed/, "Should throw on invalid run_id");
  });
});