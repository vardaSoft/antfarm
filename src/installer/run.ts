import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb, nextRunNumber } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";

export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  scheduler?: "cron" | "daemon"; // Added scheduler option
}): Promise<{ id: string; runNumber: number; workflowId: string; task: string; status: string; scheduler?: "cron" | "daemon"; daemonInfo?: { pid: number; intervalMs?: number } }> {
  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  const initialContext: Record<string, string> = {
    task: params.taskTitle,
    ...workflow.context,
  };

  db.exec("BEGIN");
  try {
    const notifyUrl = params.notifyUrl ?? workflow.notifications?.url ?? null;
    const scheduler = params.scheduler ?? "cron"; // Default to cron scheduler
    const insertRun = db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, notify_url, scheduler, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)"
    );
    insertRun.run(runId, runNumber, workflow.id, params.taskTitle, JSON.stringify(initialContext), notifyUrl, scheduler, now, now);

    const insertStep = db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const stepUuid = crypto.randomUUID();
      const agentId = `${workflow.id}_${step.agent}`;
      const status = i === 0 ? "pending" : "waiting";
      const maxRetries = step.max_retries ?? step.on_fail?.max_retries ?? 2;
      const stepType = step.type ?? "single";
      const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
      insertStep.run(stepUuid, runId, step.id, agentId, i, step.input, step.expects, status, maxRetries, stepType, loopConfig, now, now);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Handle different schedulers
  let daemonInfo: { pid: number; intervalMs?: number } | undefined;
  if (params.scheduler === "daemon") {
    // For daemon scheduler, start the spawner daemon instead of cron jobs
    try {
      const { startDaemon, isRunning } = await import("../daemon/daemonctl.js");
      const result = await startDaemon();
      daemonInfo = { pid: result.pid };
      
      // Get additional daemon information
      const daemonStatus = isRunning();
      if (daemonStatus.running) {
        daemonInfo.intervalMs = 30000; // Default interval
      }
    } catch (err) {
      // Roll back the run since it can't advance without the daemon
      const db2 = getDb();
      db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot start workflow run: daemon startup failed. ${message}`);
    }
  } else {
    // Default to cron scheduler (existing behavior)
    try {
      await ensureWorkflowCrons(workflow);
    } catch (err) {
      // Roll back the run since it can't advance without crons
      const db2 = getDb();
      db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot start workflow run: cron setup failed. ${message}`);
    }
  }

  emitEvent({ ts: new Date().toISOString(), event: "run.started", runId, workflowId: workflow.id });

  logger.info(`Run started: "${params.taskTitle}" (scheduler: ${params.scheduler ?? "cron"})`, {
    workflowId: workflow.id,
    runId,
    stepId: workflow.steps[0]?.id,
  });

  const result: { id: string; runNumber: number; workflowId: string; task: string; status: string; scheduler?: "cron" | "daemon"; daemonInfo?: { pid: number; intervalMs?: number } } = { 
    id: runId, 
    runNumber, 
    workflowId: workflow.id, 
    task: params.taskTitle, 
    status: "running" 
  };
  
  if (params.scheduler) {
    result.scheduler = params.scheduler;
    if (daemonInfo) {
      result.daemonInfo = daemonInfo;
    }
  }
  
  return result;
}
