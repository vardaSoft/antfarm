# Architekturreview: Antfarm Daemon Implementierung

## Executive Summary

Die vardaSoft-Fork von Antfarm führt eine alternative Scheduler-Implementierung (Daemon) neben der etablierten Cron-basierten Implementierung ein. Die Implementierung enthält **mehrere kritische Architekturprobleme** und **potenzielle Datenverlust-Szenarien**, die sofort behoben werden müssen.

**Status:** ⚠️ **KEINE PRODUKTIONSVERWENDUNG OHNE FIXES**

---

## 1. Zusammenfassung der Implementierung

### 1.1 Installierte Daemon-Struktur

```
/tmp/antfarm-daemon/src/daemon/
├── daemon.js       (Entry point, 1602 bytes)
├── daemon.ts       (Main daemon logic, 6968 bytes)
├── daemonctl.ts    (Control interface, 2908 bytes)
└── spawner.ts      (Session spawning, 8788 bytes)
```

### 1.2 Implementierungsübersicht

| Komponente | Beschreibung | Status |
|------------|-------------|--------|
| **daemon.ts** | Hauptdaemon-Loop mit Intervall-Polling (default 30s) | ⚠️ Probleme identifiziert |
| **daemonctl.ts** | Start/Stop/Status Steuerfunktionen | ✅ Funktional |
| **spawner.ts** | Sessions spawn via OpenClaw CLI | ❌ **KRITISCHER BUG** |
| **DB Erweiterung** | Neue Tabelle `daemon_active_sessions` | ⚠️ Konflikt mit Cron |
| **CLI Integration** | `antfarm spawner [start|stop|status]` | ✅ Integriert |

---

## 2. Architekturgegenüberstellung: Cron vs Daemon

### 2.1 Scheduler-Design-Philosophy

| Aspect | Cron (agent-cron.ts) | Daemon (daemon.ts) |
|--------|---------------------|-------------------|
| **Trigger** | Externer Cron-Dienst via Gateway API | Interner `setInterval` Loop |
| **Polling Intervall** | 5 Minuten (DEFAULT_EVERY_MS) | 30 Sekunden (default) |
| **Session Spawn** | Via `createAgentCronJob()` → Gateway | Via `execFile(openclaw, sessions spawn)` |
| **Zwei-Phasen** | Ja (pollingModel → workModel) | Nein (direktes Spawn) |
| **Active Sessions Tracking** | Implicit (via Cron engine) | Explicit (via `daemon_active_sessions`) |
| **Graceful Shutdown** | Cron-Tear-down bei Run-Ende | Signal Handler |
| **Resource Cleanup** | Via `teardownWorkflowCronsIfIdle()` | Via `cleanupStaleSessions()` |

### 2.2 Workflow-Ausführung

**Cron-Pfad:**
```
Run Start → ensureWorkflowCrons() → createAgentCronJob()
  → Cron Engine spawns sessions → step peek → step claim → task execution
  → step complete/step fail → advancePipeline() → teardownWorkflowCronsIfIdle()
```

**Daemon-Pfad:**
```
Run Start → startDaemon() → setInterval(30s)
  → runDaemonLoop() → peekAndSpawn()
    → peekStep() → claimStep() → spawnAgentSession()
      → execFile("openclaw", "sessions spawn", stdin=prompt)
    → cleanupAbandonedSteps() → cleanupStaleSessions()
```

---

## 3. Gefundene Bugs (mit Prioritäten)

### 🔴 CRITICAL #1: Sessions Spawn via CLI statt Gateway API

**Ort:** `/tmp/antfarm-daemon/src/daemon/spawner.ts` Zeilen ~136-163

```typescript
// BUG: Falsche Implementierung
const args = [
  "sessions", "spawn",
  "--agent", agentId,
  "--model", model,
  "--think", "high",
  "--timeout", "1800",
];

const child = execFile(openclawBin, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 30000 // 30 Sekunden timeout für spawn Befehl
} as any);
```

