# Architekturreview: Antfarm Daemon Implementierung (Aktualisiert)
## Mit CLI vs Gateway API Analyse und Architekturunterschieden

**Datum:** 2026-02-21  
**Status:** 🔄 Basierend auf Netzrecherche und GitHub PR #31 Analyse

---

## 📋 Update-Zusammenfassung

Nach Prüfung von:
- OpenClaw Gateway API Dokumentation
- GitHub PR #31: `feat: event-driven session spawner`
- Original Antfarm Cron Implementierung (`agent-cron.ts` + `gateway-api.ts`)

**Wichtige Erkenntnis:**
- ✅ CLI ist **nicht prinzipiell falsch** für die Daemon-Implementierung
- ⚠️ Das eigentliche Problem ist die **Session-Architektur**, nicht die technische Methode

---

## 1. CLI vs Gateway API: Gegenüberstellung

### 1.1 Zwei Varianten für sessions_spawn

**Variante A: CLI (aktueller Daemon)**
```typescript
// spawner.ts
const child = execFile(openclawBin, [
  "sessions", "spawn",
  "--agent", agentId,
  "--model", model,
  "--timeout", "1800"
], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stdin.write(workPrompt);
child.stdin.end();
```

**Variante B: Gateway API (Referenz-Beispiel)**
```typescript
const response = await fetch(`${GATEWAY_URL}/api/tools/call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tool: "sessions_spawn",
    args: {
      task: workPrompt,
      agent_id: agentId,
      thinking: "high",
      timeout_ms: 60 * 60 * 1000,
    }
  })
});
```

### 1.3 Was zeigt das Original Antfarm?

Aus `/tmp/antfarm-daemon/src/installer/gateway-api.ts`:

**Antfarm nutzt ein Hybrid-Ansatz:**
```typescript
// Cron-Operationen
async function createAgentCronJobHTTP(job) { ... } // HTTP first
async function createAgentCronJobCLI(job) { ... }  // CLI fallback
```

**Pattern:** HTTP API zuerst, CLI als fallback für Robustheit.

### 1.4 Was macht der Original-Cron-Betrieb?

**WICHTIG:** Der Cron-Job spawnt NICHT direkt den Work-Agent!

```
Cron Job → Polling Agent (lightweight Model)
                ↓
         sessions_spawn (Call vom Agent selbst!)
                ↓
            Work Agent (heavy Model)
```

Aus `agent-cron.ts`:
```typescript
export function buildPollingPrompt() {
  // Der Polling Agent bekommt Anweisung, sessions_spawn zu rufen!
  return `...Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- model: "${model}"
- task: The full work prompt below...`;
}
```

### 1.5 Bewertung der drei Varianten

| Kriterium | CLI (Daemon) | Gateway API | Cron-Hybrid |
|-----------|--------------|-------------|-------------|
| **Einfachheit** | ✅ Sehr einfach | ⚠️ Auth + HTTP nötig | ⚠️ Komplex |
| **Robustheit** | ✅ Prozess-basiert | ⚠️ Network dependency | ✅ Fallback-Mechanismus |
| **Session Tracking** | ❌ Nur stdout logs | ✅ JSON metadata | ⚠️ Implicit via Cron |
| **Error Handling** | ⚠️ Exit codes | ✅ Structured errors | ✅ Retry in Cron |
| **Daemon-Tauglichkeit** | ✅ Direct control | ❌ Gateway dependency | ❌ Cron dependency |
| **Session Ownership** | ❌ Daemon besitzt Session | ❌ Gateway besitzt Session | ✅ Agent besitzt Session |

### 1.6 Fazit zu CLI vs API

**CLI ist für Daemon-Betrieb besser als reine Gateway API**, WEIL:

1. ✅ **Daemon soll Cron ersetzen** → braucht direkte Kontrolle über processes
2. ✅ **Keine Gateway dependency** → Daemon läuft auch bei Gateway-Restarts
3. ✅ **Einfacheres Monitoring** → Prozess-IDs direkt verfügbar
4. ✅ **Original Pattern für Cron-Ops** → `gateway-api.ts` nutzt auch CLI fallback

**Aber: Die beste Lösung ist Hybrid mit Fallback:**
```typescript
async function spawnAgentSession() {
  // Versuche Gateway API first
  const httpResult = await spawnAgentSessionHTTP();
  if (httpResult) return httpResult;

  // Fallback auf CLI
  return await spawnAgentSessionCLI();
}
```

---

## 2. Architekturunterschiede: Cron vs Daemon

### 2.1 Original Cron Architektur

```
┌─────────────────────────────────────────────────────────┐
│ [Run Start: scheduler = 'cron']                        │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────┐
│ ensureWorkflowCrons()                                   │
│ → createAgentCronJob() via Gateway/CLI                  │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────┐
│ Gateway Cron Engine starts                              │
│ → Polling Sessions (every 5 min, staggered)             │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────┐
│ [Polling Agent Session]                                 │
│ → peekStep() (lightweight)                              │
│ → claimStep() wenn work                                 │
│ → RUFT SELF: sessions_spawn(task, model) ←─────────┐    │
└─────────────────┬───────────────────────────────┐└──────┘
                                              │
                WORK AGENT SPAWNED                │
                vom Polling Agent                 │
                                              │
