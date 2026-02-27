# Bugs to Fix - Antfarm Daemon Implementation (Aktualisiert)
## Mit CLI vs Gateway API Analyse

Automatisch generiert aus der Architekturreview vom 21.02.2026.

---

## 🎯 ARCHITEKTUR: DAS INTENDED DESIGN (Option A)

**Der Daemon ist bewusst so designed - er ersetzt die Polling Agents!**

### Warum Option A das richtige Design ist

```
Cron-System (VORHER - replaced by Daemon):
Cron Engine → Polling Agent → Work Agent
     ↓              ↓              ↓
  Gateway      lightweight      heavy
              (overhead!)

Daemon-System (JETZT - Option A):
Daemon Process → Work Agent
     ↓               ↓
 Direct spawn      heavy
 (no overhead!)
```

### Vorteile des Daemon-Designs

| Vorteil | Erklärung |
|---------|-----------|
| ✅ **Keine Polling Agents** | Einsparung von lightweight Sessions |
| ✅ **Direkte Kontrolle** | Daemon hat volle visibility |
| ✅ **Weniger Overhead** | 1 Session statt 2 pro Arbeit |
| ✅ **Performance** | Kein zusätzlicher Agent-Layer |
| ✅ **Unabhängigkeit** | Keine Gateway-Dependency |

**Die Architektur ist KORREKT - nur Implementation-Bugs müssen gefixt werden.**

---

## 🔴 CRITICAL BUGS (Fix Immediately)

### Bug-001: Scheduler Conflict Prevention Missing

**Component:** `src/daemon/daemon.ts` (runDaemonLoop)

**Description:**
The daemon processes ALL active runs regardless of scheduler type, potentially spawning duplicate sessions for cron-scheduled runs.

**Impact:** Duplicate step execution when both cron and daemon schedulers are active.

**Steps to Fix:**
1. Modify `runDaemonLoop()` query to filter by `scheduler = 'daemon'`
2. Add check in `peekAndSpawn()` to verify run's scheduler

**Code Reference:**
```typescript
// Current (BROKEN):
const runsQuery = "SELECT DISTINCT workflow_id FROM runs WHERE status = 'running'";

// Fixed:
const runsQuery = `
  SELECT DISTINCT workflow_id
  FROM runs
  WHERE status = 'running' AND scheduler = 'daemon'
`;
```

**Acceptance Criteria:**
- [ ] `daemon.ts` never spawns sessions for cron-scheduled runs
- [ ] Cron runs are never processed by daemon loop
- [ ] Integration test with both schedulers verifies no duplicate execution

**Priority:** P0

---

### Bug-002: Session Tracking Race Condition

**Component:** `src/daemon/spawner.ts` (line 62-90, 100-126)

**Description:**
The `daemon_active_sessions` entry is not removed when spawn fails. Error handler at line 115 is buggy.

**Impact:** Orphaned entries block new sessions for up to 45 minutes.

**Steps to Fix:**
1. Fix the missing DELETE in the catch block
2. Use try/finally pattern to ensure cleanup
3. Reduce stale session timeout from 45 min to 15 min

**Code Before (BROKEN):**
```typescript
try {
  // ... spawn logic ...
  child.on('close', () => {
    db.prepare("DELETE FROM daemon_active_sessions...").run();
  });
} catch (error) {
  db.prepare("DELETE FROM daemon_active_sessions...").run();  // ❌ Wrong params
  throw error;
}
```

**Code After (FIXED):**
```typescript
try {
  const sessionRecord = {
    agent_id: agentId,
    step_id: stepId,
    run_id: runId,
    spawned_at: new Date().toISOString()
  };

  db.prepare(
    "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
  ).run(sessionRecord.agent_id, sessionRecord.step_id, sessionRecord.run_id, sessionRecord.spawned_at);

  // ... spawn logic ...

  child.on('close', () => {
    db.prepare(
      "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
    ).run(agentId, stepId);
  });
} catch (error) {
  // ✅ Fixed with correct params
  db.prepare(
    "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
  ).run(agentId, stepId);
  throw error;
}
```

**Acceptance Criteria:**
- [ ] Failed spawn always removes record from `daemon_active_sessions`
- [ ] Unit test for error path passing
- [ ] Stale session timeout reduced to 15 minutes
- [ ] Integration test verifying cleanup on failure

**Priority:** P0

---

## 🟠 HIGH PRIORITY BUGS (Fix within 1 week)

### Bug-003: Inefficient Daemon Loop - No Caching

**Component:** `src/daemon/daemon.ts` (runDaemonLoop)

**Description:**
`loadWorkflowSpec()` reads and parses workflow.yml from disk on EVERY loop iteration (every 30s).

**Impact:** High disk I/O and CPU load with many workflows. 10 workflows × 6 agents = 60 file reads every 30s.

**Steps to Fix:**
1. Add in-memory cache with TTL (5 minutes)
2. Invalidate cache on workflow.yml modification (fs.watch or checksum)
3. Add cache metrics (hit_rate, size)

