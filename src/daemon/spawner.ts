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

// ========================================
// Gateway Call CLI Parameters (v2.1)
// ========================================
interface GatewayCallParams {
  idempotencyKey: string;
  agentId: string;
  sessionKey: string;
  message: string;
  timeout: number;
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high';
}

interface GatewayCallResponse {
  runId?: string;
  status?: string;
  sessionId?: string;
  acceptedAt?: number;
  error?: string;
}

// ========================================
// Gateway Status Response Interfaces (NEU v2.1)
// ========================================
interface AgentSessionInfo {
  agentId: string;
  recent?: Array<{
    key: string;
    sessionId: string;
    status?: string;
    startedAt?: number;
    [key: string]: any;
  }>;
}

interface GatewayStatusResponse {
  sessions?: {
    byAgent?: AgentSessionInfo[];
  };
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
    // Check if there's already a story running for this loop step
    if (loopStep.current_story_id) {
      const currentStory = db.prepare(
        "SELECT status FROM stories WHERE id = ?"
      ).get(loopStep.current_story_id) as { status: string } | undefined;
      
      if (currentStory && currentStory.status === 'running') {
        // A story is already running, don't claim another one
        return { spawned: false, reason: "story_already_running" };
      }
    }
    
    // Try to atomically claim a story for the running loop step
    const storyClaim = claimStory(agentId, loopStep.id);
    
    if (storyClaim && storyClaim.found && storyClaim.storyId) {
      return await spawnForClaimed(agentId, workflow, storyClaim, loopStep.id, source);
    }
  }

  return { spawned: false, reason: "no_work" };
}

// ========================================
// Gateway Session ID Query Helper (v2.1)
// ========================================
/**
 * Query Gateway status to find actual sessionId for a given sessionKey
 * Retries up to 5 times with 1s delay between attempts
 *
 * Returns the actual session UUID if found, null otherwise
 *
 * v2.1 Improvements:
 * - Type-safe with GatewayStatusResponse interface
 * - Debug logging on failures (on last attempt)
 * - Attempt number logging for visibility
 */
async function getSessionIdFromGateway(
  sessionKey: string,
  agentId: string,
  maxRetries: number = 5,
  retryDelayMs: number = 1000
): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const openclawBin = await findOpenclawBinary();
      const isNpx = openclawBin.startsWith("npx");

      const args = isNpx
        ? ["openclaw", "gateway", "call", "status", "--json"]
        : ["gateway", "call", "status", "--json"];

      const child = execFile(openclawBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000  // ⚠️ v2.1: Gateway status query timeout
      } as any);

      let stdoutData = '';
      child.stdout?.on('data', (data) => { stdoutData += data.toString(); });

      const result = await new Promise<{ sessionId?: string; error?: string }>((resolve) => {
        child.on('close', (code) => {
          if (code === 0) {
            try {
              // ⚠️ v2.1: Type-safe parsing with GatewayStatusResponse
              const statusData: GatewayStatusResponse = JSON.parse(stdoutData.trim());

              // Check if sessions.byAgent exists
              if (statusData.sessions?.byAgent) {
                // ⚠️ v2.1: Type-safe find (no 'any' casting)
                const agentSessions: AgentSessionInfo | undefined =
                  statusData.sessions.byAgent.find((a: AgentSessionInfo) => a.agentId === agentId);

                if (agentSessions?.recent) {
                  const matchingSession = agentSessions.recent.find((s: any) =>
                    s.key === sessionKey && s.sessionId
                  );

                  if (matchingSession?.sessionId) {
                    // ⚠️ v2.1: Log attempt number on success
                    console.log(`[spawnAgentSession] Session ID found on attempt ${attempt + 1}: ${matchingSession.sessionId}`);
                    resolve({ sessionId: matchingSession.sessionId });
                    return;
                  }
                }
              }

              // ⚠️ v2.1: Debug logging on failure
              console.warn(`[getSessionIdFromGateway] Session not found (attempt ${attempt + 1}/${maxRetries})`);

              // On last attempt, log full response for debugging
              if (attempt === maxRetries - 1) {
                console.warn(`[getSessionIdFromGateway] Full response:`, JSON.stringify(statusData, null, 2));
              }

              resolve({ error: 'Session not found' });

            } catch (e) {
              console.error(`[getSessionIdFromGateway] Parse error on attempt ${attempt + 1}:`, e);
              resolve({ error: String(e) });
            }
          } else {
            console.error(`[getSessionIdFromGateway] Gateway call failed with code ${code} on attempt ${attempt + 1}`);
            resolve({ error: `Failed with code ${code}` });
          }
        });

        child.on('error', (err) => {
          console.error(`[getSessionIdFromGateway] Child error on attempt ${attempt + 1}:`, err);
          resolve({ error: err.message });
        });
      });

      if (result.sessionId) return result.sessionId;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    } catch (error) {
      console.error(`[getSessionIdFromGateway] Exception on attempt ${attempt + 1}:`, error);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }

  console.warn(`[getSessionIdFromGateway] Failed to retrieve sessionId after ${maxRetries} attempts`);
  return null;
}

/**
 * Spawn an OpenClaw agent session via gateway API with the specified parameters.
 * Records the session in the daemon_active_sessions table before spawning.
 */