**Probleme:**
1. Die Referenz-Implementierung zeigt **HTTP POST** an `/api/tools/call` mit `sessions_spawn` tool
2. Die Daemon-Implementierung verwendet **CLI execFile()** was nicht kompatibel ist
3. Work prompt wird via **stdin** übergeben, aber die API erwartet **JSON payload**
4. Keine korrekte Rückgabe-Verarbeitung von Sessions-Metadaten (session_id, etc.)

**Erwartetes Format:**
```typescript
const response = await fetch(GATEWAY_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tool: "sessions_spawn",
    args: {
      task: workPrompt,
      agent_id: agentId,
      thinking: "high",
      timeout_ms: 60 * 60 * 1000
    }
  })
});
```

**Auswirkung:** Sessions werden wahrscheinlich nicht korrekt gestartet oder sind nicht trackbar.

**Fix-Anforderung:** Rewrite von `spawnAgentSession()` um die OpenClaw Gateway API direkt zu verwenden.

---

### 🔴 CRITICAL #2: Inkonsistente Active Sessions Tracking

**Ort:** `/tmp/antfarm-daemon/src/daemon/spawner.ts` Zeilen ~37-48

```typescript
// Prüft auf existierende Sessions vor dem Spawn
const existingSession = db.prepare(
  "SELECT agent_id FROM daemon_active_sessions WHERE agent_id = ?"
).get(agentId) as ActiveSession | undefined;

if (existingSession) {
  console.warn(`Skipping spawn for ${agentId} - agent already has active session`);
  return { spawned: false };
}
```

**Probleme:**
1. Cron-basierte Sessions werden **nicht** in `daemon_active_sessions` getrackt
2. Wenn Cron und Daemon **parallel laufen**, überlappen sich Sessions
3. Kein "scheduler lock" in der `runs` Tabelle (scheduler: "cron" | "daemon")
4. Cleanup läuft nur für Daemon-Sessions (`cleanupStaleSessions()`)

**Auswirkung:** Doppelte Ausführung des gleichen Steps bei gemischter Scheduler-Nutzung.

**Fix-Anforderung:**
- Scheduler-Check in `runDaemonLoop()`: Überspringe Runs mit `scheduler != 'daemon'`
- Oder: Füge 'scheduler' Spalte zu `daemon_active_sessions` hinzu

---

### 🟠 HIGH #3: Race Condition beim Session Tracking

**Ort:** `/tmp/antfarm-daemon/src/daemon/spawner.ts` Zeilen ~62-90

```typescript
// Session wird EINGEFÜGT vor dem eigentlichen Spawn
db.prepare(
  "INSERT INTO daemon_active_sessions (agent_id, step_id, run_id, spawned_at) VALUES (?, ?, ?, ?)"
).run(agentId, stepId, runId, now);
// ... spawn logic ...

// Löschen bei Completion/Failure
db.prepare(
  "DELETE FROM daemon_active_sessions WHERE agent_id = ? AND step_id = ?"
).run(agentId, stepId);
```

**Probleme:**
1. Das `DELETE` passiert im `child.on('close')` Handler – aber was passiert bei einem Daemon-Crash?
2. Kein Transaktion-Guard zwischen INSERT und Spawn
3. Wenn spawn fehlschlägt, wird der Eintrag NICHT gelöscht (Bug in error handler Zeile ~115)
4. `cleanupStaleSessions()` (45 min) ist zu lange für Race Conditions

**Auswirkung:** Zombie-Einträge blockieren neue Sessions, bis nach 45 Minuten Cleanup.

**Fix-Anforderung:**
- DELETE im `catch` Block korrigieren
- Kürzeres Stale-Timeout (z.B. 15 min) oder Heartbeat-Updates

---

### 🟠 HIGH #4: Daemon Loop ineffizient bei vielen Workflows

**Ort:** `/tmp/antfarm-daemon/src/daemon/daemon.ts` Zeilen ~70-110

```typescript
async function runDaemonLoop(workflowIds?: string[]): Promise<void> {
  const db = getDb();

  // Holt ALLE aktiven Workflows
  const activeWorkflows = db.prepare(runsQuery).all(...runsParams);

  for (const workflowRecord of activeWorkflows) {
    // Lädt die komplette workflow.yml für JEDEN Loop
    const workflow: WorkflowSpec = await loadWorkflowSpec(workflowDir);

    for (const agent of workflow.agents) {
      // peekAndSpawn für JEDEN Agent
      const result = await peekAndSpawn(agentId, workflow);
    }
  }
}
```

