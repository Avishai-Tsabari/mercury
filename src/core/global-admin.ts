/**
 * Check if a caller is a global admin (configured in mercury.yaml / env).
 * Global admins are identified by `config.admins` and `config.dmAutoSpaceAdminIds`.
 * Platform-specific ID prefixes, + signs, and @domain suffixes are normalized.
 */
export function isGlobalAdmin(
  callerId: string,
  config: { admins?: string; dmAutoSpaceAdminIds?: string },
): boolean {
  const globalAdmins = [
    ...(config.admins
      ? config.admins
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
    ...(config.dmAutoSpaceAdminIds
      ? config.dmAutoSpaceAdminIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ];

  const normalize = (s: string) =>
    s
      .replace(/^[^:]+:/, "")
      .replace(/^[+]+/, "")
      .replace(/@.*$/, "");

  const callerNormalized = normalize(callerId);

  return globalAdmins.some(
    (id) => id === callerId || normalize(id) === callerNormalized,
  );
}