// ========================================
// Agent Session Spawner (v2.1)
// ========================================
/**
 * Spawn an OpenClaw agent session via openclaw gateway call agent CLI.
 * Records the session in the daemon_active_sessions table before spawning.
 *
 * v2.1 Changes:
 * - No model parameter (Gateway validates internally)
 * - Full work prompt with completion instructions
 * - Extended logging (including idempotencyKey)
 * - Actual sessionId query via getSessionIdFromGateway
 *
 * @param agentId - Agent to spawn
 * @param stepId - Step ID for tracking
 * @param runId - Workflow run ID
 * @param input - Resolved task instructions
 * @param timeoutSeconds - Agent execution timeout (default: 1800s)
 * @param storyId - Optional story ID for loop steps
 * @returns Session ID (actual UUID from Gateway)
 */
export async function spawnAgentSession(
  agentId: string,
  stepId: string,
  runId: string,
  input: string,
  timeoutSeconds: number,  // ✅ NO model parameter
  storyId?: string
): Promise<{ sessionId?: string }> {

  // ========================================
  // 1. Generate unique identifiers
  // ========================================
  const idempotencyKey = `antfarm:${runId}:${stepId}:${storyId || 'root'}:${Math.random().toString(36).substring(7)}`;
  const sessionKey = `agent:${agentId}:workflow:${runId}:${stepId}`;

  console.log(`[spawnAgentSession] IdempotencyKey: ${idempotencyKey}`);  // ⚠️ v2.1: NEW logging

  // ========================================
  // 2. Build work prompt with completion instructions
  // ========================================
  const antfarmPath = path.join(os.homedir(), ".openclaw", "antfarm", "bin", "antfarm");
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
cat /tmp/antfarm-step-output.txt | node ${antfarmPath} step complete "${stepId}"
\`\`\`

If the work FAILED:
\`\`\`
node ${antfarmPath} step fail "${stepId}" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.

INPUT:
${input}`;

  // ========================================
  // 3. Prepare Gateway Call parameters
  // ========================================
  const gatewayParams: GatewayCallParams = {
    idempotencyKey,
    agentId: agentId,
    sessionKey: sessionKey,
    message: workPrompt,
    timeout: timeoutSeconds,
    thinking: 'high'
  };

  try {
    const openclawBin = await findOpenclawBinary();

    // ========================================
    // 4. Log spawn attempt (v2.1: extended)
    // ========================================
    console.log(`[spawnAgentSession] Spawning agent ${agentId} via Gateway Call CLI`);
    console.log(`[spawnAgentSession] SessionKey: ${sessionKey}`);
    console.log(`[spawnAgentSession] Agent ID: ${agentId}`);
    console.log(`[spawnAgentSession] Timeout: ${timeoutSeconds}s`);
    console.log(`[spawnAgentSession] Story ID: ${storyId || 'none (single step)'}`);

    // ========================================
    // 5. Execute Gateway Call CLI
    // ========================================
    const isNpx = openclawBin.startsWith("npx");
    const args = isNpx
      ? ["openclaw", "gateway", "call", "agent", "--params", JSON.stringify(gatewayParams), "--json"]
      : ["gateway", "call", "agent", "--params", JSON.stringify(gatewayParams), "--json"];

    console.log(`[spawnAgentSession] Executing: ${isNpx ? 'npx' : openclawBin} gateway call agent --params '...' --json`);

    const child = execFile(openclawBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000  // 30 seconds for spawn command itself (not agent execution)
    } as any);

    let stdoutData = '';
    child.stdout?.on('data', (data) => { stdoutData += data.toString(); });

    const result = await new Promise<{ runId?: string; error?: string }>((resolve) => {
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const response: GatewayCallResponse = JSON.parse(stdoutData.trim());

            if (response.status === 'accepted' && response.runId) {
              console.log(`[spawnAgentSession] Gateway accepted (runId: ${response.runId})`);
              resolve({ runId: response.runId });
            } else {
              const errorMsg = `Unexpected response: ${JSON.stringify(response)}`;
              console.error(`[spawnAgentSession] ${errorMsg}`);
              resolve({ error: errorMsg });
            }
          } catch (e) {
            const errorMsg = `Failed to parse response: ${e}`;
            console.error(`[spawnAgentSession] ${errorMsg}`);
            resolve({ error: errorMsg });
          }
        } else {
          const errorMsg = `Gateway call failed with code ${code}`;
          console.error(`[spawnAgentSession] ${errorMsg}`);
          resolve({ error: errorMsg });
        }
      });

      child.on('error', (err) => {
        const errorMsg = `Gateway call error: ${err.message}`;
        console.error(`[spawnAgentSession] ${errorMsg}`);
        resolve({ error: errorMsg });
      });
    });

    if (result.error) throw new Error(result.error);

    // ========================================
    // 6. Query for actual sessionId (v2.1: with detailed logging)
    // ========================================
    console.log(`[spawnAgentSession] Querying Gateway for actual sessionId...`);
    const actualSessionId = await getSessionIdFromGateway(sessionKey, agentId);

    const sessionId = actualSessionId || result.runId;

    if (actualSessionId) {
      console.log(`[spawnAgentSession] ✅ Retrieved actual sessionId: ${actualSessionId}`);
    } else {
      console.warn(`[spawnAgentSession] ⚠️ Using runId as fallback: ${result.runId}`);
    }

    return { sessionId };

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[spawnAgentSession] ❌ Failed: ${errMsg}`);
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

  // 3. Fall back to npx openclaw (FIXED from v1)
  return "npx openclaw";
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
    // Get the agent configuration to determine the timeout (model removed in v2.1)
    const timeoutSeconds = agent.timeoutSeconds || 1800;

    // Spawn the session (no model parameter, storyId added)
    const result = await spawnAgentSession(
      agentId,
      stepId,
      claim.runId!,
      claim.resolvedInput!,
      timeoutSeconds,  // ✅ 5. parameter (was 6.)
      claim.storyId    // ✅ NEW: storyId parameter
    );
    
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