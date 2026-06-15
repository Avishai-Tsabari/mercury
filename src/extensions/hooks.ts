/**
 * Hook dispatcher — emits lifecycle events and dispatches to extension handlers.
 *
 * Handles mutation semantics for before_container and after_container events.
 * Errors in handlers are caught and logged — never crash Mercury.
 */

import type { Logger } from "../logger.js";
import type { EgressFile } from "../types.js";
import type { ExtensionRegistry } from "./loader.js";
import type {
  AfterContainerResult,
  BeforeContainerResult,
  MercuryEvents,
  MercuryExtensionContext,
} from "./types.js";

export class HookDispatcher {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly log: Logger,
  ) {}

  /**
   * Emit a non-mutating event (startup, shutdown, workspace_init).
   * Runs all handlers in load order. Errors are caught and logged.
   */
  async emit<E extends "startup" | "shutdown" | "workspace_init">(
    event: E,
    data: MercuryEvents[E],
    ctx: MercuryExtensionContext,
  ): Promise<void> {
    const handlers = this.registry.getHookHandlers(event);
    for (const handler of handlers) {
      try {
        await handler(data, ctx);
      } catch (err) {
        this.log.error(
          `Hook "${event}" handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Emit before_container event with mutation support.
   *
   * Mutation semantics:
   * - systemPrompt: concatenated across handlers (newline-separated)
   * - promptAppend: concatenated across handlers (newline-separated)
   * - env: merged (last-write-wins on key conflict)
   * - block: first handler to block stops the chain
   */
  async emitBeforeContainer(
    data: MercuryEvents["before_container"],
    ctx: MercuryExtensionContext,
  ): Promise<BeforeContainerResult | undefined> {
    const handlers = this.registry.getHookHandlers("before_container");
    if (handlers.length === 0) return undefined;

    const systemPromptParts: string[] = [];
    const promptAppendParts: string[] = [];
    let env: Record<string, string> = {};
    let hasMutations = false;

    for (const handler of handlers) {
      try {
        const result = await handler(data, ctx);
        if (!result) continue;

        hasMutations = true;

        if (result.block) {
          return { block: result.block };
        }
        if (result.systemPrompt) {
          systemPromptParts.push(result.systemPrompt);
        }
        if (result.promptAppend) {
          promptAppendParts.push(result.promptAppend);
        }
        if (result.env) {
          env = { ...env, ...result.env };
        }
      } catch (err) {
        this.log.error(
          `Hook "before_container" handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!hasMutations) return undefined;

    return {
      ...(systemPromptParts.length > 0
        ? { systemPrompt: systemPromptParts.join("\n") }
        : {}),
      ...(promptAppendParts.length > 0
        ? { promptAppend: promptAppendParts.join("\n") }
        : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  /**
   * Emit after_container event with mutation support.
   *
   * Mutation semantics:
   * - reply: last handler to return a reply wins
   * - suppress: any handler returning true suppresses
   * - files: arrays concatenated in handler registration order (append-only)
   */
  async emitAfterContainer(
    data: MercuryEvents["after_container"],
    ctx: MercuryExtensionContext,
  ): Promise<AfterContainerResult | undefined> {
    const handlers = this.registry.getHookHandlers("after_container");
    if (handlers.length === 0) return undefined;

    let reply: string | undefined;
    let suppress = false;
    const fileParts: EgressFile[] = [];
    let hasMutations = false;

    for (const handler of handlers) {
      try {
        const result = await handler(data, ctx);
        if (!result) continue;

        hasMutations = true;

        if (result.reply !== undefined) {
          reply = result.reply;
        }
        if (result.suppress) {
          suppress = true;
        }
        if (result.files?.length) {
          fileParts.push(...result.files);
        }
      } catch (err) {
        this.log.error(
          `Hook "after_container" handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!hasMutations) return undefined;

    return {
      ...(reply !== undefined ? { reply } : {}),
      ...(suppress ? { suppress } : {}),
      ...(fileParts.length > 0 ? { files: fileParts } : {}),
    };
  }
}