**Probleme:**
1. `loadWorkflowSpec()` liest die Datei und parst YAML bei JEDEM Loop (alle 30s!)
2. Kein Caching von WorkflowSpecs
3. Bei 10 Workflows mit 6 Agents = 60 File I/O Operationen alle 30s

**Auswirkung:** Hohe Disk-I/O und CPU Last bei vielen Workflows.

**Fix-Anforderung:** WorkflowSpec Caching mit TTL (z.B. 5 min).

---

### 🟡 MEDIUM #5: Redundante Dateien (daemon.js und daemon.ts)

**Ort:** `/tmp/antfarm-daemon/src/daemon/`

```bash
-rw-r--r-- 1 node node 1602 Feb 21 00:17 daemon.js
-rw-r--r-- 1 node node 6968 Feb 21 12:51 daemon.ts
```

**Probleme:**
1. `daemon.js` ist ein kompiliertes Artefakt von `daemon.ts`
2. Beide werden versioniert → unnötige Repository-Inflation
3. Risiko: `.gitignore` schließt `*.js` nicht aus

**Auswirkung:** Versionskonflikte und veraltete Artefakte im Repo.

**Fix-Anforderung:** Löschen von `daemon.js` und `execFile("node daemon.js")` ändern zu `node daemon.ts` (oder verwenden von dist files).

---

### 🟡 MEDIUM #6: Fehlender Timeout-Default in spawnAgentSession

**Ort:** `/tmp/antfarm-daemon/src/daemon/spawner.ts` Zeilen ~143

```typescript
const args = [
  "sessions", "spawn",
  "--agent", agentId,
  "--model", model,
  "--think", "high",
  "--timeout", "1800", // 30 minutes hardcoded
];
```

**Probleme:**
1. Timeout ist hardcoded auf 1800s (30 min)
2. Workflow `agent.timeoutSeconds` wird **nicht** verwendet
3. Kein workflow-level timeout (vs Cron: `workflow.polling.timeoutSeconds`)

**Auswirkung:** Agents laufen zu lange oder zu kurz.

**Fix-Anforderung:** Timeout aus `agent.timeoutSeconds` oder `workflow.polling.timeoutSeconds` lesen.

---

### 🟢 LOW #7: Ineffiziente Cleanup Abfragen

**Ort:** `/tmp/antfarm-daemon/src/daemon/spawner.ts` Zeilen ~185-210

```typescript
export function cleanupCompletedSessions(): void {
  // Joins mit UNOPTIMIERTER where clause
  const completedSessions = db.prepare(`
    SELECT s.agent_id, s.step_id
    FROM daemon_active_sessions s
    LEFT JOIN steps st ON s.step_id = st.id
    WHERE st.status NOT IN ('pending', 'running') OR st.status IS NULL
  `).all();
```

**Probleme:**
1. Kein Index auf `steps.status`
2. `LEFT JOIN` ist notwendig aber langsam ohne Index
3. Diese Funktion wird im Code aufgerufen aber **niemals** im Main-Daemon-Loop

**Auswirkung:** Unbenutzter Code, der bei manuellem Aufruf langsam ist.

**Fix-Anforderung:** Index hinzufügen oder Funktion im Daemon-Loop integrieren.

---

### 🟢 LOW #8: Fehlende Integrationstests

