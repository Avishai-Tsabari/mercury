/**
 * Pure HTTP-transport helpers for mrctl. Kept side-effect free (no env reads, no
 * process.exit) so it is unit-testable without triggering mrctl's CLI bootstrap.
 */

/**
 * Build the fetch init for an inner→outer API call.
 *
 * - gVisor mode: `apiSocket` is set, so the request is routed over the per-agent
 *   unix socket (Bun ignores the host/port in the URL when `unix` is present).
 * - runc / local: `apiSocket` is undefined, so the TCP `API_URL` is used as-is —
 *   byte-for-byte the pre-socket behaviour.
 */
export function buildRequestInit(
  method: string,
  headers: Record<string, string>,
  body: unknown,
  apiSocket: string | undefined,
): RequestInit & { unix?: string } {
  const init: RequestInit & { unix?: string } = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };
  if (apiSocket) init.unix = apiSocket;
  return init;
}
