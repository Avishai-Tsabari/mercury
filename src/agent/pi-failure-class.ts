/**
 * Classify pi CLI failures for retry vs next-model vs fail-fast.
 * Uses stderr/stdout text heuristics (pi does not expose structured HTTP codes here).
 */
export type PiFailureClass = "failFast" | "retryable" | "fallbackable";

export function classifyPiFailure(text: string): PiFailureClass {
  if (/provider ["']cursor["'] is no longer supported/i.test(text)) {
    return "failFast";
  }

  if (
    /\b401\b|\b403\b|invalid\s+api\s+key|incorrect\s+api\s+key|authentication\s+failed|invalid\s+authentication|unauthorized|access\s+denied/i.test(
      text,
    )
  ) {
    return "failFast";
  }

  if (
    /context\s+length|maximum\s+context|token\s+limit|too\s+many\s+tokens|prompt\s+is\s+too\s+long|max\s+tokens|request\s+too\s+large|maximum\s+tokens/i.test(
      text,
    )
  ) {
    return "fallbackable";
  }

  if (
    /tool\s+(use|calling)\s+not\s+supported|tools?\s+not\s+supported|function\s+calling\s+not\s+(supported|available)|does\s+not\s+support\s+tools?|model\s+does\s+not\s+support\s+(tools?|function)|no\s+tool\s+use|unsupported.*\btools?\b/i.test(
      text,
    )
  ) {
    return "fallbackable";
  }

  if (
    /tool\s+call\s+validation\s+failed|attempted\s+to\s+call\s+tool.*which\s+was\s+not\s+in\s+request\.tools/i.test(
      text,
    )
  ) {
    return "fallbackable";
  }

  // The model/provider returned a response the runtime couldn't turn into usable
  // output. Two forms:
  //  1. An unmapped finish reason — pi-ai's exhaustive switch throws
  //     "Unhandled stop reason: <X>" (e.g. Gemini's MALFORMED_RESPONSE, which is
  //     absent from the bundled @google/genai enum).
  //  2. A raw malformed finish-reason enum token surfaced directly.
  // An identical retry against the same leg reproduces it and just burns the chain
  // budget, so fall through to the next model leg instead. The enum arm is
  // case-sensitive on the uppercase token so prose like "malformed response" in an
  // unrelated message can't trip it.
  if (
    /unhandled\s+stop\s+reason/i.test(text) ||
    /\bMALFORMED_(RESPONSE|FUNCTION_CALL|TOOL_CALL)\b/.test(text)
  ) {
    return "fallbackable";
  }

  if (/\b429\b|rate[_\s]+limit/i.test(text)) {
    return "fallbackable";
  }

  if (
    /\b402\b|insufficient\s+credits?|not\s+enough\s+credits?|purchase\s+(more\s+)?credits?|no\s+credits?/i.test(
      text,
    )
  ) {
    return "fallbackable";
  }

  if (
    /\b502\b|\b503\b|\b504\b|timeout|timed\s+out|ETIMEDOUT|ECONNRESET|temporarily\s+unavailable|overload|try\s+again|service\s+unavailable|bad\s+gateway|gateway\s+timeout/i.test(
      text,
    )
  ) {
    return "retryable";
  }

  // Default: assume transient; bounded retries + chain limit prevent infinite spin.
  return "retryable";
}