┌──────────────────────────────────────────────┴──────────┐
│ [Work Agent Session]                                    │
│ → Macht die eigentliche Arbeit                         │
│ → step complete/fail                                   │
└──────────────────────────────────────────────────────────┘
```

**Wichtig:**
- **Polling Agent** spawnt **selbst** den Work Agent via `sessions_spawn`
- Cron-Engine verwaltet nur Polling Sessions
- Work Agent ist "owned" von Polling Agent

### 2.2 Daemon Architektur (aktuelle Implementierung)

```
┌─────────────────────────────────────────────────────────┐
│ [Run Start: scheduler = 'daemon']                       │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────┐
│ startDaemon() → setInterval(30s)                        │
│ → runDaemonLoop() pollt alle aktiven Workflows          │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────┐
│ Daemon Loop Loop über active Workflows                   │
│ → peekStep() prüft ob Arbeit                            │
│ → claimStep() holt pending step                         │
│ → EXECDIRECT: openclaw sessions spawn ──────────────┐   │
└─────────────────┬───────────────────────────────┐└─────┘
                                              │
                WORK AGENT SPAWNED                │
                direkt vom Daemon                  │
                                              │
┌──────────────────────────────────────────────┴──────────┐
│ [Work Agent Session]                                    │
│ → Macht die eigentliche Arbeit                         │
│ → step complete/fail                                   │
└──────────────────────────────────────────────────────────┘
```

**Wichtig:**
- **Daemon** spawnt **direkt** den Work Agent
- Kein Polling Agent dazwischen!
- Work Agent ist "owned" vom Daemon

### 2.3 Architektur-Tabelle

| Aspect | Cron | Daemon (aktuell) | Empfohlen |
|--------|------|------------------|-----------|
| **Trigger** | Gateway → Cron Engine | setInterval(30s) | ✅ Daemon |
| **Polling Agent** | ✅ Ja (spawnt Work) | ❌ Nein | ❌ Sollte wie Cron |
| **Session Ownership** | Agent → Work Agent | Daemon → Work Agent | ⚠️ Hybrid? |
| **Dependency** | Gateway Cron Engine | Nur Node.js | ✅ Daemon |
| **Resource Mgmt** | Via Cron Engine | Via daemon_active_sessions | ⚠️ Komplex |
| **Error Recovery** | Cron Engine retries | Daemon retry logic | ✅ Daemon |
| **Flexibility** | ⚠️ Gateway config limits | ✅ Direct control | ✅ Daemon |

---

## 3. Das eigentliche Problem: Session Ownership und Architekturbruch

### 3.1 Warum der Daemon das Cron-Pattern bricht

**Cron-Pattern:**
```
Polling Agent: "Ich bin für das Polling zuständig,
               und ich spawne den Work Agent selbst"
