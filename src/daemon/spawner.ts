import { getDb, withTransaction } from "../db.js";
import type { DatabaseSync } from "node:sqlite";
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

// ============================================================
// Dependency Resolution Helper (v2.1.4)
// ============================================================
/**
 * Get dependency list for a step.
 * Currently uses step-based dependencies for backward compatibility.
 * Future: Query YAML `depends_on` from workflow spec.
 *
 * Returns: Array of dependent steps with their status
 */
function getDependencies(db: DatabaseSync, stepId: string): Array<{ id: string; status: string; step_index: number }> {
  const step = db.prepare("SELECT id, run_id, step_index FROM steps WHERE id = ?").get(stepId) as { id: string; run_id: string; step_index: number } | undefined;

  if (!step) {
    console.warn(`[getDependencies] Step not found: ${stepId}`);
    return [];
  }

  // TEMPORARILY: Use step_index for dependencies (solution 1)
  // TODO: Switch to YAML-based `depends_on` (solution 2) when available
  // When YAML depends_on is supported:
  //   1. Store depends_on in steps table (from workflow spec YAML)
  //   2. Query: SELECT id, status FROM steps WHERE id IN (SELECT unnest(depends_on))
  //   3. No changes below in peekAndSpawn logic

  const dependencies = db.prepare(`
    SELECT id, status, step_index
    FROM steps
    WHERE run_id = ?
      AND step_index < (SELECT step_index FROM steps WHERE id = ?)
    ORDER BY step_index ASC
  `).all(step.run_id, stepId) as Array<{ id: string; status: string; step_index: number }>;

  return dependencies;
}

// ============================================================
// Story Dependencies (v2.1.6): Same logic as getDependencies
// ============================================================
/**
 * Get dependency list for a story.
 * Ensures sequential story execution: stories can only proceed after all previous stories are complete.
 *
 * Future: If YAML depends_on is supported for stories, switch to that mechanism.
 *
 * Returns: Array of dependent stories with their status
 */