**Ort:** `/tmp/antfarm-daemon/src/tests/spawner-unit.test.ts`

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("spawner unit tests", () => {
  it("should compile without errors", () => {
    // This test simply verifies that the spawner module compiles correctly
    assert.ok(true);
  });
});
```

**Probleme:**
1. Keine echten Tests, nur Kompilierungstest
2. Keine Integrationstests für Daemon-Loop
3. Keine Mock-Tests für OpenClaw API calls

**Auswirkung:** Keine Qualitätssicherung für Daemon-Logik.

**Fix-Anforderung:** Echte Unit- und Integrationstests schreiben.

---

## 4. Code Qualität Assessment

### 4.1 Positiv

| Aspekt | Bewertung | Details |
|--------|-----------|---------|
| **Code Style** | ✅ Gut | Konsistentes TypeScript, gute Namenskonventionen |
| **Error Handling** | ✅ Gut | Try-catch Blöcke, Logging |
| **DB Design** | ✅ Gut | `daemon_active_sessions` Tabelle ist logisch |
| **Graceful Shutdown** | ✅ Gut | SIGTERM/SIGINT Handler implementiert |

### 4.2 Verbesserungspotenzial

| Aspekt | Bewertung | Details |
|--------|-----------|---------|
| **Architektur** | ⚠️ Mittelmäßig | Cron und Daemon haben unterschiedliche Konzepte |
| **Testing** | ❌ Unzureichend | Keine echten Tests vorhanden |
| **Performance** | ⚠️ Mittelmäßig | Kein Caching, viele DB-Abfragen |
| **Dokumentation** | ⚠️ Mittelmäßig | Keine API-Dokumentation für spawnAgentSession |

---

## 5. Empfehlungen

### 5.1 Kurzfristig (Fix sofort)

1. **Fix CRITICAL #1:** Rewrite von `spawnAgentSession()` um OpenClaw Gateway API zu verwenden
2. **Fix CRITICAL #2:** Scheduler-Lock in `runDaemonLoop()` hinzufügen
3. **Fix HIGH #3:** Race Condition im Session Tracking beheben
4. **Fix MEDIUM #6:** Timeout aus Workflow Config lesen

### 5.2 Mittelfristig (nächste 2 Wochen)

5. **Fix HIGH #4:** WorkflowSpec Caching implementieren
6. **Fix MEDIUM #5:** Redundante `.js` Dateien entfernen
7. **Hinzufügen:** Echte Unit- und Integrationstests
8. **Dokumentation:** API-Dokumentation für Daemon-Komponenten

### 5.3 Langfristig (Architektur-Review)

9. **Evaluation:** Cron vs Daemon → Sollte man sich für EINEN Scheduler entscheiden?
10. **Migration:** Plan für Migration von Cron zu Daemon (oder umgekehrt)
11. **Monitoring:** Daemon-Metadaten (last seen active sessions, etc.)
12. **Observability:** Prometheus-Metrics für Daemon-Performance

---

## 6. Input für Bug Fix Workflow

### 6.1 Bug #1: Sessions Spawn via Gateway API

```yaml
priority: critical
title: "Daemon uses CLI instead of Gateway API for session spawn"
component: src/daemon/spawner.ts
steps:
  - "Rewrite spawnAgentSession() to use fetch() with /api/tools/call"
  - "Use sessions_spawn tool instead of execFile('openclaw', 'sessions spawn')"
  - "Handle session response (session_id, etc.) correctly"
  - "Add error handling for Gateway API failures"
acceptance_criteria:
  - "Spawned sessions are trackable via OpenClaw Gateway"
  - "Session metadata (session_id, agent_id, etc.) is stored correctly"
  - "Error on spawn failure removes record from daemon_active_sessions"
```

### 6.2 Bug #2: Scheduler Conflict Prevention

```yaml
priority: critical
title: "Daemon processes cron-scheduled runs incorrectly"
component: src/daemon/daemon.ts
steps:
  - "Add WHERE clause: scheduler = 'daemon' to active workloads query"
  - "Add 'scheduler' column to daemon_active_sessions table"
  - "Skip daemon-spawning for runs with scheduler = 'cron'"
acceptance_criteria:
  - "daemon.ts never spawns sessions for cron-scheduled runs"
  - "Cron runs are never processed by daemon loop"
  - "No duplicate sessions across schedulers"
```

### 6.3 Bug #3: Session Tracking Race Condition

```yaml
priority: high
title: "Daemon_active_sessions entries not removed on spawn failure"
component: src/daemon/spawner.ts
steps:
  - "Fix missing DELETE in catch block (line ~115)"
  - "Wrap INSERT + spawn in transaction or use try/finally pattern"
  - "Reduce stale session timeout to 15 minutes"
acceptance_criteria:
  - "Failed spawn always removes record from daemon_active_sessions"
  - "No orphaned entries block subsequent spawns for >15min"
