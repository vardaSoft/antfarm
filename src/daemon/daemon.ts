import { getDb } from "../db.js";
import { peekAndSpawn } from "./spawner.js";
import { cleanupAbandonedSteps } from "../installer/step-ops.js";
import { emitEvent } from "../installer/events.js";
import { loadWorkflowSpec } from "../installer/workflow-spec.js";
import { resolveWorkflowDir } from "../installer/paths.js";
import { getCachedWorkflow, getCacheMetrics } from "./cache.js";
import type { WorkflowSpec } from "../installer/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Global variables to track daemon state
let daemonInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let staleCleanupInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

// PID file path
const PID_DIR = path.join(os.homedir(), ".openclaw", "antfarm");
const PID_FILE = path.join(PID_DIR, "spawner.pid");

/**
 * Start the daemon process that polls for work and spawns agents as needed.
 * @param intervalMs - Polling interval in milliseconds (default: 30000 = 30 seconds)
 * @param workflowIds - Optional array of workflow IDs to monitor (if not provided, monitors all workflows)
 */
export async function startDaemon(intervalMs: number = 30000, workflowIds?: string[]): Promise<void> {
  console.log(`Starting Antfarm daemon with ${intervalMs}ms polling interval`);
  
  // Ensure PID directory exists
  fs.mkdirSync(PID_DIR, { recursive: true });
  
  // Write PID file
  fs.writeFileSync(PID_FILE, process.pid.toString());
  console.log(`PID file written to ${PID_FILE}`);
  
  // Setup graceful shutdown handlers
  setupShutdownHandlers();
  
  // Start the main polling loop
  daemonInterval = setInterval(async () => {
    if (isShuttingDown) return;
    await runDaemonLoop(workflowIds);
  }, intervalMs);
  
  // Start the cleanup loop (every 2 minutes)
  cleanupInterval = setInterval(() => {
    if (isShuttingDown) return;
    try {
      console.log("Running abandoned steps cleanup");
      cleanupAbandonedSteps();
      
      console.log("Running stale claiming state cleanup");  // ADDED
      cleanupStaleClaimingState();  // ADDED
      
      // Log cache metrics
      const metrics = getCacheMetrics();
      console.log(`Workflow cache metrics: ${metrics.hits} hits, ${metrics.misses} misses, ${Math.round(metrics.hitRate * 100)}% hit rate, ${metrics.size} entries`);
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }, 2 * 60 * 1000); // 2 minutes (more frequent for claiming cleanup)
  
  // Start the stale sessions cleanup loop (every 10 minutes)
  staleCleanupInterval = setInterval(() => {
    if (isShuttingDown) return;
    try {
      console.log("Running stale sessions cleanup");
      import("./spawner.js").then(spawner => {
        spawner.cleanupStaleSessions();
      });
    } catch (error) {
      console.error("Error during stale sessions cleanup:", error);
    }
  }, 10 * 60 * 1000); // 10 minutes
  
  // Run the first cleanups immediately
  setImmediate(() => {
    try {
      console.log("Running initial abandoned steps cleanup");
      cleanupAbandonedSteps();
    } catch (error) {
      console.error("Error during initial abandoned steps cleanup:", error);
    }
    
    try {
      console.log("Running initial stale claiming state cleanup");
      cleanupStaleClaimingState();
    } catch (error) {
      console.error("Error during initial stale claiming state cleanup:", error);
    }
    
    try {
      console.log("Running initial stale sessions cleanup");
      import("./spawner.js").then(spawner => {
        spawner.cleanupStaleSessions();
      });
    } catch (error) {
      console.error("Error during initial stale sessions cleanup:", error);
    }
  });
  
  console.log("Daemon started successfully");
}

/**
 * Main daemon loop that checks all agents in workflows and spawns sessions as needed.
 */
async function runDaemonLoop(workflowIds?: string[]): Promise<void> {
  try {
    const db = getDb();
    
    // Get all active runs with scheduler = 'daemon'
    const runsQuery = workflowIds && workflowIds.length > 0
      ? `SELECT DISTINCT workflow_id FROM runs WHERE status = 'running' AND scheduler = 'daemon' AND workflow_id IN (${workflowIds.map(() => '?').join(',')})`
      : "SELECT DISTINCT workflow_id FROM runs WHERE status = 'running' AND scheduler = 'daemon'";
    
    const runsParams = workflowIds && workflowIds.length > 0 ? workflowIds : [];
    const activeWorkflows = db.prepare(runsQuery).all(...runsParams) as { workflow_id: string }[];
    
    console.log(`Found ${activeWorkflows.length} active workflows to monitor`);
    
    // Process each workflow
    for (const workflowRecord of activeWorkflows) {
      if (isShuttingDown) return;
      
      const workflowId = workflowRecord.workflow_id;
      console.log(`Processing workflow: ${workflowId}`);
      
      try {
        // Load the workflow specification (with caching)
        const workflowDir = resolveWorkflowDir(workflowId);
        const workflow: WorkflowSpec = await getCachedWorkflow(workflowId, workflowDir, loadWorkflowSpec);
        
        // Process each agent in the workflow
        for (const agent of workflow.agents) {
          if (isShuttingDown) return;
          
          const agentId = `${workflowId}_${agent.id}`;
          console.log(`Checking agent: ${agentId}`);
          
          try {
            // Use peekAndSpawn to check for work and spawn if needed
            const result = await peekAndSpawn(agentId, workflow);
            
            if (result.spawned) {
              console.log(`Spawned agent session for ${agentId} with step ${result.stepId}`);
            } else {
              console.log(`No work available for agent ${agentId}`);
            }
          } catch (error) {
            console.error(`Error processing agent ${agentId}:`, error);
          }
        }
      } catch (error) {
        console.error(`Error loading workflow ${workflowId}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in daemon loop:", error);
  }
}

/**
 * Setup signal handlers for graceful shutdown
 */
function setupShutdownHandlers(): void {
  const shutdownHandler = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log(`Received ${signal}, shutting down gracefully...`);
    
    // Clear intervals
    if (daemonInterval) {
      clearInterval(daemonInterval);
      daemonInterval = null;
    }
    
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    
    if (staleCleanupInterval) {
      clearInterval(staleCleanupInterval);
      staleCleanupInterval = null;
    }
    
    // Remove PID file
    try {
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
        console.log("PID file removed");
      }
    } catch (error) {
      console.error("Error removing PID file:", error);
    }
    
    console.log("Daemon shutdown complete");
    process.exit(0);
  };
  
  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));
}

/**
 * Stop the daemon process
 */
export function stopDaemon(): void {
  if (daemonInterval) {
    clearInterval(daemonInterval);
    daemonInterval = null;
  }
  
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  
  if (staleCleanupInterval) {
    clearInterval(staleCleanupInterval);
    staleCleanupInterval = null;
  }
  
  // Remove PID file
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      console.log("PID file removed");
    }
  } catch (error) {
    console.error("Error removing PID file:", error);
  }
  
  console.log("Daemon stopped");
}

// Entry point for running daemon.ts as a standalone script
if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse command-line arguments
  const args = process.argv.slice(2);
  let intervalMs = 30000; // default 30 seconds
  let workflowIds: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval" && args[i + 1]) {
      intervalMs = parseInt(args[i + 1], 10) || 30000;
      i++;
    } else if (args[i] === "--workflows" && args[i + 1]) {
      workflowIds = args[i + 1].split(",");
      i++;
    }
  }

  // Start the daemon
  startDaemon(intervalMs, workflowIds).catch((err) => {
    console.error("Failed to start daemon:", err);
    process.exit(1);
  });
}

/**
 * Clean up steps/stories stuck in 'claiming' state (spawn failed or crashed)
 */
function cleanupStaleClaimingState(): void {
  const db = getDb();

  // Cleanup stale claiming steps (stuck for >5 minutes)
  const staleSteps = db.prepare(
    `SELECT id, agent_id, run_id, step_id, updated_at 
     FROM steps 
     WHERE status = 'claiming' 
     AND updated_at < datetime('now', '-5 minutes')`
  ).all() as Array<{ id: string; agent_id: string; run_id: string; step_id: string; updated_at: string }>;

  for (const step of staleSteps) {
    console.warn(`Cleaning up stale claiming step: ${step.step_id}`, { stepId: step.id });
    
    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(step.id);
    
    const incrementRetry = db.prepare("UPDATE steps SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?");
    incrementRetry.run(step.id);

    emitEvent({ 
      ts: new Date().toISOString(), 
      event: "step.rollback",
      runId: step.run_id,
      stepId: step.step_id,
      agentId: step.agent_id,
      detail: "stale_claiming"
    });
  }

  // Cleanup stale claiming stories (stuck for >5 minutes)
  const staleStories = db.prepare(
    `SELECT s.id, s.story_id, s.run_id, st.step_id, st.agent_id 
     FROM stories s
     JOIN steps st ON st.current_story_id = s.id
     WHERE s.status = 'claiming'
     AND s.updated_at < datetime('now', '-5 minutes')`
  ).all() as Array<{ id: string; story_id: string; run_id: string; step_id: string; agent_id: string }>;

  for (const story of staleStories) {
    console.warn(`Cleaning up stale claiming story: ${story.story_id}`, { storyId: story.id });
    
    // Revert story to pending
    db.prepare("UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(story.id);
    
    // Clear step's current_story_id
    db.prepare("UPDATE steps SET current_story_id = NULL WHERE id = ?").run(story.step_id);
    
    // Increment story retry count
    const incrementRetry = db.prepare("UPDATE stories SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?");
    incrementRetry.run(story.id);

    const wfId = getWorkflowId(story.run_id);
    emitEvent({ 
      ts: new Date().toISOString(), 
      event: "story.rollback",
      runId: story.run_id,
      workflowId: wfId,
      stepId: story.step_id,
      agentId: story.agent_id,
      storyId: story.story_id,
      detail: "stale_claiming"
    });
  }

  // Also cleanup orphan daemon_active_sessions entries
  db.prepare(
    `DELETE FROM daemon_active_sessions 
     WHERE spawned_at < datetime('now', '-1 hour')
     OR EXISTS (
       SELECT 1 FROM steps s WHERE s.id = daemon_active_sessions.step_id AND s.status IN ('pending', 'waiting', 'done', 'failed')
     )
     OR NOT EXISTS (
       SELECT 1 FROM steps s WHERE s.id = daemon_active_sessions.step_id
     )`
  ).run();
}

// Helper function to get workflow ID (needed for event emission)
function getWorkflowId(runId: string): string | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    return row?.workflow_id;
  } catch { return undefined; }
}