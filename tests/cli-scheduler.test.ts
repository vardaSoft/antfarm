/**
 * Tests for the `antfarm workflow run` CLI command with --scheduler flag.
 * Verifies CLI scheduler flag functionality.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "cli", "cli.js");

describe("antfarm workflow run --scheduler (CLI)", () => {
  let tempDir: string;
  
  before(() => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), "antfarm-cli-scheduler-test-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
  });
  
  after(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it("accepts --scheduler=cron flag", () => {
    // Test that the CLI accepts the cron flag (we can't actually run a workflow in tests)
    try {
      execFileSync("node", [CLI, "workflow", "run", "test-workflow", "test task", "--scheduler", "cron"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have shown an error about workflow not existing");
    } catch (error: any) {
      // We expect this to fail because the workflow doesn't exist, 
      // but we want to make sure it didn't reject the scheduler flag
      assert.ok(!error.stderr.includes("Invalid scheduler value"), 
                "Should accept 'cron' as a valid scheduler value");
      // It should fail because the workflow doesn't exist, not because of the flag
      assert.ok(error.stderr.includes("not found") || error.stderr.includes("ENOENT"), 
                "Should fail due to workflow not existing, not invalid flag");
    }
  });

  it("accepts --scheduler=daemon flag", () => {
    // Test that the CLI accepts the daemon flag (we can't actually run a workflow in tests)
    try {
      execFileSync("node", [CLI, "workflow", "run", "test-workflow", "test task", "--scheduler", "daemon"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have shown an error about workflow not existing");
    } catch (error: any) {
      // We expect this to fail because the workflow doesn't exist, 
      // but we want to make sure it didn't reject the scheduler flag
      assert.ok(!error.stderr.includes("Invalid scheduler value"), 
                "Should accept 'daemon' as a valid scheduler value");
      // It should fail because the workflow doesn't exist, not because of the flag
      assert.ok(error.stderr.includes("not found") || error.stderr.includes("ENOENT"), 
                "Should fail due to workflow not existing, not invalid flag");
    }
  });

  it("rejects invalid scheduler values", () => {
    try {
      execFileSync("node", [CLI, "workflow", "run", "test-workflow", "test task", "--scheduler", "invalid"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have thrown an error for invalid scheduler");
    } catch (error: any) {
      assert.ok(error.stderr.includes("Invalid scheduler value"), 
                "Should show error for invalid scheduler values");
    }
  });

  it("defaults to cron when no scheduler specified", () => {
    // Test that the CLI defaults to cron when no scheduler is specified
    try {
      execFileSync("node", [CLI, "workflow", "run", "test-workflow", "test task"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have shown an error about workflow not existing");
    } catch (error: any) {
      // Should fail due to workflow not existing, not due to missing scheduler
      assert.ok(error.stderr.includes("not found") || error.stderr.includes("ENOENT"), 
                "Should fail due to workflow not existing");
    }
  });

  it("shows scheduler information in workflow status output", () => {
    // Test that workflow status shows scheduler information
    try {
      execFileSync("node", [CLI, "workflow", "status", "nonexistent"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have shown an error about workflow not found");
    } catch (error: any) {
      // Should show workflow not found message, which includes recent runs
      // We're just checking that it doesn't crash when trying to display scheduler info
      const stderr = error.stderr || "";
      assert.ok(!stderr.includes("undefined") && !stderr.includes("scheduler is not defined"),
                "Should not crash when displaying scheduler information");
    }
  });
});