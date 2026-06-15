import { z } from "zod";

export const MAX_MODEL_CHAIN_LEGS = 7;

export const modelLegSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

/** Validate YAML/JSON model chain legs (same rules as MERCURY_MODEL_CHAIN). */
export function parseModelLegsArray(
  parsed: unknown,
  label: string,
): { provider: string; model: string }[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${label} must be a non-empty array of { provider, model }`,
    );
  }
  const legs = parsed.map((item, i) => {
    const r = modelLegSchema.safeParse(item);
    if (!r.success) {
      throw new Error(
        `${label}[${i}] must be { provider, model } non-empty strings`,
      );
    }
    return r.data;
  });
  return legs.slice(0, MAX_MODEL_CHAIN_LEGS);
}
