#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDaemon } from "./daemon.js";

// Parse command line arguments
const args = process.argv.slice(2);
let intervalMs = 30000; // default 30 seconds
let workflowIds = undefined;

// Parse --interval argument
const intervalIndex = args.indexOf("--interval");
if (intervalIndex !== -1 && args[intervalIndex + 1]) {
  intervalMs = parseInt(args[intervalIndex + 1], 10) || 30000;
}

// Parse --workflows argument
const workflowsIndex = args.indexOf("--workflows");
if (workflowsIndex !== -1 && args[workflowsIndex + 1]) {
  const workflowsStr = args[workflowsIndex + 1];
  workflowIds = workflowsStr.split(",").map(id => id.trim()).filter(id => id.length > 0);
}

// PID file path
const PID_DIR = path.join(os.homedir(), ".openclaw", "antfarm");
const PID_FILE = path.join(PID_DIR, "spawner.pid");

// Ensure PID directory exists
fs.mkdirSync(PID_DIR, { recursive: true });

// Write PID file
fs.writeFileSync(PID_FILE, String(process.pid));

// Setup graceful shutdown handlers
process.on("SIGTERM", () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
});

console.log(`Starting Antfarm spawner daemon with ${intervalMs}ms polling interval`);
if (workflowIds) {
  console.log(`Monitoring workflows: ${workflowIds.join(", ")}`);
}

// Start the daemon
startDaemon(intervalMs, workflowIds).catch(error => {
  console.error("Failed to start daemon:", error);
  process.exit(1);
});