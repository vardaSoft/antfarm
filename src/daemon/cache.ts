import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { WorkflowSpec } from "../installer/types.js";

interface CacheEntry {
  spec: WorkflowSpec;
  lastUpdated: number;
  ttl: number;
  checksum: string;
}

const workflowCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cacheMetrics = {
  hits: 0,
  misses: 0,
  size: 0
};

/**
 * Calculate checksum of workflow.yml file for change detection
 */
function calculateChecksum(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Get cached workflow spec with TTL and file change validation
 */
export async function getCachedWorkflow(workflowId: string, workflowDir: string, loadWorkflowSpec: (dir: string) => Promise<WorkflowSpec>): Promise<WorkflowSpec> {
  const workflowFile = path.join(workflowDir, "workflow.yml");
  const cached = workflowCache.get(workflowId);
  const now = Date.now();

  // Check if cache exists and is valid
  if (cached && (now - cached.lastUpdated) < cached.ttl) {
    // Check if file has changed
    const currentChecksum = calculateChecksum(workflowFile);
    if (currentChecksum === cached.checksum) {
      // Cache hit
      cacheMetrics.hits++;
      return cached.spec;
    }
  }

  // Cache miss - load fresh
  cacheMetrics.misses++;
  const spec = await loadWorkflowSpec(workflowDir);
  const checksum = calculateChecksum(workflowFile);
  
  workflowCache.set(workflowId, { 
    spec, 
    lastUpdated: now, 
    ttl: CACHE_TTL_MS,
    checksum
  });
  
  cacheMetrics.size = workflowCache.size;
  return spec;
}

/**
 * Get cache metrics
 */
export function getCacheMetrics(): { hits: number; misses: number; size: number; hitRate: number } {
  const total = cacheMetrics.hits + cacheMetrics.misses;
  const hitRate = total > 0 ? cacheMetrics.hits / total : 0;
  
  return {
    ...cacheMetrics,
    hitRate
  };
}

/**
 * Clear cache (for testing)
 */
export function clearCache(): void {
  workflowCache.clear();
  cacheMetrics = { hits: 0, misses: 0, size: 0 };
}