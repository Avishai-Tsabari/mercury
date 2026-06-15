/**
 * Parse a duration string like "10m", "1h", "24h", "7d" into milliseconds.
 */
export function parseMuteDuration(input: string): number | null {
  const match = input.match(/^(\d+)\s*(m|min|h|hr|d|day)s?$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "m":
    case "min":
      return value * 60 * 1000;
    case "h":
    case "hr":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}