```

**Daemon-Pattern:**
```
Daemon: "Ich mache das Polling selbst,
         und ich spawne den Work Agent"
```

**Problem:**
1. ❌ **Inkonsistente Verantwortlichkeiten:** Cron-Typ = Polling-Schicht, Daemon-Typ = No-Typ
2. ❌ **Kein proper session tracking:** Cron Sessions sind via Gateway trackable, Daemon Sessions nur in eigener DB
3. ❌ **Migration schwer:** Runs mit `scheduler='cron'` und `scheduler='daemon'` verhalten sich anders

### 3.2 Zwei-Personen-Problem

| Rolle | Cron | Daemon |
|-------|------|--------|
| **Poll Manager** | Gateway Cron Engine | Daemon Loop |
| **Work Dispatcher** | Polling Agent (via sessions_spawn) | Daemon (via execFile) |
| **Worker** | Work Agent | Work Agent |

**Problem:** Daemon übernimmt BEIDE Rollen (Poll Manager + Work Dispatcher), was zu:

1. ⚠️ Single Point of Failure: Wenn Daemon stirbt, kein neuer polling möglich
2. ⚠️ Komplexer Code: Daemon muss session management machen
3. ⚠️ Kognitive Last: Mehr Verantwortung in einer Komponente

---

## 4. Daemon-Architektur: Das INTENDED Design (Option A)

### 4.1 Warum Option A das richtige Design ist

**Der Daemon ersetzt bewusst das Cron-System mit seinen Polling Agents:**

```
Cron-System (VORHER):
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Cron Engine   │ --> │ Polling Agent   │ --> │   Work Agent    │
│   (Gateway)     │     │ (lightweight)   │     │   (heavy)       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         1                      2                       3

Daemon-System (JETZT - Option A):
┌─────────────────┐     ┌─────────────────┐
│ Daemon Process  │ --> │   Work Agent    │
│ (polling logic) │     │   (heavy)       │
└─────────────────┘     └─────────────────┘
         1                      2
