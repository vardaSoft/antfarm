import { test } from "node:test";
import { strict as assert } from "node:assert";

// Simple test to verify the daemon module can be imported without errors
test("daemon module imports successfully", async () => {
  // This test ensures that the daemon.js file is syntactically correct and can be imported
  const daemonModule = await import("../dist/daemon/daemon.js");
  assert.ok(daemonModule);
  assert.ok(typeof daemonModule.startDaemon === "function");
  assert.ok(typeof daemonModule.stopDaemon === "function");
});

test("daemon functions exist", async () => {
  const { startDaemon, stopDaemon } = await import("../dist/daemon/daemon.js");
  
  // Verify that the functions exist and are callable
  assert.ok(typeof startDaemon === "function");
  assert.ok(typeof stopDaemon === "function");
});