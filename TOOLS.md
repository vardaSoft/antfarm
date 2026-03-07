# OpenClaw Tools Reference

Dieses Dokument enthält wichtige Informationen zur Verwendung der wichtigsten OpenClaw Tools, speziell für den Antfarm Workflow.

---

## Table of Contents

1. [sessions_spawn](#sessions_spawn) - Sub-Agents starten
2. [sessions_list](#sessions_list) - Sessions auflisten
3. [sessions_history](#sessions_history) - History abrufen
4. [sessions_send](#sessions_send) - Messages senden
5. [subagents](#subagents) - Sub-Agent Management

---

## sessions_spawn

### Zusammenfassung
Startet einen Sub-Agent in einer isolierten Session. Nicht blockierend - gibt sofort mit `status: "accepted"` zurück.

### Parameter

```typescript
sessions_spawn({
  // REQUIRED
  task: string,              // Die Task-Beschreibung
  timeoutSeconds?: number,  // Gesamte Timeout in Sekunden

  // OPTIONAL: Identifikation
  label?: string,          // Label für Logs und UI (z.B. "qwen3code-daemon-test")
  cleanup?: "delete"|"keep", // Cleanup-Modus (default: "keep")

  // OPTIONAL: Modell-Konfiguration
  model?: string,          // Modell-Override (ID oder Alias)
  thinking?: string,       // Thinking-Level-Override

  // OPTIONAL: Agent-Konfiguration
  agentId?: string,        // Agent-ID (default: aktueller Agent)
  runTimeoutSeconds?: number, // Abort nach N Sekunden (default: 0 = unlimited)

  // OPTIONAL: Session-Modus
  mode?: "run"|"session", // Mode (default: "run")
  thread?: boolean        // Thread-Binding für Channel-Plugins
})
```

### Model-Override

Das Modell kann als String übergeben werden:

```typescript
// Vollständige Modell-ID
model: "nvidia/z-ai/glm4.7"

// Alias aus Config
model: "nvGLM4.7"

// Provider + Model
model: "qwen/qwen3-coder-480b-a35b-instruct"
```

### Beispiele

**Einfacher Start:**

```typescript
sessions_spawn({
  task: "Analysiere den Daemon Code...",
  label: "daemon-analysis",
  timeoutSeconds: 3600
})
```

**Mit spezifischem Modell:**

```typescript
sessions_spawn({
  task: "Analysiere den Daemon Code...",
  model: "qwen/qwen3-coder-480b-a35b-instruct",  // nvQwen3Code
  label: "qwen3code-daemon-test",
  timeoutSeconds: 10800  // 3h
})
```

**Mehrere Agenten mit unterschiedlichen Modellen:**

```typescript
// Agent 1: Qwen3code
sessions_spawn({
  task: "Analyse den Daemon Code...",
  model: "qwen/qwen3-coder-480b-a35b-instruct",
  label: "qwen3code-daemon-test",
  timeoutSeconds: 10800
})

// Agent 2: GLM5
sessions_spawn({
  task: "Analyse den Daemon Code...",
  model: "z-ai/glm5",  // nvGLM5
  label: "glm5-daemon-test",
  timeoutSeconds: 10800
})

// Agent 3: Kimi2.5
sessions_spawn({
  task: "Analysiere den Daemon Code...",
  model: "moonshotai/kimi-k2.5",  // nvKimi2.5
  label: "kimi2-5-daemon-test",
  timeoutSeconds: 10800
})
```

### Modell-Registrierung

Alle Modelle müssen in `openclaw.json` registriert sein:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "nvidia/z-ai/glm4.7": { "alias": "nvGLM4.7" },
        "nvidia/z-ai/glm5": { "alias": "nvGLM5" },
        "nvidia/moonshotai/kimi-k2.5": { "alias": "nvKimi2.5" },
        "nvidia/qwen/qwen3-coder-480b-a35b-instruct": { "alias": "nvQwen3Code" },
        "nvidia/deepseek-ai/deepseek-v3.2": { "alias": "nvDeepseekV3.2" },
        "synthetic/hf:moonshotai/Kimi-K2.5": { "alias": "synKimi2.5" },
        "synthetic/hf:zai-org/GLM-4.7": { "alias": "synGLM4.7" }
      }
    }
  }
}
```

### Rückgabewerte

**Sofortige Antwort (non-blocking):**

```json
{
  "status": "accepted",
  "runId": "7ae2842e-4365-4f9b-b9fc-8bde62d4cc2e",
  "childSessionKey": "agent:main:subagent:f3be03fe-0b4f-45f3-adb4-cc67db8707ce",
  "mode": "run",
  "note": "auto-announces on completion",
  "modelApplied": true
}
```

### Wichtige Hinweise

- ✅ **Nicht blockierend** - Startet im Hintergrund
- ✅ **Auto-Announce** - Ergebnis wird im Requester-Channel angekündigt
- ✅ **Isolierte Session** - Sub-Agent hat eigenen Kontext
- ❌ Kein Sub-Agent → Sub-Agent Spawning erlaubt
- ❌ Modelle müssen registriert sein

---

## sessions_list

### Zusammenfassung
Listet alle Sessions als Array auf.

### Parameter

```typescript
sessions_list({
  kinds?: string[],        // ["main","group","cron","hook","node","other"]
  limit?: number,         // Max rows (default: 200)
  activeMinutes?: number, // Sessions in den letzten N Minuten
  messageLimit?: number   // 0 = keine Messages, >0 = letzte N Messages
})
```

### Beispiel

```typescript
sessions_list({
  kinds: ["subagent"],
  activeMinutes: 5,
  messageLimit: 10
})
```

### Row Shape

```json
{
  "key": "agent:main:subagent:f3be03fe-0b4f-45f3-adb4-cc67db8707ce",
  "kind": "subagent",
  "sessionId": "122b1b5a-e433-4d34-9ad6-29a8bf477564",
  "label": "qwen3code-daemon-test",
  "model": "nvidia/z-ai/glm4.7",
  "status": "running",
  "runtime": "2m",
  "runtimeMs": 120089,
  "startedAt": 1772401472989
}
```

---

## sessions_history

### Zusammenfassung
Ruft den Transcript einer Session ab.

### Parameter

```typescript
sessions_history({
  sessionKey: string,    // Required (Key oder sessionId)
  limit?: number,        // Max messages (server clamped)
  includeTools?: boolean  // Include tool results (default: false)
})
```

### Beispiel

```typescript
sessions_history({
  sessionKey: "agent:main:subagent:f3be03fe-0b4f-45f3-adb4-cc67db8707ce",
  limit: 50,
  includeTools: true
})
```

---

## sessions_send

### Zusammenfassung
Sendet eine Message in eine andere Session.

### Parameter

```typescript
sessions_send({
  sessionKey: string,   // Required
  message: string,      // Required
  timeoutSeconds?: number  // 0 = fire-and-forget, >0 = wait
})
```

### Beispiel

```typescript
sessions_send({
  sessionKey: "agent:main:main",
  message: "Update: Analyse abgeschlossen - siehe /tmp/agent-report.md",
  timeoutSeconds: 30
})
```

---

## subagents

### Zusammenfassung
Verwaltet gestartete Sub-Agenten (list, kill, steer).

### Actions

```typescript
subagents({
  action: "list"|"kill"|"steer",
  target?: string,      // Label für kill/steer
  message?: string     // Nachricht für steer
})
```

### Beispiel

```typescript
// Alle Sub-Agenten auflisten
subagents({ action: "list", recentMinutes: 5 })

// Einen Agenten steuern
subagents({
  action: "steer",
  target: "qwen3code-daemon-test",
  message: "Setze dein Modell auf qwen/qwen3-coder-480b-a35b-instruct"
})

// Agenten beenden
subagents({
  action: "kill",
  target: "glm5-daemon-test"
})
```

---

## Praktische Workflows

### Workflow 1: Parallele Analyse mit 3 Agenten

```typescript
// Alle 3 Agenten starten
const agents = ["qwen/qwen3-coder-480b-a35b-instruct", "z-ai/glm5", "moonshotai/kimi-k2.5"];

agents.forEach((model, i) => {
  sessions_spawn({
    task: "Analysiere den Daemon Code...",
    model: model,
    label: `agent-${i}-daemon-test`,
    timeoutSeconds: 10800  // 3h
  });
});
```

### Workflow 2: Ergebnis-Sammlung nach Completion

```typescript
// Periodisch prüfen ob alle fertig
subagents({ action: "list", recentMinutes: 30 });

// Wenn alle done → Reports sammeln
const reports = [
  "/tmp/agent-1-qwen3code-daemon-analysis.md",
  "/tmp/agent-2-glm5-daemon-analysis.md",
  "/tmp/agent-3-kimi2-5-daemon-analysis.md"
];

// Konsolidierten Bericht erstellen
```

### Workflow 3: Modell-spezifische Tasks

```typescript
// Code-spezialist
sessions_spawn({
  task: "Optimiere TypeScript Code...",
  model: "qwen/qwen3-coder-480b-a35b-instruct",
  label: "code-optimizer"
});

// General Purpose
sessions_spawn({
  task: "Analysiere Design-Patterns...",
  model: "z-ai/glm5",
  label: "design-analyst"
});

// Schneller Small-Talk
sessions.spawn({
  task: "Antworte kurz auf Frage...",
  model: "nvidia/microsoft/phi-3-mini-4k-instruct",
  label: "quick-response"
});
```

---

## Modells in Antfarm Config

Standard-Modelle (aus `openclaw.json`):

| Alias | Modell-ID | Spec | Einsatz |
|-------|-----------|------|---------|
| nvGLM4.7 | `nvidia/z-ai/glm4.7` | 160K / 8K | Standard/Allzweck |
| nvGLM5 | `nvidia/z-ai/glm5` | 200K / 16K | Large Context |
| nvKimi2.5 | `nvidia/moonshotai/kimi-k2.5` | 256K / 16K | Multimodal |
| nvQwen3Code | `nvidia/qwen/qwen3-coder-480b-a35b-instruct` | 256K / 4K | Code-spezialist |
| nvDeepseekV3.2 | `nvidia/deepseek-ai/deepseek-v3.2` | 128K / 8K | Coding |
| synGLM4.7 | `synthetic/hf:zai-org/GLM-4.7` | 200K / 8K | Pay-as-you-go |

---

## Häufige Fehler

### Fehler: Model not registered

```
Error: Model "unknown-model" not found
```

**Lösung:** Modell in `openclaw.json` registrieren oder Alias verwenden.

### Fehler: Agent not allowed

```
Error: Agent id "external-agent" not in allow list
```

**Lösung:** Agent zu `agents.defaults.subagents.allowAgents` hinzufügen oder `*` für alle.

### Models werden nicht übernommen

Wenn `modelApplied: false` steht → Modell ist nicht registriert **oder** Allowlist blockiert.

---

## Referenzen

- https://docs.openclaw.ai/concepts/session-tool (sessions_spawn Details)
- https://docs.openclaw.ai/tools (Tool-Erklärung)
- https://github.com/openclaw/openclaw/issues (GitHub Issues)

---

**Letztes Update:** 2026-03-01 23:00 CET
