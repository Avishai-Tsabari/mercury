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

/**
 * Where a capability set came from. `"default"` means the model id matched
 * nothing — the flags below are guesses, not facts, and callers must not
 * present them to the model as constraints. See `buildCapabilitySection`.
 */
export type CapabilitySource = "env" | "yaml" | "builtin" | "default";

/**
 * Capabilities as serialized to the container over `MODEL_CHAIN_CAPABILITIES`.
 * `source` rides along so the container can tell a looked-up `false` from an
 * assumed one.
 */
export type WireModelCapabilities = ModelCapabilities & {
  source?: CapabilitySource;
};

/** Fallback when no builtin / YAML / env match. */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  audio_input: false,
  audio_output: false,
  extended_thinking: false,
};
