import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb, nextRunNumber } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";
import { startDaemon, isRunning } from "../server/daemonctl.js";

export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  scheduler?: string;
}): Promise<{ id: string; runNumber: number; workflowId: string; task: string; status: string; scheduler: string }> {
  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  // Default scheduler is daemon, can be overridden via params
  const scheduler = params.scheduler ?? "daemon";

  const initialContext: Record<string, string> = {
    task: params.taskTitle,
    ...workflow.context,
  };

  db.exec("BEGIN");
  try {
    const notifyUrl = params.notifyUrl ?? workflow.notifications?.url ?? null;
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

  // Start scheduler for this workflow
  let daemonInfo: { pid: number; port: number } | undefined;
  if (scheduler === "daemon") {
    const running = isRunning();
    if (!running.running) {
      try {
        const result = await startDaemon(3333);
        daemonInfo = { pid: result.pid, port: result.port };
      } catch (err) {
        // Roll back the run since it can't advance without scheduler
        const db2 = getDb();
        db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot start workflow run: daemon setup failed. ${message}`);
      }
    }
  } else {
    // Default to cron scheduler
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

  logger.info(`Run started: "${params.taskTitle}" (scheduler: ${scheduler})`, {
    workflowId: workflow.id,
    runId,
    stepId: workflow.steps[0]?.id,
  });

  return {
    id: runId,
    runNumber,
    workflowId: workflow.id,
    task: params.taskTitle,
    status: "running",
    scheduler,
  };
}
