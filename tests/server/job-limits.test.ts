import { expect, test } from "bun:test";
import { HubError } from "../../server/src/hub-error.ts";
import { JobLimiter } from "../../server/src/job-limits.ts";

function makeLimiter(overrides: { maxJobsPerAgent?: number; maxJobsPerMinute?: number } = {}): JobLimiter {
  return new JobLimiter({ maxJobsPerAgent: 8, maxJobsPerMinute: 120, ...overrides });
}

function hubErrorCode(fn: () => void): string | null {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HubError);
    return (err as HubError).code;
  }
  return null;
}

test("acquire/release tracks in-flight jobs and floors at zero", () => {
  const limiter = makeLimiter({ maxJobsPerAgent: 1 });
  limiter.acquire("ag_1", "PC-01", false);
  expect(hubErrorCode(() => limiter.acquire("ag_1", "PC-01", false))).toBe("agent_busy");
  limiter.release("ag_1");
  limiter.release("ag_1"); // extra releases never go negative
  expect(hubErrorCode(() => limiter.acquire("ag_1", "PC-01", false))).toBeNull();
});

test("rate limit counts tool calls but not internal chunks", () => {
  const limiter = makeLimiter({ maxJobsPerAgent: 100, maxJobsPerMinute: 2 });
  // Internal plumbing never trips (nor feeds) the rate limit...
  for (let i = 0; i < 10; i++) {
    limiter.acquire("ag_1", "PC-01", true);
    limiter.release("ag_1");
  }
  // ...while tool calls do.
  limiter.acquire("ag_1", "PC-01", false);
  limiter.acquire("ag_1", "PC-01", false);
  expect(hubErrorCode(() => limiter.acquire("ag_1", "PC-01", false))).toBe("rate_limited");
});

test("limits are tracked per agent", () => {
  const limiter = makeLimiter({ maxJobsPerAgent: 1, maxJobsPerMinute: 1 });
  limiter.acquire("ag_1", "PC-01", false);
  limiter.acquire("ag_2", "PC-02", false); // other agents unaffected
  expect(hubErrorCode(() => limiter.acquire("ag_1", "PC-01", false))).toBe("agent_busy");
});
