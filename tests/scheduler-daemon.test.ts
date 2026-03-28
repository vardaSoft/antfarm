import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getDb } from "../dist/db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

test("Database migration adds scheduler column to runs table", async (t) => {
  // Create a temporary database for testing
  const tempDir = path.join(os.tmpdir(), "antfarm-test-" + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    // Set up temporary database
    const originalHome = process.env.HOME;
    const tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    
    // Force re-import of db module to use the new HOME
    const dbModule = await import("../dist/db.js");
    const db = dbModule.getDb();
    
    // Check that scheduler column exists (should be added by migration)
    const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has("scheduler"), "runs table should have scheduler column");
    
    // Clean up
    process.env.HOME = originalHome;
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }
});

test("runWorkflow saves scheduler choice to database", async (t) => {
  // Create a temporary database for testing
  const tempDir = path.join(os.tmpdir(), "antfarm-test-" + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    // Set up temporary database
    const originalHome = process.env.HOME;
    const tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    
    // Force re-import of db module to use the new HOME
    const dbModule = await import("../dist/db.js");
    const db = dbModule.getDb();
    
    // Insert a test run directly into the database with scheduler value
    const runId = randomUUID();
    const now = new Date().toISOString();
    const insertRun = db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, scheduler, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertRun.run(runId, 1, "test-workflow", "Test task", "running", "{}", "daemon", now, now);
    
    // Check that the scheduler choice was saved to the database
    const run = db.prepare("SELECT scheduler FROM runs WHERE id = ?").get(runId) as { scheduler: string };
    assert.ok(run, "Run should exist in database");
    assert.equal(run.scheduler, "daemon", "Scheduler choice should be saved to database");
    
    // Test with cron scheduler
    const runId2 = randomUUID();
    insertRun.run(runId2, 2, "test-workflow-2", "Test task 2", "running", "{}", "cron", now, now);
    
    const run2 = db.prepare("SELECT scheduler FROM runs WHERE id = ?").get(runId2) as { scheduler: string };
    assert.ok(run2, "Second run should exist in database");
    assert.equal(run2.scheduler, "cron", "Scheduler choice should be saved to database");
    
    // Test with null scheduler (should default to cron)
    const runId3 = randomUUID();
    const insertRunWithoutScheduler = db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertRunWithoutScheduler.run(runId3, 3, "test-workflow-3", "Test task 3", "running", "{}", now, now);
    
    const run3 = db.prepare("SELECT scheduler FROM runs WHERE id = ?").get(runId3) as { scheduler: string | null };
    assert.ok(run3, "Third run should exist in database");
    assert.equal(run3.scheduler, null, "Scheduler should be null when not specified");
    
    // Clean up
    process.env.HOME = originalHome;
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }
});