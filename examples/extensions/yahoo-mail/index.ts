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
  cli(opts: { name: string; install: string; bin?: string }): void;
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
};

import manifest from "../../../resources/connection-env-vars.json";

const yahooEnv = manifest["yahoo-mail"];

export default function (mercury: MercuryExt) {
  mercury.cli({
    name: "ymail",
    install: "npm install -g imapflow nodemailer",
    bin: "./cli/ymail.mjs",
  });

  mercury.permission({ defaultRoles: ["admin"] });

  mercury.env({ from: yahooEnv.env.email });
  mercury.env({ from: yahooEnv.env.appPassword });

  mercury.connection({
    displayName: "Yahoo Mail",
    category: "email",
    authType: "app-password",
    credentialEnvVar: yahooEnv.credentialEnvVar,
  });

  mercury.skill("./skill");
}
