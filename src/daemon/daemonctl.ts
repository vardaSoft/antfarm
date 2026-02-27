import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getSpawnerPidFile(): string {
  return path.join(os.homedir(), ".openclaw", "antfarm", "spawner.pid");
}

export function getSpawnerLogFile(): string {
  return path.join(os.homedir(), ".openclaw", "antfarm", "spawner.log");
}

export function isRunning(): { running: true; pid: number } | { running: false } {
  const pidFile = getSpawnerPidFile();
  if (!fs.existsSync(pidFile)) return { running: false };
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}

export async function startDaemon(options?: { 
  intervalMs?: number; 
  workflowIds?: string[] 
}): Promise<{ pid: number }> {
  // Validate interval
  if (options?.intervalMs !== undefined && options.intervalMs < 10000) {
    throw new Error("Interval must be at least 10000ms (10 seconds)");
  }

  const status = isRunning();
  if (status.running) {
    return { pid: status.pid };
  }

  const logFile = getSpawnerLogFile();
  const pidDir = path.dirname(getSpawnerPidFile());
  fs.mkdirSync(pidDir, { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  const daemonScript = path.resolve(__dirname, "..", "..", "dist", "daemon", "daemon.js");
  
  // Prepare arguments
  const args: string[] = [];
  if (options?.intervalMs !== undefined) {
    args.push("--interval", String(options.intervalMs));
  }
  if (options?.workflowIds !== undefined && options.workflowIds.length > 0) {
    args.push("--workflows", options.workflowIds.join(","));
  }

  const child = spawn("node", [daemonScript, ...args], {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();

  // Wait 1s then confirm
  await new Promise((r) => setTimeout(r, 1000));

  const check = isRunning();
  if (!check.running) {
    throw new Error("Daemon failed to start. Check " + logFile);
  }
  return { pid: check.pid };
}

export function stopDaemon(): boolean {
  const status = isRunning();
  if (!status.running) return false;
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {}
  try { fs.unlinkSync(getSpawnerPidFile()); } catch {}
  return true;
}

export function getSpawnerStatus(): { 
  running: boolean; 
  pid?: number; 
  intervalMs?: number; 
  monitoredWorkflows?: string[] 
} {
  const status = isRunning();
  if (!status.running) return { running: false };
  
  // Try to read additional info from log file or process
  // For now, we'll just return basic info
  return { running: true, pid: status.pid };
}