```

### 6.4 Enhancement #1: WorkflowSpec Caching

```yaml
priority: high
title: "Daemon loads workflow.yml from disk on every loop iteration"
component: src/daemon/daemon.ts
steps:
  - "Add in-memory cache with TTL (5 minutes)"
  - "Cache invalidate on workflow.spec file modification"
  - "Add metrics: cache_hit_rate"
acceptance_criteria:
  - "workflow.yml loaded at most once per TTL period"
  - "Cache invalidates when workflow.yml changes"
  - "Reduced disk I/O in daemon loop"
```

---

## 7. Architekturbewertung

### 7.1 Cron vs Daemon: Entscheidungshilfe

| Kriterium | Cron | Daemon | Empfehlung |
|-----------|------|--------|------------|
| **Vertrautheit** | Bewährt, produziert | Neu, experimentell | Cron bevorzugen |
| **Wiederverwendbarkeit** | Nutzt OpenClaw-Infrastruktur | Eigenständige Infrastruktur | Cron bevorzugen |
| **Observability** | Gateway Logs vorhanden | Custom Logs nötig | Cron bevorzugen |
| **Performance** | Effizient durch Gateway | I/O-lastig ohne Caching | Cron bevorzugen |
| **Flexibilität** | Gateway-Konfiguration | Hardcodierte Polling-Intervalle | Cron bevorzugen |
| **Debugging** | Kann über Gateway debugged werden | Erfordert Daemon-Logs | Cron bevorzugen |

**Empfehlung:** **Bei Cron bleiben** und Daemon nur als experimentelles Feature implementieren, bis es komplett getestet ist.

### 7.2 Agent Konfiguration: Werden Agents aus workflow.yml verwendet?

**Analyse der workflow.yml Datei:**

Die `feature-dev` workflow.yml konfiguriert 6 Agents:
- `planner` (nvGLM4.7, role: analysis)
- `setup` (nvQwen3Code, role: coding)
- `developer` (nvQwen3Code, role: coding)
- `verifier` (nvGLM4.7, role: verification)
- `tester` (nvGLM4.7, role: testing)
- `reviewer` (nvGLM4.7, role: analysis)

**Daemon-Integration:**

✅ **JA**, die Daemon-Implementierung verwendet die Agents korrekt:

```typescript
// daemon.ts Zeilen ~80-95
const workflow: WorkflowSpec = await loadWorkflowSpec(workflowDir);

