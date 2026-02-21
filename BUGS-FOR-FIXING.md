# Bugs to Fix - Antfarm Daemon Implementation

Automatisch generiert aus der Architekturreview vom 21.02.2026.

---

## 🔴 CRITICAL BUGS (Fix Immediately)

### Bug-001: Wrong API for Session Spawn

**Component:** `src/daemon/spawner.ts` (line 136-163)

**Description:**
The daemon uses `execFile("openclaw", "sessions spawn")` instead of the OpenClaw Gateway API `POST /api/tools/call` with `sessions_spawn` tool.

**Impact:** Sessions may not spawn correctly or are not trackable.

**Steps to Fix:**
1. Rewrite `spawnAgentSession()` function
2. Use `fetch()` to call Gateway API at `http://127.0.0.1:18789/api/tools/call`
3. Pass proper JSON payload with `tool: "sessions_spawn"` and `args`
4. Handle response and session metadata correctly

**Reference Implementation:**
```typescript
async function spawnOpenClawSession() {
  const GATEWAY_URL = "http://127.0.0.1:18789/api/tools/call";
  const payload = {
    tool: "sessions_spawn",
    args: {
      task: workPrompt,
      agent_id: agentId,
      thinking: "high",
      timeout_ms: 60 * 60 * 1000,
    }
  };

  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  return result;
}
```

**Acceptance Criteria:**
- [ ] Spawned sessions are trackable via OpenClaw Gateway
- [ ] Session metadata (session_id, agent_id, etc.) is returned correctly
- [ ] Error on spawn failure removes record from `daemon_active_sessions`
- [ ] Integration test passing

**Priority:** P0

---

### Bug-002: Scheduler Conflict Prevention Missing

**Component:** `src/daemon/daemon.ts` (runDaemonLoop)

**Description:**
The daemon processes ALL active runs regardless of scheduler type, potentially spawning duplicate sessions for cron-scheduled runs.

**Impact:** Duplicate step execution when both cron and daemon schedulers are active.

**Steps to Fix:**
1. Modify `runDaemonLoop()` query to filter by `scheduler = 'daemon'`
2. Add check in `peekAndSpawn()` to verify run's scheduler
3. Optionally add `scheduler` column to `daemon_active_sessions` table

**Code Reference:**
```typescript
// Current (BROKEN):
const runsQuery = "SELECT DISTINCT workflow_id FROM runs WHERE status = 'running'";

// Fixed:
const runsQuery = "SELECT DISTINCT workflow_id FROM runs WHERE status = 'running' AND scheduler = 'daemon'";
```

**Acceptance Criteria:**
- [ ] `daemon.ts` never spawns sessions for cron-scheduled runs
- [ ] Cron runs are never processed by daemon loop
- [ ] Integration test with both schedulers verifies no duplicate execution
- [ ] Documentation updated

**Priority:** P0

---

## 🟠 HIGH PRIORITY BUGS (Fix within 1 week)

### Bug-003: Session Tracking Race Condition

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
  db.prepare("DELETE FROM daemon_active_sessions...").run();  // ❌ This line is WRONG
  throw error;
}
```

**Code After (FIXED):**
```typescript
try {
  // ... spawn logic ...
  child.on('close', () => {
    db.prepare("DELETE FROM daemon_active_sessions...").run();
  });
} catch (error) {
  db.prepare("DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?")
     .run(agentId, stepId);  // ✅ Fixed with correct params
  throw error;
}
```

**Acceptance Criteria:**
- [ ] Failed spawn always removes record from `daemon_active_sessions`
- [ ] Unit test for error path passing
- [ ] Stale session timeout reduced to 15 minutes
- [ ] Integration test verifying cleanup on failure

**Priority:** P1

---

### Bug-004: Inefficient Daemon Loop - No Caching

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
const workflowCache = new Map<string, { spec: WorkflowSpec; lastUpdated: number; ttl: number }>();
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

### Bug-006: Missing Timeout Configuration

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

**Priority:** P2

---

## 🟢 LOW PRIORITY IMPROVEMENTS

### Bug-007: Unused cleanupCompletedSessions Function

**Component:** `src/daemon/spawner.ts`

**Description:**
`cleanupCompletedSessions()` function is defined but never called in daemon loop.

**Impact:** Unused code, potential memory leak.

**Steps to Fix:**
1. Call `cleanupCompletedSessions()` in daemon loop OR
2. Remove function if not needed

**Priority:** P3

---

### Bug-008: No Real Integration Tests

**Component:** `/tmp/antfarm-daemon/src/tests/`

**Description:**
Only compilation test exists. No real unit or integration tests for daemon logic.

**Impact:** Low confidence in daemon correctness.

**Steps to Fix:**
1. Write unit tests for `peekAndSpawn()`
2. Write unit tests for `spawnAgentSession()`
3. Write integration test for daemon loop
4. Mock OpenClaw API calls

**Priority:** P3

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

1. **Fix CRITICAL bugs first** (Bug-001, Bug-002)
2. **Fix HIGH bugs next** (Bug-003, Bug-004)
3. **Fix MEDIUM bugs** (Bug-005, Bug-006)
4. **Add tests** (Bug-008)
5. **Clean up low priority** (Bug-007)

---

## Progress Tracking

| ID | Title | Status | Assignee | ETA |
|----|-------|--------|----------|-----|
| Bug-001 | Wrong API for Session Spawn | TODO | - | - |
| Bug-002 | Scheduler Conflict Prevention | TODO | - | - |
| Bug-003 | Session Tracking Race Condition | TODO | - | - |
| Bug-004 | Inefficient Daemon Loop | TODO | - | - |
| Bug-005 | Redundant Files | TODO | - | - |
| Bug-006 | Missing Timeout Configuration | TODO | - | - |
| Bug-007 | Unused cleanupCompletedSessions | TODO | - | - |
| Bug-008 | No Real Integration Tests | TODO | - | - |

---

## Notes

- See `ARCHITECTURE-REVIEW.md` for detailed analysis
- All Critical and High bugs should be fixed before production use
- Daemon is currently marked as **NOT PRODUCTION READY**
