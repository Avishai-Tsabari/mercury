/**
 * Minimal model capability types + defaults (no yaml/zod).
 * Used by container-entry; the full agent image only copies this file, not model-capabilities.ts.
 */

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  audio_input: boolean;
  audio_output: boolean;
  extended_thinking: boolean;
};

export type ModelCapabilityKey = keyof ModelCapabilities;

/** Fallback when no builtin / YAML / env match. */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  audio_input: false,
  audio_output: false,
  extended_thinking: false,
};