for (const agent of workflow.agents) {
  const agentId = `${workflowId}_${agent.id}`;
  const result = await peekAndSpawn(agentId, workflow);
}
```

Jeder Agent aus workflow.yml wird im Daemon-Loop überprüft und bei Bedarf gestartet.

**Modell-Konfiguration:**

```typescript
// spawner.ts Zeilen ~54-58
const agent = workflow.agents.find(a => a.id === agentId.split('_')[1]);
const model = agent?.model ?? "default";
```

Das Modell wird korrekt aus `agent.model` gelesen. ⚠️ ABER: `agent.pollingModel` (wichtiger für Cron-Zwei-Phasen-Design) wird ignoriert.

---

## 8. Logische Konsistenz: Inkonsistenzen und Widersprüche

### 8.1 Cron vs Daemon - Unterschiedliche Polling-Modelle

**Cron (agent-cron.ts):**
- Phase 1: `pollingModel` (z.B. Phi3Mini4k) für lightweight peek
- Phase 2: `workModel` (z.B. nvQwen3Code) für eigentliche Arbeit via `sessions_spawn` call im prompt

**Daemon (spawner.ts):**
- Nur EIN Modell direkt in `spawnAgentSession()` verwendet
- Kein Zwei-Phasen-Design
- `pollingModel` aus workflow.yml wird ignoriert

**Problem:** Die Daemon-Implementierung bricht das bewährte Zwei-Phasen-Design der Cron-Implementierung. Dies führt zu ineffizienter Ressourcennutzung.

---

### 8.2 Timeout-Inkonsistenz

**Cron:**
```typescript
const timeoutSeconds = workflowPollingTimeout; // Default: 120s für polling
// workModel timeout wird über sessions_spawn args übergeben
```

**Daemon:**
```typescript
"--timeout", "1800", // Hardcoded 1800s = 30 min
// Kein reference zu workflow.polling.timeoutSeconds oder agent.timeoutSeconds
```

**Problem:** Timeout-Strategien sind inkonsistent.

---

### 8.3 Abandoned Step Cleanup Inkonsistenz

**Cron:**
- Wird in `claimStep()` aufgerufen (throttled: alle 5 Min)
- Benutzt `ABANDONED_THRESHOLD_MS`

**Daemon:**
- Wird in separatem Interval aufgerufen (alle 5 Min)
- Benutzt dieselbe `cleanupAbandonedSteps()` Funktion ⚠️

**Problem:** Beide Schedulern rufen die gleiche Cleanup-Funktion auf, aber mit anderem Timing und Kontext. Dies kann zu Race Conditions führen, wenn beide Scheduler parallel laufen.

---

## 9. Empfehlung: Sollte man Daemon oder Cron verwenden?

### 9.1 Bewertung

| Faktor | Cron | Daemon |
|--------|------|--------|
| **Implementierung Qualität** | ✅ Bewährt, getestet | ⚠️ Experimentell, Bugs |
| **Gateway Integration** | ✅ Vollständig integriert | ❌ Falsche API-Nutzung |
| **Performance** | ✅ Effizient (gateway-gemangelt) | ⚠️ I/O-lastig (no caching) |
| **Testing** | ⚠️ Kaum Tests vorhanden | ❌ Keine echten Tests |
| **Dokumentation** | ⚠️ Minimal | ⚠️ Minimal |
| **Produktionsready** | ✅ Ja | ❌ Nein |

### 9.2 Entscheidungshilfe

**Für Cron:**
- Wenn Sie Stabilität und Bewährtheit brauchen
- Wenn Sie Gateway-Integration voll nutzen wollen
- Wenn Sie minimale Änderungen wünschen
- Wenn Sie keine Zeit für extensive testing haben

**Für Daemon:**
- Wenn Sie ein eigenständig kontrolliertes System wollen
- Wenn Sie weniger Abhängigkeit von Gateway-Cron-Engine haben
- Wenn Sie bereit sind, die kritischen Bugs zu fixen und Tests zu schreiben
- Wenn Sie ein experimentelles Feature evaluieren möchten

### 9.3 Empfehlung des Reviewers

**⚠️ BLEIBEN BEI CRON** für die Produktion. Die Daemon-Implementierung ist als Research-Feature gedacht, nicht für den Einsatz ohne umfangreiches Testing und Bug-Fixing.

---

## 10. Zusammenfassung

Die vardaSoft-Fork führt eine alternative Daemon-Scheduler-Implementierung ein, aber die Analyse zeigt **kritische Architekturprobleme**, die sofort behoben werden müssen:

### Kritische Probleme (CRITICAL):
1. ❌ Sessions Spawn nutzt CLI statt Gateway API
2. ❌ Scheduler-Konflikt zwischen Cron und Daemon

### Hohe Priorität (HIGH):
3. ⚠️ Race Condition im Session Tracking
4. ⚠ineffizienter Daemon Loop ohne Caching

### Mittlere Priorität (MEDIUM):
5. ⚠️ Redundante Dateien (daemon.js/daemon.ts)
6. ⚠️ Fehlende Timeout-Konfiguration

### Gute Aspekte:
- ✅ Sauberer Code-Stil
- ✅ Gute DB-Design-Erweiterung
- ✅ Graceful Shutdown implementiert
- ✅ CLI-Integration funktioniert

### Empfehlung:
1. **NICHT auf Daemon in der Produktion umsteigen** bis alle CRITICAL+HIGH Bugs behoben sind
2. Beide Scheduler parallel laufen lassen ist **gefährlich** (Scheduler-Konflikt)
3. Langfristige Entscheidung: Cron als Haupt-Scheduler behalten, Daemon optional für Szenarien ohne Gateway

---

**Erstellt:** 2026-02-21
**Reviewer:** Architektur-Review Subagent
**Next Steps:** Bug Fix Workflow basierend auf Abschnitt 6 starten