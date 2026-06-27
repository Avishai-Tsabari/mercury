type ConnectionCategory =
  | "email"
  | "drive"
  | "calendar"
  | "finance"
  | "messaging"
  | "docs"
  | "workspace"
  | "other";

type ConnectionAuthType =
  | "oauth2"
  | "apikey"
  | "app-password"
  | "credentials-file"
  | "custom";

type MercuryExt = {
  cli(opts: { name: string; install: string }): void;
  permission(opts: { defaultRoles: string[] }): void;
  env(def: { from: string; as?: string }): void;
  skill(relativePath: string): void;
  connection(def: {
    displayName: string;
    iconUrl?: string;
    category: ConnectionCategory;
    authType: ConnectionAuthType;
    credentialEnvVar?: string;
    scopes?: string[];
  }): void;
  on(
    event: "before_container",
    handler: (
      event: { spaceId: string; callerId: string },
      ctx: {
        db: { getExtState(e: string, k: string): string | null };
        hasCallerPermission(
          spaceId: string,
          callerId: string,
          permission: string,
        ): boolean;
      },
    ) => Promise<{ env?: Record<string, string> } | undefined>,
  ): void;
};

const gwsEnv = {
  credentialEnvVar: "MERCURY_GWS_CREDENTIALS_JSON",
  env: {
    credentials: "MERCURY_GWS_CREDENTIALS_JSON",
    legacyCredentialsFile: "MERCURY_GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
  },
};

/** Path where credentials are materialized inside the inner container's own /tmp. */
const CREDENTIALS_FILE = "/tmp/gws-credentials.json";

export default function (mercury: MercuryExt) {
  mercury.cli({
    name: "gws",
    install: "npm install -g @googleworkspace/cli",
  });

  mercury.permission({ defaultRoles: ["admin"] });

  mercury.env({ from: gwsEnv.env.credentials });
  mercury.env({ from: gwsEnv.env.legacyCredentialsFile });

  mercury.connection({
    displayName: "Google Workspace",
    category: "workspace",
    authType: "oauth2",
    credentialEnvVar: gwsEnv.credentialEnvVar,
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });

  // Inner containers don't share the outer container's volume — they mount host
  // filesystem paths. So we can't write a credentials file from this hook and
  // have the inner container see it. Instead, pass the target path via env var
  // and let the skill materialize the file from GWS_CREDENTIALS_JSON at runtime.
  mercury.on("before_container", async () => {
    const raw = process.env[gwsEnv.env.credentials];
    if (!raw) return undefined;

    try {
      JSON.parse(raw);
    } catch {
      console.error(
        `[gws.before_container] ${gwsEnv.env.credentials} is not valid JSON — skipping`,
      );
      return undefined;
    }

    return {
      env: {
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: CREDENTIALS_FILE,
        GWS_CREDENTIALS_JSON: raw,
      },
    };
  });

  mercury.skill("./skill");
}
