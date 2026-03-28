# Story Claiming Bug Analysis
## Root Causes

### RC-1: Missing `daemon_active_sessions` Check
The `peekAndSpawn` function only checks `current_story_id` but doesn't verify if an agent session is already active in `daemon_active_sessions`.

### RC-2: Race Condition in Claiming
`claimStory` atomically claims stories without checking for concurrent agent sessions.

### RC-3: Session Cleanup Removes Active Claims
`cleanupStaleSessions` removes records from `daemon_active_sessions` while stories are still being processed.

## Fixes Required

### Fix A: Add Active Session Check
```typescript
// In peekAndSpawn, before claiming a new story:
const activeSession = db.prepare(`
  SELECT session_id FROM daemon_active_sessions 
  WHERE step_id = ? AND agent_id = ?
`).get(loopStep.id, agentId);

if (activeSession) {
  console.log(`[peekAndSpawn] Agent ${agentId} already has active session ${activeSession.session_id}`);
  return { spawned: false, reason: "agent_session_active" };
}
```

### Fix B: Atomic Session Check
```typescript
// In claimStory, add check:
IF EXISTS (SELECT 1 FROM daemon_active_sessions WHERE step_id = ...)
  RETURN already_claimed;
END IF;
```

### Fix C: Don't Cleanup Active Stories
```typescript
// In cleanupStaleSessions:
JOIN stories s ON s.id = das.story_id
WHERE s.status NOT IN ('running', 'claiming')
```

## Test Criteria
- [ ] Claiming story-001 blocks story-002 until story-001 done
- [ ] Multiple agent sessions for same agent_id prevented
- [ ] Cleanup doesn't remove active story sessions
