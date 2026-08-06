import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { EgressFile, MessageAttachment } from "../types.js";

/**
 * Enforcement helpers for the `media.receive` / `media.send` permissions.
 *
 * Pure with respect to permission resolution: callers decide whether the
 * caller's role holds the permission and only invoke these on denial. Denials
 * are never silent — the receive gate tells the agent via a prompt note, the
 * send gate tells the user via a reply notice, and both log at WARN.
 */

export interface IncomingMediaGateResult {
  /** Attachments to persist/prompt with — undefined when blocked. */
  attachments: MessageAttachment[] | undefined;
  /** System note to append to the agent prompt, or null when nothing was blocked. */
  promptNote: string | null;
}

/**
 * Apply a `media.receive` denial: delete the caller's inbox files from disk
 * (before the container mounts the workspace) and drop the attachments from
 * the message.
 *
 * Deletion is workspace-scoped: only paths resolving inside
 * `<workspacePath>/inbox/` are deleted; anything else is logged and skipped.
 * FS errors are logged and the attachment is still dropped — the inbox TTL
 * cleanup is the backstop.
 */
export function gateIncomingMedia(opts: {
  workspacePath: string;
  spaceId: string;
  callerRole: string;
  attachments: MessageAttachment[] | undefined;
  hadIncomingAttachments: boolean;
}): IncomingMediaGateResult {
  const { workspacePath, spaceId, callerRole, attachments } = opts;
  const count = attachments?.length ?? 0;

  if (count === 0 && !opts.hadIncomingAttachments) {
    return { attachments, promptNote: null };
  }

  const inboxRoot = path.resolve(workspacePath, "inbox");
  for (const att of attachments ?? []) {
    const resolved = path.resolve(workspacePath, att.path);
    // Strictly inside inbox/ — the inbox root itself is never a deletion target.
    if (!resolved.startsWith(inboxRoot + path.sep)) {
      logger.warn(
        "media.receive gate: attachment path outside workspace inbox, not deleting",
        { spaceId, path: att.path },
      );
      continue;
    }
    try {
      fs.rmSync(resolved, { force: true });
    } catch (error) {
      logger.warn("media.receive gate: failed to delete inbox file", {
        spaceId,
        path: att.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn("Blocked incoming media (role lacks media.receive)", {
    spaceId,
    callerRole,
    count,
  });

  // count === 0 means the platform reported attachments but nothing was
  // persisted upstream (media disabled, size limit, download failure) — don't
  // attribute that solely to the permission.
  const promptNote =
    count > 0
      ? `[system] The user sent ${count} ${count === 1 ? "file" : "files"} with this message, but file receiving is disabled ` +
        `for their role, so the ${count === 1 ? "file was" : "files were"} not kept and cannot be read. ` +
        `If relevant, let the user know that sending files is not available to them.`
      : `[system] The user attempted to send one or more files with this message, but they were not received ` +
        `(file receiving is disabled for their role, or the files could not be downloaded). ` +
        `If relevant, let the user know that sending files is not available to them.`;
  return { attachments: undefined, promptNote };
}

export interface OutgoingMediaGateResult {
  /** Files to deliver — empty when blocked. */
  files: EgressFile[];
  /** Reply text, with a withhold notice appended when files were blocked. */
  reply: string;
}

/**
 * Apply a `media.send` denial: withhold this turn's outbox files and append a
 * one-line notice to the reply. Files stay in `outbox/` for admin retrieval;
 * the outbox TTL cleanup removes them later.
 */
export function gateOutgoingMedia(opts: {
  spaceId: string;
  callerRole: string;
  files: EgressFile[];
  reply: string;
}): OutgoingMediaGateResult {
  const { spaceId, callerRole, files, reply } = opts;
  if (files.length === 0) return { files, reply };

  logger.warn("Withheld outgoing media (role lacks media.send)", {
    spaceId,
    callerRole,
    count: files.length,
  });

  const noun = files.length === 1 ? "file was" : "files were";
  const notice = `(${files.length} generated ${noun} not delivered because file delivery is disabled for your role.)`;
  return {
    files: [],
    reply: reply ? `${reply}\n\n${notice}` : notice,
  };
}
