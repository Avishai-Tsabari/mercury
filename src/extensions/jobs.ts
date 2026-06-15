/**
 * Job runner — executes background jobs registered by extensions.
 *
 * Supports interval-based and cron-based scheduling.
 */

import { CronExpressionParser } from "cron-parser";
import type { Logger } from "../logger.js";
import type {
  ExtensionMeta,
  JobDef,
  MercuryExtensionContext,
} from "./types.js";

export class JobRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  /**
   * Start all registered jobs from loaded extensions.
   * Interval jobs run immediately, then repeat.
   * Cron jobs schedule for the next matching time.
   */
  start(extensions: ExtensionMeta[], ctx: MercuryExtensionContext): void {
    if (this.running) return;
    this.running = true;

    for (const ext of extensions) {
      for (const [jobName, jobDef] of ext.jobs) {
        const fullName = `${ext.name}:${jobName}`;
        const log = ctx.log.child({ job: fullName });

        if (jobDef.interval) {
          // Run immediately, then on interval
          void this.runJob(fullName, jobDef, ctx, log);
          const timer = setInterval(
            () => void this.runJob(fullName, jobDef, ctx, log),
            jobDef.interval,
          );
          this.timers.set(fullName, timer);
          log.info("Started interval job", { intervalMs: jobDef.interval });
        }

        if (jobDef.cron) {
          this.scheduleCron(fullName, jobDef, ctx, log);
          log.info("Started cron job", { cron: jobDef.cron });
        }
      }
    }
  }

  /** Stop all running jobs and clear timers. */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Number of active jobs. */
  get activeCount(): number {
    return this.timers.size;
  }

  private scheduleCron(
    name: string,
    def: JobDef,
    ctx: MercuryExtensionContext,
    log: Logger,
  ): void {
    if (!this.running || !def.cron) return;

    const delayMs = getNextCronDelay(def.cron);
    if (delayMs === null) {
      log.error("Invalid cron expression, job not scheduled", {
        cron: def.cron,
      });
      return;
    }

    const timer = setTimeout(async () => {
      if (!this.running) return;
      await this.runJob(name, def, ctx, log);
      // Reschedule for next tick
      this.timers.delete(name);
      this.scheduleCron(name, def, ctx, log);
    }, delayMs);

    this.timers.set(name, timer);
  }

  private async runJob(
    _name: string,
    def: JobDef,
    ctx: MercuryExtensionContext,
    log: Logger,
  ): Promise<void> {
    log.info("Job starting");
    try {
      await def.run(ctx);
      log.info("Job complete");
    } catch (err) {
      log.error("Job failed", err instanceof Error ? err : undefined);
    }
  }
}

/**
 * Compute the delay in milliseconds until the next cron tick.
 * Returns null if the expression is invalid.
 */
export function getNextCronDelay(cronExpr: string): number | null {
  try {
    const cron = CronExpressionParser.parse(cronExpr);
    const next = cron.next().getTime();
    return Math.max(0, next - Date.now());
  } catch {
    return null;
  }
}
