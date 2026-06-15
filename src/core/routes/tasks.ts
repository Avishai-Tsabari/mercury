import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { logger } from "../../logger.js";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const tasks = new Hono<Env>();

tasks.get("/", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "tasks.list");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const taskList = db.listTasks(spaceId);
  return c.json({ tasks: taskList });
});

tasks.post("/", async (c) => {
  const { spaceId, callerId } = getAuth(c);
  const denied = checkPerm(c, "tasks.create");
  if (denied) return denied;

  const { db, config } = getApiCtx(c);
  const body = await c.req.json<{
    cron?: string;
    at?: string;
    prompt?: string;
    silent?: boolean;
    timezone?: string;
  }>();

  if (!body.prompt) {
    return c.json({ error: "Missing prompt" }, 400);
  }
  if (!body.cron && !body.at) {
    return c.json({ error: "Missing cron or at" }, 400);
  }
  if (body.cron && body.at) {
    return c.json({ error: "Cannot specify both cron and at" }, 400);
  }

  const rawTimezone = body.timezone || config.defaultTimezone;
  let timezone: string | undefined;
  if (rawTimezone) {
    try {
      if (!Intl.supportedValuesOf("timeZone").includes(rawTimezone)) {
        return c.json({ error: "Invalid timezone identifier" }, 400);
      }
      timezone = rawTimezone;
    } catch {
      return c.json({ error: "Invalid timezone identifier" }, 400);
    }
  }

  const silent = body.silent ?? false;
  let nextRunAt: number;
  let schedule: { cron: string } | { at: string };

  if (body.cron) {
    try {
      const interval = CronExpressionParser.parse(body.cron, {
        currentDate: new Date(),
        tz: timezone ?? "UTC",
      });
      nextRunAt = interval.next().getTime();
      schedule = { cron: body.cron };
    } catch {
      return c.json({ error: "Invalid cron expression" }, 400);
    }
  } else {
    const atStr = body.at as string;
    const atTime = new Date(atStr).getTime();
    if (Number.isNaN(atTime)) {
      return c.json({ error: "Invalid at timestamp" }, 400);
    }
    if (atTime <= Date.now()) {
      return c.json({ error: "at timestamp must be in the future" }, 400);
    }
    nextRunAt = atTime;
    schedule = { at: atStr };
  }

  const id = db.createTask(
    spaceId,
    schedule,
    body.prompt,
    nextRunAt,
    callerId,
    silent,
    timezone,
  );

  return c.json({
    id,
    cron: body.cron ?? null,
    at: body.at ?? null,
    prompt: body.prompt,
    silent,
    timezone: timezone ?? null,
    nextRunAt,
  });
});

tasks.post("/:id/pause", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "tasks.pause");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const taskId = Number(c.req.param("id"));
  if (!Number.isFinite(taskId) || taskId < 1) {
    return c.json({ error: "Invalid task ID" }, 400);
  }

  const task = db.getTask(taskId);
  if (!task || task.spaceId !== spaceId) {
    return c.json({ error: "Task not found" }, 404);
  }

  db.setTaskActive(taskId, false);
  return c.json({ id: taskId, active: false });
});

tasks.post("/:id/resume", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "tasks.resume");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const taskId = Number(c.req.param("id"));
  if (!Number.isFinite(taskId) || taskId < 1) {
    return c.json({ error: "Invalid task ID" }, 400);
  }

  const task = db.getTask(taskId);
  if (!task || task.spaceId !== spaceId) {
    return c.json({ error: "Task not found" }, 404);
  }

  db.setTaskActive(taskId, true);
  return c.json({ id: taskId, active: true });
});

tasks.post("/:id/run", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "tasks.create");
  if (denied) return denied;

  const { db, scheduler } = getApiCtx(c);
  const taskId = Number(c.req.param("id"));
  if (!Number.isFinite(taskId) || taskId < 1) {
    return c.json({ error: "Invalid task ID" }, 400);
  }

  const task = db.getTask(taskId);
  if (!task || task.spaceId !== spaceId) {
    return c.json({ error: "Task not found" }, 404);
  }

  if (!task.active) {
    return c.json({ error: "Task is paused" }, 400);
  }

  // Trigger async - don't wait for completion
  scheduler.triggerTask(taskId).catch((err) => {
    logger.error("Task trigger failed", { taskId, error: String(err) });
  });

  return c.json({ id: taskId, triggered: true });
});

tasks.delete("/:id", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "tasks.delete");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const taskId = Number(c.req.param("id"));
  if (!Number.isFinite(taskId) || taskId < 1) {
    return c.json({ error: "Invalid task ID" }, 400);
  }

  const deleted = db.deleteTask(taskId, spaceId);
  if (!deleted) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ id: taskId, deleted: true });
});