**Reference Implementation:**
```typescript
interface CacheEntry {
  spec: WorkflowSpec;
  lastUpdated: number;
  ttl: number;
}

const workflowCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedWorkflow(workflowId: string): Promise<WorkflowSpec> {
  const cached = workflowCache.get(workflowId);
  const now = Date.now();

  if (cached && (now - cached.lastUpdated) < cached.ttl) {
    return cached.spec;
  }

  // Load fresh
  const workflowDir = resolveWorkflowDir(workflowId);
  const spec = await loadWorkflowSpec(workflowDir);

  workflowCache.set(workflowId, { spec, lastUpdated: now, ttl: CACHE_TTL_MS });
  return spec;
}
```

**Acceptance Criteria:**
- [ ] workflow.yml loaded at most once per TTL period per workflow
- [ ] Cache invalidates when workflow.yml changes
- [ ] Cache metrics exported (hit_rate, cache_size)
- [ ] Integration test showing reduced I/O

**Priority:** P1

---

### Bug-004: Missing Timeout Configuration (falls Option A)

**Component:** `src/daemon/spawner.ts` (line 143)

**Description:**
Timeout is hardcoded to 1800s (30 min). `agent.timeoutSeconds` and `workflow.polling.timeoutSeconds` are ignored.

**Impact:** Agents may run too long or too short.

**Steps to Fix:**
1. Read timeout from `agent.timeoutSeconds` or `workflow.polling.timeoutSeconds`
2. Default to 1800s if not specified
3. Document timeout behavior

**Code After (FIXED):**
```typescript
const timeoutSeconds = workflow.agents.find(a => a.id === agentId.split('_')[1])?.timeoutSeconds
                     ?? workflow.polling?.timeoutSeconds
                     ?? 1800; // 30 minutes default

const args = [
  "sessions", "spawn",
  "--agent", agentId,
  "--model", model,
  "--timeout", String(timeoutSeconds),
];
```

**Acceptance Criteria:**
- [ ] Timeout derived from agent or workflow config
- [ ] Documentation updated on timeout precedence
- [ ] Unit test for timeout calculation

**Priority:** P1

---

## 🟡 MEDIUM PRIORITY BUGS (Fix within 2 weeks)

### Bug-005: Redundant Files (daemon.js and daemon.ts)

**Component:** `/tmp/antfarm-daemon/src/daemon/`

**Description:**
Both `daemon.js` and `daemon.ts` are versioned. `daemon.js` is compiled from `daemon.ts`.

**Impact:** Repository bloat, version conflicts, potential stale artifacts.

**Steps to Fix:**
1. Delete `daemon.js` file
2. Update `execFile("node daemon.js")` in daemonctl.ts to use compiled dist or `ts-node`

**Acceptance Criteria:**
- [ ] `daemon.js` removed from repository
- [ ] `.gitignore` includes `src/daemon/*.js` (except intentional JS files)
- [ ] Build script updated to handle TS compilation
- [ ] Daemon still starts correctly after cleanup

**Priority:** P2

---

## 🟢 LOW PRIORITY IMPROVEMENTS

### Bug-006: Unused cleanupCompletedSessions Function

**Component:** `src/daemon/spawner.ts`

**Description:**
`cleanupCompletedSessions()` function is defined but never called in daemon loop.

**Impact:** Unused code, potential memory leak.

**Steps to Fix:**
1. Call `cleanupCompletedSessions()` in daemon loop OR
2. Remove function if not needed

**Priority:** P3

---

### Bug-007: No Real Integration Tests

**Component:** `/tmp/antfarm-daemon/src/tests/`

**Description:**
Only compilation test exists. No real unit or integration tests for daemon logic.

**Impact:** Low confidence in daemon correctness.

**Steps to Fix:**
1. Write unit tests for `peekAndSpawn()`
2. Write unit tests for `spawnAgentSession()` (Option A) oder `spawnPollingAgent()` (Option B)
3. Write integration test for daemon loop
4. Mock OpenClaw CLI/API calls

**Priority:** P3

---

## 🆕 NEU: CLI vs Gateway API Verbesserung (Optional)

### Enhancement-001: Add Gateway API Fallback for sessions_spawn

**Component:** `src/daemon/spawner.ts`

**Description:**
Current implementation uses CLI only. Should add Gateway API as primary with CLI fallback for robustness (like `gateway-api.ts` does for cron ops).

**Impact:** Better compatibility, aligned with original Antfarm pattern.

