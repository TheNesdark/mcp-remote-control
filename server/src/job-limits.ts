/**
 * JobLimiter: per-agent admission control for the hub.
 *
 * - Concurrency: at most `maxJobsPerAgent` in-flight jobs (`agent_busy`).
 * - Rate: at most `maxJobsPerMinute` accepted jobs per rolling 60 s window
 *   (`rate_limited`). Internal plumbing (transfer chunks) skips rate
 *   counting: the enclosing tool call is what gets counted.
 */
import { HubError } from "./hub-error.ts";

export interface JobLimits {
  maxJobsPerAgent: number;
  maxJobsPerMinute: number;
}

const RATE_WINDOW_MS = 60_000;

export class JobLimiter {
  private readonly inflight = new Map<string, number>();
  private readonly stamps = new Map<string, number[]>();

  constructor(private readonly limits: JobLimits) {}

  /** Admit a job (and count it), or throw HubError. Always pair with release(). */
  acquire(agentId: string, agentName: string, internal: boolean): void {
    const running = this.inflight.get(agentId) ?? 0;
    if (running >= this.limits.maxJobsPerAgent) {
      throw new HubError(
        "agent_busy",
        `Agent '${agentName}' already runs ${running} jobs (max ${this.limits.maxJobsPerAgent}); try again later.`,
      );
    }
    this.inflight.set(agentId, running + 1);
    if (internal) return;
    const now = Date.now();
    const stamps = (this.stamps.get(agentId) ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
    if (stamps.length >= this.limits.maxJobsPerMinute) {
      this.inflight.set(agentId, running);
      throw new HubError(
        "rate_limited",
        `Agent '${agentName}' exceeded ${this.limits.maxJobsPerMinute} jobs/min; slow down.`,
      );
    }
    stamps.push(now);
    this.stamps.set(agentId, stamps);
  }

  /** Release an in-flight slot (idempotent floor at zero). */
  release(agentId: string): void {
    this.inflight.set(agentId, Math.max(0, (this.inflight.get(agentId) ?? 1) - 1));
  }
}