function getStoryDependencies(db: DatabaseSync, storyId: string): Array<{ id: string; story_id: string; status: string; story_index: number }> {
  const story = db.prepare("SELECT id, story_index FROM stories WHERE id = ?").get(storyId) as { id: string; story_index: number } | undefined;

  if (!story) {
    console.warn(`[getStoryDependencies] Story not found: ${storyId}`);
    return [];
  }

  // Use story_index for sequential dependencies (same pattern as steps)
  const dependencies = db.prepare(`
    SELECT id, story_id, status, story_index
    FROM stories
    WHERE story_index < (SELECT story_index FROM stories WHERE id = ?)
    ORDER BY story_index ASC
  `).all(storyId) as Array<{ id: string; story_id: string; status: string; story_index: number }>;

  return dependencies;
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
    // ============================================================
    // v2.1.4: Full Hybrid Prerequisites Check (C-5 fix)
    // ============================================================

    // Get dependencies (generic, currently step_index-based)
    const dependencies = getDependencies(db, loopStep.id);

    let allDepsDone = false;
    let skipReason = "";

    if (dependencies.length === 0) {
      // Step hat keine dependencies → Immer OK (z.B. first step in run)
      allDepsDone = true;
    } else {
      // Prüfe ob alle dependencies done sind
      allDepsDone = dependencies.every(dep => dep.status === 'done');

      if (!allDepsDone) {
        const depNames = dependencies.map(d => `${d.id}(${d.status})`).join(', ');

        // Einfaches sequentielles Szenario → Klarere Nachricht
        if (dependencies.length === 1 && dependencies[0].step_index === loopStep.step_index - 1) {
          skipReason = `Previous step not done: ${depNames}`;
        } else {
          // Komplexes Szenario → Ausführliche Nachricht
          skipReason = `Dependencies not complete: ${depNames}`;
        }

        console.log(`[peekAndSpawn] Skipping loop step ${loopStep.id}: ${skipReason}`);
        return { spawned: false, reason: skipReason };
      }
    }

    // Check if there's already a story running for this loop step
    if (loopStep.current_story_id) {
      const currentStory = db.prepare(
        "SELECT status FROM stories WHERE id = ?"
      ).get(loopStep.current_story_id) as { status: string } | undefined;

      if (currentStory && (currentStory.status === 'running' || currentStory.status === 'claiming')) {
        // A story is already running or being claimed, don't claim another one
        return { spawned: false, reason: "story_already_claimed" };
      } else if (currentStory && (currentStory.status === 'done' || currentStory.status === 'failed')) {
        // Story finished - clear current_story_id for next story
        console.log(`[peekAndSpawn] Story ${loopStep.current_story_id} completed (${currentStory.status}), clearing for next story`);

        withTransaction((txDb) => {
          txDb.prepare("UPDATE steps SET current_story_id = NULL WHERE id = ?").run(loopStep.id);
        });

        // Check again immediately after clearing (now current_story_id is NULL)
        // Fall through to claim new story below
      }
    }

    // ============================================================
    // v2.1.6: Check Story Dependencies BEFORE Claiming
    // ============================================================
    // Find the next pending story to check dependencies BEFORE claiming it
    const nextPendingStory = db.prepare(
      "SELECT * FROM stories WHERE step_id = ? AND status = 'pending' ORDER BY story_index LIMIT 1"
    ).get(loopStep.id) as { id: string; story_id: string; story_index: number } | undefined;

    if (nextPendingStory) {
      // Check story dependencies (same logic as steps)
      const storyDependencies = getStoryDependencies(db, nextPendingStory.id);
      const allStoryDepsDone = storyDependencies.every(dep => dep.status === 'done');

      if (!allStoryDepsDone) {
        const depNames = storyDependencies.map(d => `${d.story_id}(${d.status})`).join(', ');

        // Einfaches sequentielles Szenario → Klarere Nachricht
        if (storyDependencies.length === 1 && storyDependencies[0].story_index === nextPendingStory.story_index - 1) {
          console.log(`[peekAndSpawn] Previous story not done: ${depNames}`);
        } else {
          // Komplexes Szenario → Ausführliche Nachricht
          console.log(`[peekAndSpawn] Story dependencies not complete for ${nextPendingStory.story_id}: ${depNames}`);
        }

        return { spawned: false, reason: "story_dependencies_not_complete" };
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
Save the stepId - you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with KEY: value lines as specified.

MANDATORY: Report completion using tools.exec (do this IMMEDIATELY after finishing the work):
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
/**
 * Spawn agent session for a claimed step or story.
 * Handles cleanup, error rollback, and session tracking.
 *
 * v2.1.2: Added transaction wrapping for atomic database operations.
 * The spawn itself happens asynchronously outside the transaction, but all DB state
 * updates after spawn success are atomic. Rollback on failure is also atomic.
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

  // Get the agent configuration to determine the timeout (model removed in v2.1)
  const timeoutSeconds = agent.timeoutSeconds || 1800;

  // Validate required claim parameters (v2.1.2: type safety)
  if (!claim.runId || !claim.resolvedInput) {
    throw new Error(`Invalid claim: missing runId or resolvedInput for agent ${agentId}`);
  }

  // Cast to validated claim for type safety
  const validatedClaim = claim as { runId: string; resolvedInput: string; storyId?: string };

  try {
    // ============================================================
    // SPAWN: Execute asynchronously OUTSIDE transaction (v2.1.2)
    // ============================================================
    const result = await spawnAgentSession(
      agentId,
      stepId,
      validatedClaim.runId,
      validatedClaim.resolvedInput,
      timeoutSeconds,
      validatedClaim.storyId
    );

    if (!result.sessionId) {
      throw new Error(`Failed to spawn session: ${JSON.stringify(result)}`);
    }

    // Validated sessionId after spawn success (v2.1.2)
    const sessionId = result.sessionId;

    // ============================================================
    // TRANSACTION: All DB updates after spawn success (v2.1.2)
    // ============================================================
    withTransaction((txDb) => {
      // Update step/story to 'running' AFTER successful spawn
      if (validatedClaim.storyId) {
        // Story: claiming → running
        txDb.prepare(
          "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(validatedClaim.storyId);

        // Emit story.started event (after spawn success)
        const step = txDb.prepare("SELECT step_id, run_id FROM steps WHERE id = ?").get(stepId) as any;
        const story = txDb.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(validatedClaim.storyId) as any;
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
        txDb.prepare(
          "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(stepId);

        // Emit step.running event (after spawn success)
        const step = txDb.prepare("SELECT step_id, run_id FROM steps WHERE id = ?").get(stepId) as any;
        const wfId = getWorkflowId(step.run_id);

        emitEvent({
          ts: new Date().toISOString(),
          event: "step.running",
          runId: step.run_id,
          workflowId: wfId,
          stepId: step.step_id,
          agentId,
          sessionId: sessionId
        });
      }

      // Record session in daemon_active_sessions
      txDb.prepare(
        `INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, story_id, spawned_at, spawned_by, session_id)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`
      ).run(agentId, stepId, validatedClaim.runId, validatedClaim.storyId || null, source, sessionId);
    });

    return {
      spawned: true,
      sessionId: sessionId,
      stepId: stepId,
      runId: validatedClaim.runId,
      storyId: validatedClaim.storyId || undefined,
      spawnedBy: source
    };

  } catch (error) {
    console.error(`Failed to spawn session for ${agentId}: ${error}`);

    // ============================================================
    // ROLLBACK TRANSACTION: Atomic rollback on failure (v2.1.2)
    // ============================================================
    withTransaction((txDb) => {
      if (validatedClaim.storyId) {
        // Revert story to 'pending'
        txDb.prepare(
          "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'claiming'"
        ).run(validatedClaim.storyId);

        // Clear step's current_story_id only if it matches the story we're rolling back
        txDb.prepare(
          "UPDATE steps SET current_story_id = NULL WHERE id = ? AND current_story_id = ?"
        ).run(stepId, validatedClaim.storyId);
      } else {
        // Revert step to 'pending'
        txDb.prepare(
          "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'claiming'"
        ).run(stepId);
      }
    });

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
