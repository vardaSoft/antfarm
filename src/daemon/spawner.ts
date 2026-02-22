import { getDb } from "../db.js";
import { peekStep, claimStep, claimStory } from "../installer/step-ops.js";
import { emitEvent } from "../installer/events.js";
import type { WorkflowSpec } from "../installer/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GatewayConfig {
  url: string;
  secret?: string;
}

async function getGatewayConfig(): Promise<GatewayConfig | null> {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(await fs.promises.readFile(configPath, "utf-8"));
    if (config.gateway?.url) {
      return {
        url: config.gateway.url,
        secret: config.gateway.secret
      };
    }
  } catch {
    // Config not found or invalid, fall back to CLI
  }
  return null;
}

interface SpawnResult {
  spawned: boolean;
  sessionId?: string;
  stepId?: string;
  runId?: string;
  storyId?: string;  // ADDED
  spawnedBy?: 'daemon' | 'cron';
  reason?: string;
  error?: string;
  rollback?: boolean;
}

interface ActiveSession {
  agent_id: string;
  step_id: string;
  run_id: string;
  spawned_at: string;
}

export async function peekAndSpawn(
  agentId: string, 
  workflow: WorkflowSpec,
  source: 'daemon' | 'cron' = 'daemon'
): Promise<SpawnResult> {
  const db = getDb();

  // First, try to claim a single step (this includes its own peek internally)
  const claimResult = claimStep(agentId);
  
  if (claimResult.found) {
    if (!claimResult.stepId || !claimResult.runId || !claimResult.resolvedInput) {
      throw new Error("Claimed step missing required fields");
    }
    
    const { stepId, runId, resolvedInput } = claimResult;
    return await spawnForClaimed(agentId, workflow, claimResult, stepId, source);
  }

  // If no single step was claimed, check for loop steps with pending stories
  const loopStep = db.prepare(
    "SELECT * FROM steps WHERE agent_id = ? AND type = 'loop' AND status = 'running' LIMIT 1"
  ).get(agentId) as any;

  if (loopStep) {
    // Try to atomically claim a story for the running loop step
    const storyClaim = claimStory(agentId, loopStep.id);
    
    if (storyClaim && storyClaim.found && storyClaim.storyId) {
      return await spawnForClaimed(agentId, workflow, storyClaim, loopStep.id, source);
    }
  }

  return { spawned: false, reason: "no_work" };
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
  model: string,
  timeoutSeconds: number
): Promise<{ sessionId?: string }> {
  // Try Gateway API first
  try {
    const gateway = await getGatewayConfig();
    if (gateway) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (gateway.secret) headers['Authorization'] = `Bearer ${gateway.secret}`;

      const response = await fetch(`${gateway.url}/api/tools/call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tool: 'sessions_spawn',
          args: {
            task: input,
            agent_id: agentId,
            model: model,
            thinking: 'high',
            timeout_ms: timeoutSeconds * 1000
          }
        })
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`Spawned agent session via Gateway API for ${agentId}`);
        return { sessionId: result.sessionId || result.id };
      } else {
        console.warn(`Gateway API returned status ${response.status}, falling back to CLI`);
      }
    }
  } catch (err) {
    console.warn('Gateway API failed, falling back to CLI:', err);
  }

  // Fallback to CLI
  return await spawnAgentSessionCLI(agentId, stepId, runId, input, model, timeoutSeconds);
}

/**
 * Spawn an OpenClaw agent session via CLI with the specified parameters.
 * Records the session in the daemon_active_sessions table before spawning.
 */
async function spawnAgentSessionCLI(
  agentId: string, 
  stepId: string, 
  runId: string, 
  input: string, 
  model: string,
  timeoutSeconds: number
): Promise<{ sessionId?: string }> {
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
    "--timeout", String(timeoutSeconds),
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
    
    // Capture stdout to extract session ID
    let stdoutData = '';
    child.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });
    
    // Wait for the process to complete and get session ID
    const sessionId = await new Promise<string | null>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          // Try to extract session ID from stdout
          const match = stdoutData.match(/session_id["']?\s*:\s*["']?([a-zA-Z0-9-]+)/);
          resolve(match ? match[1] : null);
        } else {
          reject(new Error(`OpenClaw session spawn failed with code ${code}`));
        }
      });
      
      child.on('error', (err) => {
        reject(err);
      });
    });
    
    return { sessionId: sessionId || undefined };
  } catch (error) {
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
 * Removes entries older than 15 minutes.
 */
export function cleanupStaleSessions(): void {
  const db = getDb();
  
  // Calculate the cutoff time (15 minutes ago)
  const cutoffTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  
  // Find stale sessions
  const staleSessions = db.prepare(`
    SELECT agent_id, step_id, story_id
    FROM daemon_active_sessions 
    WHERE spawned_at < ?
  `).all(cutoffTime) as { agent_id: string; step_id: string; story_id: string | null }[];
  
  // Remove stale sessions from the active sessions table
  for (const session of staleSessions) {
    db.prepare(
      "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ? AND COALESCE(story_id, '') = COALESCE(?, '')"
    ).run(session.agent_id, session.step_id, session.story_id || '');
  }
  
  if (staleSessions.length > 0) {
    console.log(`Cleaned up ${staleSessions.length} stale sessions`);
  }
}

/**
 * Spawn agent session for a claimed step or story.
 * Handles cleanup, error rollback, and session tracking.
 */
async function spawnForClaimed(
  agentId: string,
  workflow: WorkflowSpec,
  claim: { found: boolean; stepId?: string; runId?: string; resolvedInput?: string; storyId?: string },
  stepId: string,
  source: 'daemon' | 'cron'
): Promise<SpawnResult> {
  const db = getDb();
  const agent = workflow.agents.find((a: any) => `${workflow.id}_${a.id}` === agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  try {
    // Get the agent configuration to determine the model and timeout
    const model = agent.model || "default";
    const timeoutSeconds = agent.timeoutSeconds || 1800;

    // Spawn the session
    const result = await spawnAgentSession(agentId, stepId, claim.runId!, claim.resolvedInput!, model, timeoutSeconds);
    
    if (!result.sessionId) {
      throw new Error(`Failed to spawn session: ${JSON.stringify(result)}`);
    }

    // Update step/story to 'running' AFTER successful spawn
    if (claim.storyId) {
      // Story: claiming → running
      db.prepare(
        "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ?"
      ).run(claim.storyId);

      // Emit story.started event (after spawn success)
      const step = db.prepare("SELECT step_id, run_id FROM steps WHERE id = ?").get(stepId) as any;
      const story = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(claim.storyId) as any;
      const wfId = getWorkflowId(step.run_id);
      
      emitEvent({ 
        ts: new Date().toISOString(), 
        event: "story.started",
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        agentId,
        storyId: story.story_id,
        storyTitle: story.title
      });
    } else {
      // Single step: claiming → running
      db.prepare(
        "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
      ).run(stepId);

      // Emit step.running event (after spawn success)
      const step = db.prepare("SELECT step_id, run_id FROM steps WHERE id = ?").get(stepId) as any;
      const wfId = getWorkflowId(step.run_id);
      
      emitEvent({ 
        ts: new Date().toISOString(), 
        event: "step.running",
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        agentId,
        sessionId: result.sessionId
      });
    }

    // Record session in daemon_active_sessions
    db.prepare(
      `INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, story_id, spawned_at, spawned_by, session_id)
       VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`
    ).run(agentId, stepId, claim.runId!, claim.storyId || null, source, result.sessionId);

    return { 
      spawned: true, 
      sessionId: result.sessionId,
      stepId: stepId,
      runId: claim.runId!,
      storyId: claim.storyId || undefined,
      spawnedBy: source
    };

  } catch (error) {
    // Rollback on spawn failure
    console.error(`Failed to spawn session for ${agentId}: ${error}`);
    
    if (claim.storyId) {
      // Revert story to 'pending'
      db.prepare(
        "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'claiming'"
      ).run(claim.storyId);
      
      // Clear step's current_story_id only if it matches the story we're rolling back
      db.prepare(
        "UPDATE steps SET current_story_id = NULL WHERE id = ? AND current_story_id = ?"
      ).run(stepId, claim.storyId);
    } else {
      // Revert step to 'pending'
      db.prepare(
        "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'claiming'"
      ).run(stepId);
    }

    return { 
      spawned: false, 
      error: error instanceof Error ? error.message : String(error),
      rollback: true
    };
  }
}

// Helper function to get workflow ID (needed for event emission)
function getWorkflowId(runId: string): string | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    return row?.workflow_id;
  } catch { return undefined; }
}