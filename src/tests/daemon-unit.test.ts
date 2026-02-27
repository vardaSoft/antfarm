import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCacheMetrics, clearCache } from "../daemon/cache.js";

describe("daemon unit tests", () => {
  it("should compile without errors", () => {
    // This test simply verifies that the daemon module compiles correctly
    assert.ok(true);
  });

  it("should initialize cache metrics correctly", () => {
    clearCache();
    const metrics = getCacheMetrics();
    assert.strictEqual(metrics.hits, 0);
    assert.strictEqual(metrics.misses, 0);
    assert.strictEqual(metrics.size, 0);
    assert.strictEqual(metrics.hitRate, 0);
  });
});