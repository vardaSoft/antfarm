/**
 * Test: Session tracking and cleanup functionality
 *
 * Verifies that the daemon properly tracks active sessions and cleans up stale entries.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import our database functions and spawner functions
import { getDb } from "../dist/db.js";
import { cleanupCompletedSessions, cleanupStaleSessions } from "../dist/daemon/spawner.js";

describe("session tracking and cleanup", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let tempHome: string;
  
  before(() => {
    // Store original HOME
    originalHome = process.env.HOME;
    
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), "antfarm-session-test-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Set up temporary home directory to isolate database
    tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });
  
  after(() => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Get the test database (this will be a fresh temporary database)
    const db = getDb();
    
    // Clear tables in correct order to respect foreign key constraints
    // Delete child tables first
    db.exec("DELETE FROM daemon_active_sessions");
    db.exec("DELETE FROM steps");
    db.exec("DELETE FROM stories");
    
    // Then delete parent tables
    db.exec("DELETE FROM runs");
  });

  it("should clean up completed sessions", () => {
    const db = getDb();
    
    // Insert a run record for the foreign key
    const runId = "test-run-1";
    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, "test-workflow", "Test task", "running", "{}", now, now);
    
    // Insert some active sessions
    const agentId1 = "test-workflow_test-agent-1";
    const stepId1 = "test-step-1";
    const agentId2 = "test-workflow_test-agent-2";
    const stepId2 = "test-step-2";
    const spawnedAt = now;
    
    // Insert first session (completed step)
    db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId1, stepId1, runId, spawnedAt);
    
    // Insert second session (still running step)
    db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId2, stepId2, runId, spawnedAt);
    
    // Insert the corresponding steps
    // First step is completed
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(stepId1, runId, "1", "test-agent-1", 1, "Test template", "Test expects", "completed", now, now);
    
    // Second step is still running
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(stepId2, runId, "2", "test-agent-2", 1, "Test template", "Test expects", "running", now, now);
    
    // Run cleanup
    cleanupCompletedSessions();
    
    // Check that only the completed session was removed
    const sessions = db.prepare("SELECT agent_id FROM daemon_active_sessions ORDER BY agent_id").all() as { agent_id: string }[];
    assert.equal(sessions.length, 1, "Should have one remaining session");
    assert.equal(sessions[0].agent_id, agentId2, "Should have kept the running session");
  });

  it("should clean up stale sessions", () => {
    const db = getDb();
    
    // Insert a run record for the foreign key
    const runId = "test-run-1";
    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, "test-workflow", "Test task", "running", "{}", now, now);
    
    // Insert some active sessions with different timestamps
    const agentId1 = "test-workflow_test-agent-1";
    const stepId1 = "test-step-1";
    const agentId2 = "test-workflow_test-agent-2";
    const stepId2 = "test-step-2";
    
    // Recent session (should not be cleaned up)
    const recentTime = now;
    
    // Old session (should be cleaned up)
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    
    // Insert recent session
    db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId1, stepId1, runId, recentTime);
    
    // Insert old session
    db.prepare(
      "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
    ).run(agentId2, stepId2, runId, oldTime);
    
    // Run stale cleanup
    cleanupStaleSessions();
    
    // Check that only the recent session remains
    const sessions = db.prepare("SELECT agent_id FROM daemon_active_sessions ORDER BY agent_id").all() as { agent_id: string }[];
    assert.equal(sessions.length, 1, "Should have one remaining session");
    assert.equal(sessions[0].agent_id, agentId1, "Should have kept the recent session");
  });
});