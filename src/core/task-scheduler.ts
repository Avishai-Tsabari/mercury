import { CronExpressionParser } from "cron-parser";
import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";

type TaskHandler = (task: {
  id: number;
  spaceId: string;
  prompt: string;
  createdBy: string;
  silent: boolean;
}) => Promise<void>;

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private handler: TaskHandler | null = null;

  constructor(
    private readonly db: Db,
    private readonly pollIntervalMs = 5_000,
  ) {}

  start(handler: TaskHandler) {
    if (this.timer) return;
    this.handler = handler;
    this.recalculateNextRuns();

    const tick = async () => {
      try {
        const due = this.db.getDueTasks(Date.now());
        for (const task of due) {
          // For cron tasks, update next run before execution
          // For at-tasks, we'll delete after execution
          if (task.cron) {
            const next = this.computeNextRun(
              task.cron,
              task.timezone ?? undefined,
            );
            this.db.updateTaskNextRun(task.id, next);
          }

          try {
            await handler({
              id: task.id,
              spaceId: task.spaceId,
              prompt: task.prompt,
              createdBy: task.createdBy,
              silent: task.silent === 1,
            });
          } catch (error) {
            logger.error("Scheduler task handler failed", {
              taskId: task.id,
              spaceId: task.spaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          // For at-tasks, delete after execution (regardless of success/failure)
          if (task.at) {
            this.db.deleteTaskById(task.id);
            logger.info("One-shot task completed and deleted", {
              taskId: task.id,
              spaceId: task.spaceId,
            });
          }
        }
      } catch (error) {
        logger.error(
          "Scheduler error",
          error instanceof Error ? error : undefined,
        );
      } finally {
        this.timer = setTimeout(tick, this.pollIntervalMs);
      }
    };

    this.timer = setTimeout(tick, this.pollIntervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  computeNextRun(cron: string, timezone?: string, from = new Date()): number {
    try {
      const interval = CronExpressionParser.parse(cron, {
        currentDate: from,
        tz: timezone ?? "UTC",
      });
      return interval.next().getTime();
    } catch {
      // Timezone rejected by cron-parser — fall back to UTC
      const interval = CronExpressionParser.parse(cron, { currentDate: from });
      return interval.next().getTime();
    }
  }

  private recalculateNextRuns(): void {
    const tasks = this.db.listTasks();
    let updated = 0;
    for (const task of tasks) {
      if (!task.active || !task.cron) continue;
      const correct = this.computeNextRun(
        task.cron,
        task.timezone ?? undefined,
      );
      if (correct !== task.nextRunAt) {
        this.db.updateTaskNextRun(task.id, correct);
        updated++;
      }
    }
    if (updated > 0) {
      logger.info(`Recalculated next_run_at for ${updated} cron task(s)`);
    }
  }

  async triggerTask(taskId: number): Promise<boolean> {
    if (!this.handler) return false;
    const task = this.db.getTask(taskId);
    if (!task?.active) return false;

    await this.handler({
      id: task.id,
      spaceId: task.spaceId,
      prompt: task.prompt,
      createdBy: task.createdBy,
      silent: task.silent === 1,
    });
    return true;
  }
}
