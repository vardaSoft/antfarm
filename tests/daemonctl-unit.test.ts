import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import our daemonctl functions
import { 
  getSpawnerPidFile, 
  getSpawnerLogFile, 
  isRunning, 
  startDaemon, 
  stopDaemon, 
  getSpawnerStatus 
} from "../dist/daemon/daemonctl.js";

describe("daemonctl unit tests", () => {
  let tempDir: string;
  
  before(() => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), "antfarm-daemonctl-test-" + Date.now());
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

  it("getSpawnerPidFile should return correct path", () => {
    const pidFile = getSpawnerPidFile();
    assert.ok(pidFile.endsWith(path.join(".openclaw", "antfarm", "spawner.pid")), 
              "PID file should end with correct path");
  });

  it("getSpawnerLogFile should return correct path", () => {
    const logFile = getSpawnerLogFile();
    assert.ok(logFile.endsWith(path.join(".openclaw", "antfarm", "spawner.log")), 
              "Log file should end with correct path");
  });

  it("isRunning should return { running: false } when no PID file exists", () => {
    // Temporarily override the PID file path to use our temp directory
    const originalGetSpawnerPidFile = getSpawnerPidFile;
    const testPidFile = path.join(tempDir, "test.pid");
    
    // Mock the function to return our test path
    (global as any).getSpawnerPidFile = () => testPidFile;
    
    const result = isRunning();
    assert.deepStrictEqual(result, { running: false }, 
                          "Should return { running: false } when no PID file exists");
    
    // Restore original function
    (global as any).getSpawnerPidFile = originalGetSpawnerPidFile;
  });

  it("getSpawnerStatus should return { running: false } when not running", () => {
    // Temporarily override the PID file path to use our temp directory
    const originalIsRunning = isRunning;
    
    // Mock isRunning to return false
    (global as any).isRunning = () => ({ running: false });
    
    const result = getSpawnerStatus();
    assert.deepStrictEqual(result, { running: false }, 
                          "Should return { running: false } when not running");
    
    // Restore original function
    (global as any).isRunning = originalIsRunning;
  });

  it("startDaemon should validate interval is >= 10000ms", async () => {
    await assert.rejects(
      async () => {
        await startDaemon({ intervalMs: 5000 });
      },
      /Interval must be at least 10000ms/,
      "Should throw error for intervals less than 10000ms"
    );
  });

  it("stopDaemon should return false when daemon is not running", () => {
    // Temporarily override isRunning to return false
    const originalIsRunning = isRunning;
    (global as any).isRunning = () => ({ running: false });
    
    const result = stopDaemon();
    assert.equal(result, false, "Should return false when daemon is not running");
    
    // Restore original function
    (global as any).isRunning = originalIsRunning;
  });
});