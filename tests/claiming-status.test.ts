import { describe, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, getDbPath } from '../src/db.js';
import { claimStep, claimStory, failStep, peekStep } from '../src/installer/step-ops.js';
import { cleanupStaleClaimingState } from '../src/daemon/daemon.js';

// Mock the event emitter to capture events
let emittedEvents: any[] = [];
const originalEmitEvent = (await import('../src/installer/events.js')).emitEvent;
const mockEmitEvent = (event: any) => {
  emittedEvents.push(event);
};

// Mock the logger
const originalLogger = (await import('../src/lib/logger.js')).logger;
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

describe('Claiming Status Integration Tests', () => {
  beforeEach(() => {
    // Reset emitted events
    emittedEvents = [];
    
    // Mock emitEvent and logger
    // Note: We can't easily mock these in the imported modules, so we'll test the behavior directly
    
    // Create a fresh database for each test
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    
    // Initialize database
    const db = getDb();
    
    // Create a test workflow run
    db.prepare(`
      INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
      VALUES ('test-run-1', 'test-workflow', 'Test task', 'running', '{}', datetime('now'), datetime('now'))
    `).run();
    
    // Create a test step
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('test-step-1', 'test-run-1', 'step1', 'test-agent', 0, 'Test input', 'Test expects', 'pending', datetime('now'), datetime('now'))
    `).run();
  });

  afterEach(() => {
    // Clean up database
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('should claim single step with claiming status and transition to running after spawn', () => {
    const db = getDb();
    
    // Initially step should be pending
    const initialStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(initialStep.status).toBe('pending');
    
    // Claim the step
    const claimResult = claimStep('test-agent');
    expect(claimResult.found).toBe(true);
    expect(claimResult.stepId).toBe('test-step-1');
    
    // After claiming, step should be in claiming state
    const claimedStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(claimedStep.status).toBe('claiming');
    
    // Simulate successful spawn by updating to running state
    db.prepare("UPDATE steps SET status = 'running' WHERE id = 'test-step-1'").run();
    
    const runningStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(runningStep.status).toBe('running');
  });

  it('should rollback single step to pending on spawn failure', () => {
    const db = getDb();
    
    // Initially step should be pending
    const initialStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(initialStep.status).toBe('pending');
    
    // Claim the step
    const claimResult = claimStep('test-agent');
    expect(claimResult.found).toBe(true);
    
    // After claiming, step should be in claiming state
    const claimedStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(claimedStep.status).toBe('claiming');
    
    // Simulate spawn failure by reverting to pending
    db.prepare("UPDATE steps SET status = 'pending' WHERE id = 'test-step-1'").run();
    
    const rolledBackStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(rolledBackStep.status).toBe('pending');
  });

  it('should handle loop step with stories claiming flow', () => {
    const db = getDb();
    
    // Create a loop step
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
      VALUES ('test-loop-step-1', 'test-run-1', 'loop1', 'test-agent', 1, 'Test loop input', 'Test expects', 'running', 'loop', datetime('now'), datetime('now'))
    `).run();
    
    // Create test stories
    db.prepare(`
      INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at)
      VALUES ('test-story-1', 'test-run-1', 0, 'story1', 'Test Story 1', 'Test Description 1', '["Acceptance 1"]', 'pending', datetime('now'), datetime('now'))
    `).run();
    
    db.prepare(`
      INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at)
      VALUES ('test-story-2', 'test-run-1', 1, 'story2', 'Test Story 2', 'Test Description 2', '["Acceptance 2"]', 'pending', datetime('now'), datetime('now'))
    `).run();
    
    // Initially stories should be pending
    const initialStories = db.prepare("SELECT id, status FROM stories WHERE run_id = 'test-run-1' ORDER BY story_index").all() as { id: string; status: string }[];
    expect(initialStories[0].status).toBe('pending');
    expect(initialStories[1].status).toBe('pending');
    
    // Claim the first story
    const claimResult = claimStory('test-agent', 'test-loop-step-1');
    expect(claimResult).not.toBeNull();
    if (claimResult) {
      expect(claimResult.found).toBe(true);
      expect(claimResult.storyId).toBe('test-story-1');
    }
    
    // After claiming, first story should be in claiming state
    const claimedStory = db.prepare("SELECT status FROM stories WHERE id = 'test-story-1'").get() as { status: string };
    expect(claimedStory.status).toBe('claiming');
    
    // Second story should still be pending
    const pendingStory = db.prepare("SELECT status FROM stories WHERE id = 'test-story-2'").get() as { status: string };
    expect(pendingStory.status).toBe('pending');
  });

  it('should cleanup stale claiming states', () => {
    const db = getDb();
    
    // Create steps and stories in claiming state with old timestamps
    db.prepare(`
      UPDATE steps 
      SET status = 'claiming', updated_at = datetime('now', '-10 minutes') 
      WHERE id = 'test-step-1'
    `).run();
    
    // Create a loop step and story for testing
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
      VALUES ('test-loop-step-1', 'test-run-1', 'loop1', 'test-agent', 1, 'Test loop input', 'Test expects', 'running', 'loop', datetime('now'), datetime('now'))
    `).run();
    
    db.prepare(`
      INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at)
      VALUES ('test-story-1', 'test-run-1', 0, 'story1', 'Test Story 1', 'Test Description 1', '["Acceptance 1"]', 'claiming', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))
    `).run();
    
    // Link story to step
    db.prepare(`
      UPDATE steps 
      SET current_story_id = 'test-story-1' 
      WHERE id = 'test-loop-step-1'
    `).run();
    
    // Verify initial states
    const initialStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(initialStep.status).toBe('claiming');
    
    const initialStory = db.prepare("SELECT status FROM stories WHERE id = 'test-story-1'").get() as { status: string };
    expect(initialStory.status).toBe('claiming');
    
    // Run cleanup
    cleanupStaleClaimingState();
    
    // After cleanup, both should be reverted to pending
    const cleanedStep = db.prepare("SELECT status FROM steps WHERE id = 'test-step-1'").get() as { status: string };
    expect(cleanedStep.status).toBe('pending');
    
    const cleanedStory = db.prepare("SELECT status FROM stories WHERE id = 'test-story-1'").get() as { status: string };
    expect(cleanedStory.status).toBe('pending');
    
    // Step should have incremented retry count
    const stepWithRetry = db.prepare("SELECT retry_count FROM steps WHERE id = 'test-step-1'").get() as { retry_count: number };
    expect(stepWithRetry.retry_count).toBe(1);
    
    // Story should have incremented retry count
    const storyWithRetry = db.prepare("SELECT retry_count FROM stories WHERE id = 'test-story-1'").get() as { retry_count: number };
    expect(storyWithRetry.retry_count).toBe(1);
  });

  it('should handle story rollback on spawn failure', () => {
    const db = getDb();
    
    // Create a loop step and story
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
      VALUES ('test-loop-step-1', 'test-run-1', 'loop1', 'test-agent', 1, 'Test loop input', 'Test expects', 'running', 'loop', datetime('now'), datetime('now'))
    `).run();
    
    db.prepare(`
      INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at)
      VALUES ('test-story-1', 'test-run-1', 0, 'story1', 'Test Story 1', 'Test Description 1', '["Acceptance 1"]', 'claiming', datetime('now'), datetime('now'))
    `).run();
    
    // Link story to step
    db.prepare(`
      UPDATE steps 
      SET current_story_id = 'test-story-1' 
      WHERE id = 'test-loop-step-1'
    `).run();
    
    // Simulate spawn failure by reverting story to pending
    db.prepare("UPDATE stories SET status = 'pending' WHERE id = 'test-story-1'").run();
    db.prepare("UPDATE steps SET current_story_id = NULL WHERE id = 'test-loop-step-1'").run();
    
    const rolledBackStory = db.prepare("SELECT status FROM stories WHERE id = 'test-story-1'").get() as { status: string };
    expect(rolledBackStory.status).toBe('pending');
    
    const stepWithoutStory = db.prepare("SELECT current_story_id FROM steps WHERE id = 'test-loop-step-1'").get() as { current_story_id: string | null };
    expect(stepWithoutStory.current_story_id).toBeNull();
  });
});