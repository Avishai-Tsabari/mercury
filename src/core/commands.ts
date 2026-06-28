export interface CommandVerb {
  verb: string;
  args?: string; // e.g. "<N|MODEL_ID>"
  description: string;
}

export interface CommandEntry {
  name: string; // e.g. "model", "help"
  description: string; // one-liner shown in /help
  verbs?: CommandVerb[]; // defined ⟹ category; absent ⟹ leaf command
}

// Slash-command registry — source of truth for /help and router recognition.
// Add new categories here; router + executeCommand both derive from this list.
export const SLASH_COMMANDS: CommandEntry[] = [
  {
    name: "help",
    description: "list all available commands",
  },
  {
    name: "model",
    description: "list, switch, and inspect your AI models",
    verbs: [
      { verb: "list", description: "list your configured models" },
      { verb: "active", description: "show the active model" },
      {
        verb: "switch",
        args: "<N|MODEL_ID>",
        description: "switch by number or model ID",
      },
    ],
  },
  {
    name: "spaces",
    description: "create, list, switch, and delete spaces",
    verbs: [
      { verb: "list", description: "list all spaces with conversation counts" },
      {
        verb: "create",
        args: "<id> <name>",
        description: "create a new space",
      },
      {
        verb: "switch",
        args: "<id>",
        description: "switch this conversation to a different space",
      },
      {
        verb: "delete",
        args: "<id>",
        description: "delete a space (requires confirmation)",
      },
      {
        verb: "unlink",
        description: "unlink this conversation from its space",
      },
    ],
  },
  {
    name: "pause",
    description: "pause the bot in this space (optional: /pause <duration>)",
  },
  {
    name: "resume",
    description: "resume the bot in this space",
  },
];

// Legacy bare commands — still work without a slash; shown in /help for discoverability.
export const BARE_COMMANDS: Array<{ name: string; description: string }> = [
  {
    name: "stop",
    description: "abort the current agent run and queued requests",
  },
  { name: "compact", description: "reset the session context window" },
  { name: "clear", description: "clear context for this message" },
];

// Generates the /help response listing all commands.
export function formatHelp(): string {
  const lines: string[] = ["Available commands:", ""];

  for (const cmd of SLASH_COMMANDS) {
    lines.push(`  /${cmd.name.padEnd(12)}  ${cmd.description}`);
  }

  lines.push("", "Bare commands (no slash needed):");
  for (const cmd of BARE_COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(12)}  ${cmd.description}`);
  }

  lines.push("", "Type /<category> to see detailed help for that category.");
  return lines.join("\n");
}

// Generates the /<category> no-verb response.
// Returns null if name is not in the registry or the command has no verbs.
export function formatCategoryHelp(name: string): string | null {
  const entry = SLASH_COMMANDS.find((c) => c.name === name);
  if (!entry?.verbs || entry.verbs.length === 0) return null;

  const lines: string[] = [`/${name} — ${entry.description}`, ""];
  for (const v of entry.verbs) {
    const usage = v.args
      ? `/${name} ${v.verb} ${v.args}`
      : `/${name} ${v.verb}`;
    lines.push(`  ${usage.padEnd(28)}  ${v.description}`);
  }
  return lines.join("\n");
}
