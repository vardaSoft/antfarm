# Daemon als Default Scheduler für Antfarm

## Ziel
Antfarm Workflows sollen standardmäßig mit dem Daemon-Scheduler starten statt mit Cron.

## Analyse

### Aktueller Stand
- CLI: `--scheduler` Parameter ist optional, kein Default
- `run.ts`: Default ist `scheduler = params.scheduler ?? "cron"`
- Resume-Funktion: Startet immer Crons, ignoriert `run.scheduler`

### Benötigte Änderungen

#### 1. `src/cli/cli.ts` (Zeile ~732)

**ALT:**
```typescript
// Parse --scheduler
const schedulerIdx = runArgs.indexOf("--scheduler");
if (schedulerIdx !== -1) {
  const schedulerValue = runArgs[schedulerIdx + 1];
  if (schedulerValue === "cron" || schedulerValue === "daemon") {
    scheduler = schedulerValue;
    runArgs.splice(schedulerIdx, 2);
  } else {
    process.stderr.write(`Invalid scheduler value: ${schedulerValue}. Must be 'cron' or 'daemon'.\n`);
    process.exit(1);
  }
}
```

**NEU:**
```typescript
// Parse --scheduler (default: daemon)
const schedulerIdx = runArgs.indexOf("--scheduler");
if (schedulerIdx !== -1) {
  const schedulerValue = runArgs[schedulerIdx + 1];
  if (schedulerValue === "cron" || schedulerValue === "daemon") {
    scheduler = schedulerValue;
    runArgs.splice(schedulerIdx, 2);
  } else {
    process.stderr.write(`Invalid scheduler value: ${schedulerValue}. Must be 'cron' or 'daemon'.\n`);
    process.exit(1);
  }
} else {
  scheduler = "daemon"; // Default to daemon scheduler
}
```

#### 2. `src/installer/run.ts` (Zeile ~37)

**ALT:**
```typescript
const scheduler = params.scheduler ?? "cron"; // Default to cron scheduler
```

**NEU:**
```typescript
const scheduler = params.scheduler ?? "daemon"; // Default to daemon scheduler
```

#### 3. `src/installer/run.ts` (Zeile ~60-80) - Bedingte Cron-Erstellung

**ALT:**
```typescript
if (params.scheduler === "daemon") {
  // ... daemon code
} else {
  // Default to cron scheduler
  await ensureWorkflowCrons(workflow);
}
```

**NEU:**
```typescript
if (scheduler === "daemon") {
  // ... daemon code
} else if (scheduler === "cron") {
  // Only create crons for cron scheduler
  await ensureWorkflowCrons(workflow);
}
```

#### 4. `src/installer/run.ts` (Zeile ~90) - Logger Info

**ALT:**
```typescript
logger.info(`Run started: "${params.taskTitle}" (scheduler: ${params.scheduler ?? "cron"})`, ...)
```

**NEU:**
```typescript
logger.info(`Run started: "${params.taskTitle}" (scheduler: ${scheduler})`, ...)
```

#### 5. `src/installer/run.ts` (Zeile ~95-102) - Result-Objekt

**ALT:**
```typescript
if (params.scheduler) {
  result.scheduler = params.scheduler;
  if (daemonInfo) {
    result.daemonInfo = daemonInfo;
  }
}
```

**NEU:**
```typescript
result.scheduler = scheduler;
if (daemonInfo) {
  result.daemonInfo = daemonInfo;
}
```

#### 6. `src/installer/step-ops.ts` - Resume-Funktion (~Zeile 595)

**ALT:**
```typescript
// Ensure crons are running for this workflow
const { loadWorkflowSpec } = await import("../installer/workflow-spec.js");
const { resolveWorkflowDir } = await import("../installer/paths.js");
const { ensureWorkflowCrons } = await import("../installer/agent-cron.js");
try {
  const workflowDir = resolveWorkflowDir(run.workflow_id);
  const workflow = await loadWorkflowSpec(workflowDir);
  await ensureWorkflowCrons(workflow);
} catch (err) {
  process.stderr.write(`Warning: Could not start crons: ${err instanceof Error ? err.message : String(err)}\n`);
}
```

**NEU:**
```typescript
// Ensure scheduler is running for this workflow
const { loadWorkflowSpec } = await import("../installer/workflow-spec.js");
const { resolveWorkflowDir } = await import("../installer/paths.js");

// Check which scheduler was used for this run
const runScheduler = run.scheduler ?? "cron";

if (runScheduler === "daemon") {
  const { startDaemon, isRunning } = await import("../daemon/daemonctl.js");
  if (!isRunning().running) {
    try {
      await startDaemon();
    } catch (err) {
      process.stderr.write(`Warning: Could not start daemon: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
} else {
  const { ensureWorkflowCrons } = await import("../installer/agent-cron.js");
  try {
    const workflowDir = resolveWorkflowDir(run.workflow_id);
    const workflow = await loadWorkflowSpec(workflowDir);
    await ensureWorkflowCrons(workflow);
  } catch (err) {
    process.stderr.write(`Warning: Could not start crons: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
```

## Test

Nach den Änderungen:
```bash
# Build
npm run build

# Test ohne --scheduler (sollte daemon verwenden)
node dist/cli/cli.js workflow run bug-fix "test" 

# Prüfen ob daemon läuft
node dist/cli/cli.js spawner status
```

## Dateien
- `/data/projects/antfarm/src/cli/cli.ts`
- `/data/projects/antfarm/src/installer/run.ts`
- `/data/projects/antfarm/src/installer/step-ops.ts`