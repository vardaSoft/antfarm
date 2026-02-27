/**
 * Simple test: Session tracking and cleanup functionality
 *
 * Verifies that the cleanup functions work correctly.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import our cleanup functions
import { cleanupCompletedSessions, cleanupStaleSessions } from "../dist/daemon/spawner.js";

describe("session cleanup functions", () => {
  let db: DatabaseSync;
  let tempDir: string;
  
  before(() => {
    // Create a temporary database for testing
    tempDir = path.join(os.tmpdir(), "antfarm-test-" + Date.now());
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
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore errors when closing test database
    }
  });

  beforeEach(() => {
    // Clear the daemon_active_sessions table before each test
    db.exec("DELETE FROM daemon_active_sessions");
    
    // Clear the runs table before each test
    db.exec("DELETE FROM runs");
    
    // Clear the steps table before each test
    db.exec("DELETE FROM steps");
  });

  it("should export cleanup functions", () => {
    assert.ok(typeof cleanupCompletedSessions === 'function');
    assert.ok(typeof cleanupStaleSessions === 'function');
  });

  it("should not crash when calling cleanup functions on empty database", () => {
    // Temporarily override getDb to return our test database
    const originalGetDb = (global as any).getDb;
    (global as any).getDb = () => db;
    
    try {
      // These should not throw exceptions
      cleanupCompletedSessions();
      cleanupStaleSessions();
    } finally {
      // Restore original getDb function
      if (originalGetDb) {
        (global as any).getDb = originalGetDb;
      } else {
        delete (global as any).getDb;
      }
    }
  });
});