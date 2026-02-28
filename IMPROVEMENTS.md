# Antfarm Verbesserungen (Known Issues & Bugs)

## Bug: `--scheduler=daemon` wird nicht erkannt

**Status:** Open (nicht gefixt)

**Beschreibung:**
Der CLI-Parser erkennt `--scheduler daemon` (Leerzeichen), aber NICHT `--scheduler=daemon` (Gleichheitszeichen). Wenn man `--scheduler=daemon` verwendet, wird der Parameter ignoriert und es wird der Default-Scheduler (`cron`) verwendet.

**Funktioniert:**
```bash
node antfarm workflow run feature-dev "task" --scheduler daemon
```

**Funktioniert NICHT:**
```bash
node antfarm workflow run feature-dev "task" --scheduler=daemon
```

**Ursache:**
```typescript
// src/cli/cli.ts
const schedulerIdx = runArgs.indexOf("--scheduler");
// Das findet nur "--scheduler", nicht "--scheduler=daemon"
```

**Fix-Idee:**
Alle Argumente mit `=` aufsplitten bevor sie geparst werden.

**Priorität:** Medium (Workaround ist einfach)

---
