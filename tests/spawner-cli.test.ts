/**
 * Tests for the `antfarm spawner` CLI commands.
 * Verifies spawner command group functionality.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "cli", "cli.js");

describe("antfarm spawner (CLI)", () => {
  let tempDir: string;
  
  before(() => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), "antfarm-spawner-cli-test-" + Date.now());
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

  it("shows spawner commands in help output", () => {
    try {
      execFileSync("node", [CLI, "--help"], { encoding: "utf-8" });
      assert.fail("Help command should exit with code 1");
    } catch (error: any) {
      // Help command exits with code 1, so we need to check stderr
      const output = error.stdout || error.stderr;
      assert.ok(output.includes("antfarm spawner"), "help should mention spawner commands");
      assert.ok(output.includes("spawner [start] [--interval N]"), "help should show spawner start syntax");
      assert.ok(output.includes("spawner stop"), "help should show spawner stop syntax");
      assert.ok(output.includes("spawner status"), "help should show spawner status syntax");
    }
  });

  it("rejects invalid interval values", () => {
    try {
      execFileSync("node", [CLI, "spawner", "start", "--interval", "5000"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have thrown an error for invalid interval");
    } catch (error: any) {
      assert.ok(error.stderr.includes("Interval must be at least 10000ms"), 
                "Should show error for intervals less than 10000ms");
    }
  });

  it("accepts valid interval values", () => {
    try {
      // Try with a valid interval (but expect it to fail because we can't actually start the daemon in tests)
      execFileSync("node", [CLI, "spawner", "start", "--interval", "15000"], { 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.fail("Should have shown an error about daemon failing to start");
    } catch (error: any) {
      // This is expected - we can't actually start the daemon in tests
      // But we want to make sure it didn't reject the interval value
      assert.ok(!error.stderr.includes("Interval must be at least 10000ms"), 
                "Should not reject valid interval values");
    }
  });

  it("shows proper status when daemon is not running", () => {
    const output = execFileSync("node", [CLI, "spawner", "status"], { encoding: "utf-8" });
    assert.ok(output.includes("Spawner daemon is not running"), 
              "Should show that daemon is not running");
  });

  it("shows proper message when trying to stop daemon that is not running", () => {
    const output = execFileSync("node", [CLI, "spawner", "stop"], { encoding: "utf-8" });
    assert.ok(output.includes("Spawner daemon is not running"), 
              "Should show that daemon is not running when trying to stop");
  });

  it("supports workflow run with --scheduler=daemon flag", () => {
    // Test that the CLI accepts the flag (we can't actually run a workflow in tests)
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
});