**Steps to Fix:**
```typescript
async function spawnAgentSession(...) {
  // Try Gateway API first
  try {
    const gateway = await getGatewayConfig();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (gateway.secret) headers['Authorization'] = `Bearer ${gateway.secret}`;

    const response = await fetch(`${gateway.url}/api/tools/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool: 'sessions_spawn',
        args: {
          task: workPrompt,
          agent_id: agentId,
          model: model,
          thinking: 'high',
          timeout_ms: timeoutSeconds * 1000
        }
      })
    });

    if (response.ok) {
      const result = await response.json();
      return result;
    }
  } catch (err) {
    console.warn('Gateway API failed, falling back to CLI:', err);
  }

  // Fallback to CLI
  return await spawnAgentSessionCLI(...);
}
```

**Acceptance Criteria:**
- [ ] Gateway API attempted first
- [ ] Falls back to CLI on failure
- [ ] Error logging for both attempts
- [ ] Documentation updated

**Priority:** P2 (optional)

---

## 🆕 NEU: Architektur-Refactoring (falls Option B)

### Refactor-001: Implement Polling Agent Pattern

**Component:** `src/daemon/spawner.ts`, `src/daemon/daemon.ts`

**Description:**
Instead of spawning Work Agents directly, spawn Polling Agents that then spawn Work Agents via sessions_spawn. This matches the original Cron pattern.

**Impact:**
- Removes need for `daemon_active_sessions` table
- Consistent with Cron architecture
- Better session ownership
- Simpler cleanup

**Steps to Fix (HIGH OVERVIEW):**
```typescript
// daemon.ts
async function runDaemonLoop() {
  // Don't spawn work directly
  // Instead: spawn polling agents if not already running

  for (const workflow of activeWorkflows) {
    for (const agent of workflow.agents) {
      const agentId = `${workflowId}_${agent.id}`;

      // Check if polling agent already running
      const existing = db.prepare(
        "SELECT * FROM daemon_polling_agents WHERE agent_id = ?"
      ).get(agentId);

      if (!existing) {
        await spawnPollingAgent(agentId, workflow);
      }
    }
  }
}

// spawner.ts
async function spawnPollingAgent(agentId: string, workflow: WorkflowSpec) {
  // Build the same polling prompt used by agent-cron.ts
  const prompt = buildPollingPrompt(workflow.id, agentId.split('_')[1]);

  // Spawn polling agent
  await execFile(openclawBin, ["sessions", "spawn", "--agent", agentId, ...], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}
```

**Database Changes:**
```sql
-- Remove daemon_active_sessions (not needed)
-- Add daemon_polling_agents if tracking needed (optional)
CREATE TABLE IF NOT EXISTS daemon_polling_agents (
  agent_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  spawned_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);
```

**Acceptance Criteria:**
- [ ] Polling Agent pattern implemented
- [ ] daemon_active_sessions removed or deprecated
- [ ] Polling agents spawn work agents via sessions_spawn
- [ ] All existing tests pass

**Priority:** P1 (if choosing Option B)

---

## Testing Checklist

For each bug fix, ensure:

- [ ] Code compiles without errors
- [ ] All existing tests still pass
- [ ] New tests added (unit + integration)
- [ ] Manual testing performed
- [ ] Documentation updated
- [ ] Changelog updated
- [ ] No side effects on other components

---

## Execution Order

### Wenn **Option A** (aktuelles Design behalten):

1. **Fix CRITICAL bugs** (Bug-001, Bug-002)
2. **Fix HIGH bugs** (Bug-003, Bug-004)
3. **Fix MEDIUM bugs** (Bug-005)
4. **Add optional enhancement** (Enhancement-001: Gateway API Fallback)
5. **Add tests** (Bug-007)
6. **Clean up low priority** (Bug-006)

### Wenn **Option B** (Polling Agent Pattern):

1. **Implement Refactor-001** (Polling Agent Pattern)
2. **Fix CRITICAL bug** (Bug-001 - Scheduler Conflict)
3. **Add tests** (Bug-007)
4. **Performance optimization** (Bug-003 - Caching, if needed)
5. **Add Gateway API Fallback** (Enhancement-001)

---

## Progress Tracking

| ID | Title | Status | Assignee | ETA |
|----|-------|--------|----------|-----|
| Bug-001 | Scheduler Conflict Prevention | TODO | - | - |
| Bug-002 | Session Tracking Race Condition | TODO | - | - |
| Bug-003 | Inefficient Daemon Loop | TODO | - | - |
| Bug-004 | Missing Timeout Configuration | TODO | - | - |
| Bug-005 | Redundant Files | TODO | - | - |
| Bug-006 | Unused cleanupCompletedSessions | TODO | - | - |
| Bug-007 | No Real Integration Tests | TODO | - | - |
| Enhancement-001 | Gateway API Fallback | TODO | - | - |
| Refactor-001 | Polling Agent Pattern | TODO | - | - |

---

## Design Decision Tracking

| Decision | Option A (Aktuell) | Option B (Polling Agent) | Status |
|----------|-------------------|--------------------------|---------|
| Polling Agent | ❌ Nein | ✅ Ja | ❌ NOT DECIDED |
| Direct Spawn | ✅ Ja | ❌ Nein | ❌ NOT DECIDED |
| CLI Only | ✅ Ja | ✅ Ja (oder Hybrid) | ✅ CLI IS OK |
| Gateway API Fallback | ❌ Nein | ❌ Nein (oder optional) | ❌ OPTIONAL |

---

## Notes

- See `ARCHITECTURE-REVIEW-UPDATED.md` for detailed analysis
- CLI is **OK** for daemon - the problem is architecture, not technical method
- **IMPORTANT:** Decide Option A vs B before fixing bugs!
- Option B is recommended but requires larger refactoring
- All Critical and High bugs must be fixed before production use (Option A)
- If Option B, fewer bugs apply (simpler architecture)
