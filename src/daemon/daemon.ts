import { getDb } from "../db.js";
import { peekAndSpawn } from "./spawner.js";
import { cleanupAbandonedSteps } from "../installer/step-ops.js";
import { loadWorkflowSpec } from "../installer/workflow-spec.js";
import { resolveWorkflowDir } from "../installer/paths.js";
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
  
  // Start the cleanup loop (every 5 minutes)
  cleanupInterval = setInterval(() => {
    if (isShuttingDown) return;
    try {
      console.log("Running abandoned steps cleanup");
      cleanupAbandonedSteps();
    } catch (error) {
      console.error("Error during abandoned steps cleanup:", error);
    }
  }, 5 * 60 * 1000); // 5 minutes
  
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
    
    // Get all active runs
    const runsQuery = workflowIds && workflowIds.length > 0
      ? `SELECT DISTINCT workflow_id FROM runs WHERE status = 'running' AND workflow_id IN (${workflowIds.map(() => '?').join(',')})`
      : "SELECT DISTINCT workflow_id FROM runs WHERE status = 'running'";
    
    const runsParams = workflowIds && workflowIds.length > 0 ? workflowIds : [];
    const activeWorkflows = db.prepare(runsQuery).all(...runsParams) as { workflow_id: string }[];
    
    console.log(`Found ${activeWorkflows.length} active workflows to monitor`);
    
    // Process each workflow
    for (const workflowRecord of activeWorkflows) {
      if (isShuttingDown) return;
      
      const workflowId = workflowRecord.workflow_id;
      console.log(`Processing workflow: ${workflowId}`);
      
      try {
        // Load the workflow specification
        const workflowDir = resolveWorkflowDir(workflowId);
        const workflow: WorkflowSpec = await loadWorkflowSpec(workflowDir);
        
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