```

**Vorteile des Daemon-Designs (Option A):**

| Vorteil | Erklärung |
|---------|-----------|
| ✅ **Keine Polling Agents** | Einsparung von lightweight Sessions |
| ✅ **Direkte Kontrolle** | Daemon hat volle visibility über alle Work Sessions |
| ✅ **Weniger Overhead** | Nur 1 Session pro Arbeit statt 2 |
| ✅ **Performance** | Kein zusätzlicher Agent-Layer |
| ✅ **Einfachere Logs** | Alle Session-Spawns in einem Prozess |
| ✅ **Unabhängigkeit** | Keine Cron-Engine/Gateway-Dependency |

### 4.2 Das Design ist korrekt - Bugs sind Implementation-Details

**Die Architektur ist INTENDED, nicht kaputt:**

- ✅ Daemon spawnt Work Agents direkt = **FEATURE, kein Bug**
- ✅ `daemon_active_sessions` Tabelle = **Notwendig für Tracking**
- ✅ CLI für sessions spawn = **OK für Unabhängigkeit**

**Zu fixen sind nur Implementation-Bugs, keine Architektur-Änderung nötig.**

### 4.3 Was wirklich gefixt werden muss

1. **Scheduler-Konflikt:** Daemon darf nur `scheduler='daemon'` Runs verarbeiten
2. **Session Tracking Race Condition:** Error-Handling bei Spawn-Fehlern
3. **Caching:** Performance-Optimierung (optional)
4. **Timeout-Konfiguration:** Workflow-Einstellungen respektieren

---

## 5. Aktualisierte Bug-Liste

### 🔴 CRITICAL #1: CLI ist nicht das Problem → Architektur ist das Problem!

**Status:** ~~WRONG~~ → PARTIALLY CORRECT

**Neue Analyse:**
- CLI ist **OK** für Daemon-Zwecke (besser als reine Gateway API für robustness)
- **Aber:** Sollte HTTP + CLI Fallback wie `gateway-api.ts` nutzen

**Neue Empfehlung:**
- ✅ Behalte CLI als primary für Daemon
- ✅ Füge Gateway API Fallback hinzu (optional, für compatibility)
- ❌ **Das eigentliche Problem:** Option A vs Option B (aktuell vs Polling Agent Pattern)

**Fix Priorität:**
1. Wähle Architektur-Option A oder B (Design-Entscheidung!)
2. Implementiere dann entsprechend

---

### 🟠 HIGH #1: Daemon spawnt Work Agents direkt vs Polling Pattern

**Status:** **NEU - WICHTIG**

**Problem:** Daemon bricht das etablierte Polling Agent Pattern.

**Empfehlung:** Implementiere Option B (Polling Agent).

---

### 🟠 HIGH #2: Scheduler-Konflikt bleibt kritisch

**Status:** **BLEIBT KRITISCH**

Der Daemon filtert nicht nach `scheduler = 'daemon'` und würde Sessions für cron-scheduled runs spawnen.

---

## 6. Endgültige Empfehlung

### 6.1 Kurzfristig (Minimal-Changes)

Wenn wir beim aktuellen Design bleiben wollen (Option A):

1. ✅ CLI für sessions spawn ist OK
2. ⚠️ Füge optional Gateway API fallback
3. 🔴 **Fix Scheduler-Konflikt** (CRITICAL #2 unverändert)
4. 🟠 Fix Race Conditions (HIGH #3 unverändert)

### 6.2 Mittelfristig (Bessere Architektur)

Wenn wir eine echte Cron-Ersatz-Implementierung wollen (Option B):

1. ✅ Daemon spawnt Polling Agents
2. ✅ Polling Agents spawnen Work Agents (sessions_spawn)
3. ✅ Keine daemon_active_sessions Tabelle nötig
4. ✅ Konsistent mit Cron-Architektur

### 6.3 Langfristig (Entscheidungspunkt)

| Frage | Antwort |
|-------|---------|
| **Soll Daemon Cron komplett ersetzen?** | Ja, das ist das Ziel |
| **Soll Daemon Polling Agents nutzen?** | **JA!** Für Konsistenz |
| **Soll Daemon Gateway API nutzen?** | CLI primary, API fallback okay |
| **Ist das aktuelle Design prodtions-ready?** | **NEIN**, braucht Refactoring |

---

## 7. Zusammenfassung der neuen Erkenntnisse

### 7.1 Was habe ich falsch verstanden?

❌ Ich dachte: CLI ist falsch, Gateway API ist richtig  
✅ Korrektur: CLI ist für Daemon OK, sollte aber Hybrid sein

❌ Ich dachte: sessions_spawn Muss über Gateway API geschehen  
✅ Korrektur: Original Cron nutzt sessions_spawn via Agent selbst

### 7.2 Was ist das eigentliche Problem?

❌ Nicht: CLI vs HTTP API  
✅ Sondern: Architektur-Pattern (Polling Agent vs Direct Spawn)

### 7.3 Was sollte getan werden?

1. **Design-Entscheidung:** Option A (aktuell) oder Option B (Polling Agent)
2. **Wenn Option B:** Implementiere Polling Agent Pattern
3. **Wenn Option A:** Fix alle anderen Bugs (Scheduler, Race Conditions, etc.)
4. **In beiden Fällen:** CLI + Gateway API Fallback implementieren

---

## 8. Nächste Schritte

Bitte entscheiden:

**Option A:** Aktuelles Design behalten
- Direktes spawn via CLI
- daemon_active_sessions Table
- Fix der restlichen Bugs

**Option B:** Polling Agent Pattern implementieren
- Daemon spawnt Polling Agents
- Polling Agents spawnen Work Agents (sessions_spawn)
- Keine daemon_active_sessions
- Bessere Konsistenz mit Cron

**Meine Empfehlung:** **Option B** - aber erfordert größeres Refactoring.

---

**Erstellt:** 2026-02-21  
**Update Reason:** CLI vs Gateway API Analyse basierend auf GitHub PR #31 und Original Antfarm code  
**Reviewer:** Architektur-Review Subagent
