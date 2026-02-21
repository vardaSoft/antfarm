import { getDb } from "../db.js";
import { peekStep, claimStep } from "../installer/step-ops.js";
import type { WorkflowSpec } from "../installer/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface SpawnResult {
  spawned: boolean;
  stepId?: string;
}

interface ActiveSession {
  agent_id: string;
  step_id: string;
  run_id: string;
  spawned_at: string;
}

/**
 * Lightweight check: does this agent have any pending/waiting steps in active runs?
 * Unlike claimStep(), this runs a single cheap COUNT query — no cleanup, no context resolution.
 * Returns "HAS_WORK" if any pending/waiting steps exist, "NO_WORK" otherwise.
 */
export async function peekAndSpawn(agentId: string, workflow: WorkflowSpec): Promise<SpawnResult> {
  // First check if there's any work using the lightweight peek operation
  const peekResult = peekStep(agentId);
  
  if (peekResult === "NO_WORK") {
    // No work available, return without spawning any sessions
    return { spawned: false };
  }
  
  // Check if there's already an active session for this agent
  const db = getDb();
  const existingSession = db.prepare(
    "SELECT agent_id FROM daemon_active_sessions WHERE agent_id = ?"
  ).get(agentId) as ActiveSession | undefined;
  
  if (existingSession) {
    console.warn(`Skipping spawn for ${agentId} - agent already has active session`);
    return { spawned: false };
  }
  
  // Work is available and no active session exists, claim the step to get the actual work
  const claimResult = claimStep(agentId);
  
  if (!claimResult.found) {
    // No work found after claiming (race condition), return without spawning
    return { spawned: false };
  }
  
  // Work was successfully claimed, spawn an agent session
  if (!claimResult.stepId || !claimResult.runId || !claimResult.resolvedInput) {
    throw new Error("Claimed step missing required fields");
  }
  
  // Get the agent configuration to determine the model
  const agent = workflow.agents.find(a => a.id === agentId.split('_')[1]);
  const model = agent?.model ?? "default";
  
  // Spawn the agent session
  await spawnAgentSession(agentId, claimResult.stepId, claimResult.runId, claimResult.resolvedInput, model);
  
  // Return that we spawned a session
  return { spawned: true, stepId: claimResult.stepId };
}

/**
 * Spawn an OpenClaw agent session via gateway API with the specified parameters.
 * Records the session in the daemon_active_sessions table before spawning.
 */
export async function spawnAgentSession(
  agentId: string, 
  stepId: string, 
  runId: string, 
  input: string, 
  model: string
): Promise<void> {
  // Record the active session in the database before spawning
  const db = getDb();
  const now = new Date().toISOString();
  
  // Insert into daemon_active_sessions table
  db.prepare(
    "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
  ).run(agentId, stepId, runId, now);
  
  // Build the work prompt similar to what's used in agent-cron.ts
  const cli = path.join(os.homedir(), ".openclaw", "antfarm", "bin", "antfarm");
  const workPrompt = `You are an Antfarm workflow agent. Execute the pending work below.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

The claimed step JSON is provided below. It contains: {"stepId": "${stepId}", "runId": "${runId}", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with KEY: value lines as specified.

MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "${stepId}"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "${stepId}" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.

INPUT:
${input}`;

  // Find the openclaw binary
  const openclawBin = await findOpenclawBinary();
  
  // Prepare the spawn command arguments
  const args = [
    "sessions", 
    "spawn",
    "--agent", agentId,
    "--model", model,
    "--think", "high",
    "--timeout", "1800", // 30 minutes default timeout
  ];
  
  try {
    // Spawn the session using the openclaw CLI
    const child = execFile(openclawBin, args, { 
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000 // 30 second timeout for the spawn command itself
    } as any);
    
    // Send the work prompt to stdin
    child.stdin?.write(workPrompt);
    child.stdin?.end();
    
    // Wait for the process to complete
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        // Remove the session record when the process completes (regardless of success/failure)
        db.prepare(
          "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
        ).run(agentId, stepId);
        
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`OpenClaw session spawn failed with code ${code}`));
        }
      });
      
      child.on('error', (err) => {
        // Remove the session record if there was an error
        db.prepare(
          "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
        ).run(agentId, stepId);
        
        reject(err);
      });
    });
  } catch (error) {
    // Remove the session record if spawning failed
    db.prepare(
      "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
    ).run(agentId, stepId);
    
    throw error;
  }
}

/** Locate the openclaw binary. Checks PATH, then ~/.npm-global/bin, then npx. */
async function findOpenclawBinary(): Promise<string> {
  // 1. Check PATH via `which`
  try {
    const { stdout } = await execFileAsync("which", ["openclaw"]);
    if (stdout.trim()) return stdout.trim();
  } catch { /* skip */ }

  // 2. Check common global install locations
  const candidates = [
    path.join(os.homedir(), ".npm-global", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/opt/homebrew/bin/openclaw",
  ];
  
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* skip */ }
  }

  // 3. Fall back to npx
  return "npx";
}

/**
 * Clean up completed sessions from the daemon_active_sessions table.
 * This should be called periodically to remove stale entries.
 */
export function cleanupCompletedSessions(): void {
  const db = getDb();
  
  // Find sessions whose steps are no longer running
  const completedSessions = db.prepare(`
    SELECT s.agent_id, s.step_id 
    FROM daemon_active_sessions s
    LEFT JOIN steps st ON s.step_id = st.id
    WHERE st.status NOT IN ('pending', 'running') OR st.status IS NULL
  `).all() as { agent_id: string; step_id: string }[];
  
  // Remove completed sessions from the active sessions table
  for (const session of completedSessions) {
    db.prepare(
      "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
    ).run(session.agent_id, session.step_id);
  }
}

/**
 * Clean up stale sessions from the daemon_active_sessions table.
 * Removes entries older than 45 minutes (30 min timeout + 15 min buffer).
 */
export function cleanupStaleSessions(): void {
  const db = getDb();
  
  // Calculate the cutoff time (45 minutes ago)
  const cutoffTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  
  // Find stale sessions
  const staleSessions = db.prepare(`
    SELECT agent_id, step_id 
    FROM daemon_active_sessions 
    WHERE spawned_at < ?
  `).all(cutoffTime) as { agent_id: string; step_id: string }[];
  
  // Remove stale sessions from the active sessions table
  for (const session of staleSessions) {
    db.prepare(
      "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
    ).run(session.agent_id, session.step_id);
  }
  
  if (staleSessions.length > 0) {
    console.log(`Cleaned up ${staleSessions.length} stale sessions`);
  }
}