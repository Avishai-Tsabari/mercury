#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadConfig, resolveProjectPath } from "../config.js";
import {
  checkExtensionIndexLoads,
  getProjectDataDir,
  getUserExtensionsDir,
  installExtensionFromDirectory,
  removeInstalledExtension,
} from "../extensions/installer.js";
import { RESERVED_EXTENSION_NAMES } from "../extensions/reserved.js";
import { Db } from "../storage/db.js";
import { removeSpaceWorkspace } from "../storage/memory.js";
import { authenticate } from "./whatsapp-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "../..");
const CWD = process.cwd();
const TEMPLATES_DIR = join(PACKAGE_ROOT, "resources/templates");
const PROFILES_DIR = join(PACKAGE_ROOT, "resources/profiles");
const VALID_EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function isPortInUse(port: string): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("netstat", ["-ano"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    return result.status === 0 && result.stdout.includes(`:${port} `);
  }
  const result = spawnSync("lsof", ["-i", `:${port}`, "-t"], {
    stdio: "pipe",
  });
  return result.status === 0 && result.stdout.toString().trim().length > 0;
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function loadEnvFile(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

function withProjectDb<T>(fn: (db: Db) => T): T {
  const dbPath = join(CWD, getProjectDataDir(CWD), "state.db");
  const db = new Db(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Commands
function initAction(): void {
  console.log("🪽 Initializing mercury project...\n");

  // Create .env if it doesn't exist
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    copyFileSync(join(TEMPLATES_DIR, "env.template"), envPath);
    console.log("  ✓ .env");
  } else {
    console.log("  • .env (already exists)");
  }

  const mercuryExamplePath = join(CWD, "mercury.example.yaml");
  if (!existsSync(mercuryExamplePath)) {
    copyFileSync(
      join(TEMPLATES_DIR, "mercury.example.yaml"),
      mercuryExamplePath,
    );
    console.log("  ✓ mercury.example.yaml (rename to mercury.yaml to use)");
  } else {
    console.log("  • mercury.example.yaml (already exists)");
  }

  // Create data directories
  const dirs = [".mercury", ".mercury/spaces", ".mercury/global"];
  for (const dir of dirs) {
    const fullPath = join(CWD, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  ✓ ${dir}/`);
    }
  }

  // Create AGENTS.md for the agent
  const agentsMdPath = join(CWD, ".mercury/global/AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    copyFileSync(join(TEMPLATES_DIR, "AGENTS.md"), agentsMdPath);
    console.log("  ✓ .mercury/global/AGENTS.md");
  } else {
    console.log("  • .mercury/global/AGENTS.md (already exists)");
  }

  // Copy agent definitions
  console.log("\nCopying agent definitions:");
  const agentsDir = join(CWD, ".mercury/global/agents");
  mkdirSync(agentsDir, { recursive: true });
  const srcAgentsDir = join(PACKAGE_ROOT, "resources/agents");
  for (const file of readdirSync(srcAgentsDir)) {
    copyFileSync(join(srcAgentsDir, file), join(agentsDir, file));
    console.log(`  ✓ .mercury/global/agents/${file}`);
  }

  console.log("\n🪽 Initialization complete!");
  console.log("\nNext steps:");
  console.log("  1. Edit .env to set your API keys and enable adapters");
  console.log(
    "  2. Run 'mercury service install' to start as a system service",
  );
}

async function runAction(): Promise<void> {
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    console.error("Error: .env file not found in current directory.");
    console.error("Run 'mercury init' first, or cd into your mercury project.");
    process.exit(1);
  }

  const envVars = loadEnvFile(envPath);
  Object.assign(process.env, envVars);
  const cfg = loadConfig();
  const imageName = cfg.agentContainerImage;

  const imageCheck = spawnSync("docker", ["image", "inspect", imageName], {
    stdio: "pipe",
  });
  if (imageCheck.status !== 0) {
    console.error(`Error: Container image '${imageName}' not found.`);
    if (imageName.startsWith("ghcr.io/")) {
      console.error(`Run 'docker pull ${imageName}' to pull it.`);
    } else {
      console.error("Run 'mercury build' to build it.");
    }
    process.exit(1);
  }

  console.log("🪽 Starting mercury...\n");

  const entryPoint = join(PACKAGE_ROOT, "src/main.ts");

  const child = spawn("bun", ["run", entryPoint], {
    stdio: "inherit",
    cwd: CWD,
    env: { ...process.env, ...envVars },
  });

  child.on("error", (err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function buildAction(): void {
  // Build from package sources using a temp context — no files needed in user project
  const tmpDir = join(CWD, ".mercury", ".build-context");
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Copy container files from package into temp context
    const filesToCopy = [
      "container/Dockerfile",
      "container/agent-package.json",
      "src/agent/container-entry.ts",
      "src/agent/model-capabilities-core.ts",
      "src/agent/pi-failure-class.ts",
      "src/agent/pi-jsonl-parser.ts",
      "src/agent/preferences-prompt.ts",
      "src/cli/mrctl.ts",
      "src/cli/mrctl-http.ts",
      "src/extensions/reserved.ts",
      "src/extensions/permission-guard.ts",
      "src/types.ts",
    ];

    for (const file of filesToCopy) {
      const src = join(PACKAGE_ROOT, file);
      const dest = join(tmpDir, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }

    cpSync(join(PACKAGE_ROOT, "resources"), join(tmpDir, "resources"), {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes("node_modules"),
    });

    cpSync(
      join(PACKAGE_ROOT, "examples", "extensions"),
      join(tmpDir, "examples", "extensions"),
      { recursive: true },
    );

    console.log("📦 Building container image...\n");
    const result = spawnSync(
      "docker",
      [
        "build",
        "-t",
        "mercury-agent:latest",
        "-f",
        join(tmpDir, "container/Dockerfile"),
        tmpDir,
      ],
      { stdio: "inherit" },
    );

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    // Clean up temp context
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function statusAction(): void {
  console.log("🪽 mercury status\n");
  console.log(`Project directory: ${CWD}\n`);

  const envPath = join(CWD, ".env");
  const hasEnv = existsSync(envPath);
  console.log(
    `Configuration:   ${hasEnv ? "✓ .env exists" : "✗ .env missing (run 'mercury init')"}`,
  );

  const imageCheck = spawnSync(
    "docker",
    ["image", "inspect", "mercury-agent:latest"],
    {
      stdio: "pipe",
    },
  );
  const hasImage = imageCheck.status === 0;
  console.log(
    `Container image: ${hasImage ? "✓ mercury-agent:latest" : "✗ not built (run 'mercury build')"}`,
  );

  if (hasEnv) {
    console.log("\nConfigured adapters:");
    const envContent = readFileSync(envPath, "utf-8");

    const hasWhatsApp = /MERCURY_ENABLE_WHATSAPP\s*=\s*true/i.test(envContent);
    const hasSlack = /^[^#]*SLACK_BOT_TOKEN=\S+/m.test(envContent);
    const hasDiscord = /^[^#]*DISCORD_BOT_TOKEN=\S+/m.test(envContent);
    const hasTelegram = /^[^#]*TELEGRAM_BOT_TOKEN=\S+/m.test(envContent);

    console.log(`  WhatsApp: ${hasWhatsApp ? "✓ enabled" : "○ disabled"}`);
    console.log(
      `  Slack:    ${hasSlack ? "✓ configured" : "○ not configured"}`,
    );
    console.log(
      `  Discord:  ${hasDiscord ? "✓ configured" : "○ not configured"}`,
    );
    console.log(
      `  Telegram: ${hasTelegram ? "✓ configured" : "○ not configured"}`,
    );

    const portMatch = envContent.match(/MERCURY_PORT\s*=\s*(\d+)/);
    const port = portMatch ? portMatch[1] : "8787";

    const isRunning = isPortInUse(port);
    console.log(
      `\nStatus: ${isRunning ? `🟢 running (port ${port})` : "⚪ not running"}`,
    );
  }
}

function doctorAction(): void {
  console.log("🩺 mercury doctor\n");

  let passed = 0;
  let warned = 0;
  let failed = 0;

  function pass(msg: string): void {
    console.log(`  ✅ ${msg}`);
    passed++;
  }
  function warn(msg: string, fix?: string): void {
    console.log(`  ⚠️  ${msg}`);
    if (fix) console.log(`     → ${fix}`);
    warned++;
  }
  function fail(msg: string, fix?: string): void {
    console.log(`  ❌ ${msg}`);
    if (fix) console.log(`     → ${fix}`);
    failed++;
  }

  // 1. .env exists
  console.log("Configuration:");
  const envPath = join(CWD, ".env");
  const hasEnv = existsSync(envPath);
  if (hasEnv) {
    pass(".env file found");
  } else {
    fail(".env file missing", "Run 'mercury init' to create one");
  }

  const envVars = hasEnv ? loadEnvFile(envPath) : {};
  if (hasEnv) Object.assign(process.env, envVars);
  const cfg = loadConfig();

  // 2. Docker installed and running
  console.log("\nDocker:");
  const dockerCheck = spawnSync("docker", ["info"], {
    stdio: "pipe",
    timeout: 10_000,
  });
  if (dockerCheck.status === 0) {
    pass("Docker is installed and running");
  } else {
    const hasDocker =
      spawnSync("which", ["docker"], { stdio: "pipe" }).status === 0;
    if (hasDocker) {
      fail(
        "Docker is installed but daemon is not running",
        "Start Docker Desktop or run 'sudo systemctl start docker'",
      );
    } else {
      fail(
        "Docker is not installed",
        "Install from https://docs.docker.com/get-docker/",
      );
    }
  }

  // 3. Agent image available
  const image = cfg.agentContainerImage;
  const imageCheck = spawnSync("docker", ["image", "inspect", image], {
    stdio: "pipe",
    timeout: 10_000,
  });
  if (imageCheck.status === 0) {
    pass(`Agent image found: ${image}`);
  } else {
    warn(
      `Agent image not found locally: ${image}`,
      `Mercury will auto-pull on first start, or run 'docker pull ${image}'`,
    );
  }

  // 4. AI credentials
  console.log("\nAI Credentials:");
  const dataDir = getProjectDataDir(CWD);
  const authPath = join(CWD, dataDir, "global", "auth.json");
  const hasOAuth = existsSync(authPath);
  const hasApiKey = !!(
    process.env.MERCURY_ANTHROPIC_API_KEY ||
    process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN
  );
  if (hasOAuth || hasApiKey) {
    if (hasOAuth) pass("OAuth credentials found (auth.json)");
    if (hasApiKey) pass("API key found in .env");
  } else {
    fail(
      "No AI credentials configured",
      "Run 'mercury auth login' or set MERCURY_ANTHROPIC_API_KEY in .env",
    );
  }

  // 5. Adapters
  console.log("\nAdapters:");
  const whatsappEnabled = cfg.enableWhatsApp;
  const discordEnabled = cfg.enableDiscord;
  const slackEnabled = cfg.enableSlack;
  const telegramEnabled = cfg.enableTelegram;

  if (
    !whatsappEnabled &&
    !discordEnabled &&
    !slackEnabled &&
    !telegramEnabled
  ) {
    fail(
      "No adapters enabled",
      "Enable at least one adapter in mercury.yaml (ingress section) or .env",
    );
  } else {
    if (whatsappEnabled) {
      const whatsappAuthDir = resolveProjectPath(cfg.whatsappAuthDir);
      const credsFile = join(whatsappAuthDir, "creds.json");
      if (existsSync(credsFile)) {
        pass("WhatsApp: enabled and authenticated");
      } else {
        fail(
          "WhatsApp: enabled but not authenticated",
          "Run 'mercury auth whatsapp' first",
        );
      }
    }
    if (discordEnabled) {
      if (process.env.MERCURY_DISCORD_BOT_TOKEN) {
        pass("Discord: enabled and token configured");
      } else {
        fail(
          "Discord: enabled but MERCURY_DISCORD_BOT_TOKEN not set",
          "Add your bot token to .env",
        );
      }
    }
    if (slackEnabled) {
      const hasToken = !!process.env.MERCURY_SLACK_BOT_TOKEN;
      const hasSecret = !!process.env.MERCURY_SLACK_SIGNING_SECRET;
      if (hasToken && hasSecret) {
        pass("Slack: enabled and configured");
      } else {
        const missing = [
          !hasToken && "MERCURY_SLACK_BOT_TOKEN",
          !hasSecret && "MERCURY_SLACK_SIGNING_SECRET",
        ].filter(Boolean);
        fail(
          `Slack: enabled but missing ${missing.join(", ")}`,
          "Add to .env — see docs/setup-slack.md",
        );
      }
    }
    if (telegramEnabled) {
      if (process.env.MERCURY_TELEGRAM_BOT_TOKEN) {
        pass("Telegram: enabled and token configured");
      } else {
        fail(
          "Telegram: enabled but MERCURY_TELEGRAM_BOT_TOKEN not set",
          "Add your bot token to .env",
        );
      }
    }
  }

  // 6. Admins
  console.log("\nPermissions:");
  if (cfg.admins) {
    pass(`Admins configured (${cfg.admins.split(",").length} admin(s))`);
  } else {
    warn(
      "No admins configured — no one will have admin permissions",
      "Add your platform ID to the admins field in mercury.yaml or MERCURY_ADMINS in .env",
    );
  }

  // 7. Bun version
  console.log("\nRuntime:");
  const bunVersionCheck = spawnSync("bun", ["--version"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (bunVersionCheck.status === 0) {
    const bunVersion = bunVersionCheck.stdout.trim();
    pass(`Bun ${bunVersion} installed`);
  } else {
    fail(
      "Bun is not installed",
      "Install from https://bun.sh — required to run Mercury",
    );
  }

  // 8. Port available
  console.log("\nNetwork:");
  const port = String(cfg.port);
  const portInUse = isPortInUse(port);
  if (portInUse) {
    warn(
      `Port ${port} is in use (Mercury may already be running)`,
      `Change MERCURY_PORT in .env or stop the existing process`,
    );
  } else {
    pass(`Port ${port} is available`);
  }

  // 8. Spaces exist
  console.log("\nSpaces:");
  const dbPath = join(CWD, dataDir, "state.db");
  if (existsSync(dbPath)) {
    try {
      const db = new Db(dbPath);
      const spaces = db.listSpaces();
      if (spaces.length > 0) {
        pass(`${spaces.length} space(s) configured`);
      } else {
        warn(
          "No spaces created yet — incoming messages will be dropped",
          "Run 'mercury spaces create <name>'",
        );
      }
      db.close();
    } catch {
      warn("Could not read database");
    }
  } else {
    warn("No database yet (created on first run)");
  }

  // Summary
  console.log(`\n─────────────────────────────────`);
  console.log(`  ${passed} passed  ${warned} warnings  ${failed} errors`);
  if (failed > 0) {
    console.log("\n  Fix the errors above before starting Mercury.");
    process.exit(1);
  } else if (warned > 0) {
    console.log("\n  Mercury should work, but review the warnings above.");
  } else {
    console.log("\n  Everything looks good! 🚀");
  }
}

// CLI setup
const program = new Command();

program
  .name("mercury")
  .description("Personal AI assistant for chat platforms")
  .version(getVersion());

program
  .command("init")
  .description("Initialize a new mercury project in current directory")
  .action(initAction);

program
  .command("setup")
  .description("Interactive guided setup for a new Mercury project")
  .option("--profile <name>", "Start from a built-in or external profile")
  .action(async (options: { profile?: string }) => {
    const readline = await import("node:readline");
    const { randomBytes } = await import("node:crypto");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (q: string): Promise<string> =>
      new Promise((r) => rl.question(q, r));
    const pick = async (
      prompt: string,
      choices: string[],
      defaultChoice?: string,
    ): Promise<string> => {
      const def = defaultChoice ? ` [${defaultChoice}]` : "";
      const answer = await ask(`  ${prompt} (${choices.join(" / ")})${def}: `);
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed && defaultChoice) return defaultChoice;
      if (choices.includes(trimmed)) return trimmed;
      console.log(
        `  Invalid choice. Using default: ${defaultChoice || choices[0]}`,
      );
      return defaultChoice || choices[0];
    };

    console.log("\n  Mercury Setup");
    console.log(`  ${"─".repeat(45)}\n`);

    // Prerequisite checks
    console.log("  Checking prerequisites...");
    const dockerCheck = spawnSync("docker", ["info"], {
      stdio: "pipe",
      timeout: 10_000,
    });
    if (dockerCheck.status !== 0) {
      console.error("\n  Error: Docker is not running.");
      console.error("  Install from https://docs.docker.com/get-docker/");
      rl.close();
      process.exit(1);
    }
    console.log("  Docker: OK");

    const bunCheck = spawnSync("bun", ["--version"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (bunCheck.status !== 0) {
      console.error("\n  Error: Bun is not installed.");
      console.error("  Install from https://bun.sh");
      rl.close();
      process.exit(1);
    }
    console.log(`  Bun: OK (${bunCheck.stdout.trim()})\n`);

    // Step 1: AI Provider
    console.log("  Step 1/4: AI Provider");
    const provider = await pick(
      "Which AI provider?",
      ["anthropic", "openai", "google", "groq"],
      "anthropic",
    );

    const providerKeyMap: Record<
      string,
      { envKey: string; label: string; defaultModel: string }
    > = {
      anthropic: {
        envKey: "MERCURY_ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        defaultModel: "claude-sonnet-4-20250514",
      },
      openai: {
        envKey: "MERCURY_OPENAI_API_KEY",
        label: "OpenAI API key",
        defaultModel: "gpt-4o",
      },
      google: {
        envKey: "MERCURY_GEMINI_API_KEY",
        label: "Gemini API key",
        defaultModel: "gemini-2.5-flash",
      },
      groq: {
        envKey: "MERCURY_GROQ_API_KEY",
        label: "Groq API key",
        defaultModel: "llama-3.3-70b-versatile",
      },
    };

    const providerInfo = providerKeyMap[provider];
    const apiKey = (await ask(`  ${providerInfo.label}: `)).trim();
    if (!apiKey) {
      console.error("  Error: API key is required.");
      rl.close();
      process.exit(1);
    }

    const modelAnswer = (
      await ask(`  Model [${providerInfo.defaultModel}]: `)
    ).trim();
    const model = modelAnswer || providerInfo.defaultModel;
    console.log();

    // Step 2: Chat Platform
    console.log("  Step 2/4: Chat Platform");
    const platform = await pick(
      "Which platform?",
      ["telegram", "discord", "slack", "whatsapp", "none"],
      "none",
    );

    let platformToken = "";
    let platformSecret = "";
    if (platform === "telegram") {
      platformToken = (await ask("  Telegram bot token: ")).trim();
    } else if (platform === "discord") {
      platformToken = (await ask("  Discord bot token: ")).trim();
    } else if (platform === "slack") {
      platformToken = (await ask("  Slack bot token: ")).trim();
      platformSecret = (await ask("  Slack signing secret: ")).trim();
    }
    console.log();

    // Step 3: Profile
    console.log("  Step 3/4: Agent Profile");
    let profileChoice = options.profile;
    if (!profileChoice) {
      const builtinProfiles: string[] = [];
      if (existsSync(PROFILES_DIR)) {
        for (const entry of readdirSync(PROFILES_DIR, {
          withFileTypes: true,
        })) {
          if (entry.isDirectory()) builtinProfiles.push(entry.name);
        }
      }
      const profileChoices =
        builtinProfiles.length > 0 ? [...builtinProfiles, "blank"] : ["blank"];
      profileChoice = await pick(
        "Start from a template?",
        profileChoices,
        profileChoices[0],
      );
    }
    console.log();

    // Step 4: Security
    console.log("  Step 4/4: Security");
    const secret = `mrc_${randomBytes(24).toString("hex")}`;
    console.log(`  Generated API secret: ${secret.slice(0, 12)}...`);
    console.log("  (saved to .env)\n");

    rl.close();

    // Run init
    initAction();

    // Write .env with collected values
    const envPath = join(CWD, ".env");
    let envContent = readFileSync(envPath, "utf-8");

    const setEnv = (key: string, value: string) => {
      const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    };

    setEnv("MERCURY_MODEL_PROVIDER", provider);
    setEnv("MERCURY_MODEL", model);
    setEnv(providerInfo.envKey, apiKey);
    setEnv("MERCURY_API_SECRET", secret);
    setEnv("MERCURY_PORT", "8787");

    if (platform !== "none") {
      setEnv(`MERCURY_ENABLE_${platform.toUpperCase()}`, "true");
      if (platform === "telegram" && platformToken) {
        setEnv("MERCURY_TELEGRAM_BOT_TOKEN", platformToken);
      } else if (platform === "discord" && platformToken) {
        setEnv("MERCURY_DISCORD_BOT_TOKEN", platformToken);
      } else if (platform === "slack") {
        if (platformToken) setEnv("MERCURY_SLACK_BOT_TOKEN", platformToken);
        if (platformSecret)
          setEnv("MERCURY_SLACK_SIGNING_SECRET", platformSecret);
      }
    }

    writeFileSync(envPath, envContent);

    // Apply profile if not blank
    if (profileChoice && profileChoice !== "blank") {
      const profileDir = join(PROFILES_DIR, profileChoice);
      if (existsSync(profileDir)) {
        const agentsMd = join(profileDir, "AGENTS.md");
        if (existsSync(agentsMd)) {
          copyFileSync(agentsMd, join(CWD, ".mercury/global/AGENTS.md"));
        }
        const profileExtDir = join(profileDir, "extensions");
        if (existsSync(profileExtDir)) {
          const userExtDir = join(CWD, ".mercury/extensions");
          mkdirSync(userExtDir, { recursive: true });
          cpSync(profileExtDir, userExtDir, { recursive: true });
        }
      }
    }

    // Create default space
    const dbPath = join(CWD, ".mercury", "state.db");
    const db = new Db(dbPath);
    try {
      db.ensureSpace("main");
    } finally {
      db.close();
    }

    console.log(`\n  ${"─".repeat(45)}`);
    console.log("  Setup complete!\n");
    console.log("    Start:   mercury service install");
    console.log("    Status:  mercury service status");
    console.log("    Logs:    mercury service logs -f");
    console.log('    Chat:    mercury chat "hello"');
    console.log(`  ${"─".repeat(45)}\n`);
  });

program
  .command("run")
  .description("Start the chat adapters (WhatsApp/Slack/Discord)")
  .action(runAction);

program
  .command("build")
  .description("Build the agent container image")
  .action(buildAction);

program
  .command("status")
  .description("Show current status and configuration")
  .action(statusAction);

program
  .command("doctor")
  .description("Check environment and configuration for common issues")
  .action(doctorAction);

// Auth subcommand
const authCommand = program
  .command("auth")
  .description("Authenticate with providers and platforms");

authCommand
  .command("login [provider]")
  .description(
    "Login with an OAuth provider (anthropic, github-copilot, google-gemini-cli, antigravity, openai-codex)",
  )
  .action(async (providerArg?: string) => {
    const { getOAuthProviders, getOAuthProvider } = await import(
      "@mariozechner/pi-ai/oauth"
    );
    const readline = await import("node:readline");
    const { exec } = await import("node:child_process");

    const providers = getOAuthProviders();

    let providerId: string;

    if (providerArg) {
      providerArg = providerArg.trim();
      const provider = getOAuthProvider(providerArg);
      if (!provider) {
        console.error(
          `Unknown provider: ${providerArg}\nAvailable: ${providers.map((p: { id: string }) => p.id).join(", ")}`,
        );
        process.exit(1);
      }
      providerId = providerArg;
    } else {
      // Interactive selection
      console.log("Available OAuth providers:\n");
      for (let i = 0; i < providers.length; i++) {
        console.log(`  ${i + 1}. ${providers[i].name} (${providers[i].id})`);
      }
      console.log();

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("Select provider (number or id): ", resolve);
      });
      rl.close();

      const num = Number.parseInt(answer, 10);
      if (num >= 1 && num <= providers.length) {
        providerId = providers[num - 1].id;
      } else {
        const provider = getOAuthProvider(answer.trim());
        if (!provider) {
          console.error("Invalid selection.");
          process.exit(1);
        }
        providerId = answer.trim();
      }
    }

    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    console.log(`\nLogging in to ${provider.name}...`);

    // Resolve auth.json path
    const dataDir = getProjectDataDir(CWD);
    const authPath = join(CWD, dataDir, "global", "auth.json");
    const authDir = dirname(authPath);
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }

    // Read existing auth
    let authData: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        authData = JSON.parse(readFileSync(authPath, "utf-8"));
      } catch {
        // ignore
      }
    }

    try {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const credentials = await provider.login({
        onAuth: (info: { url: string; instructions?: string }) => {
          console.log(`\nOpen this URL to authenticate:\n\n  ${info.url}\n`);
          if (info.instructions) {
            console.log(info.instructions);
          }
          // Try to open browser
          const openCmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          exec(`${openCmd} "${info.url}"`);
        },
        onPrompt: async (prompt: { message: string; placeholder?: string }) => {
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `,
              resolve,
            );
          });
          return answer;
        },
        onProgress: (message: string) => {
          console.log(message);
        },
        onManualCodeInput: async () => {
          const answer = await new Promise<string>((resolve) => {
            rl.question("Paste redirect URL or code: ", resolve);
          });
          return answer;
        },
      });

      rl.close();

      // Save to auth.json
      authData[providerId] = { type: "oauth", ...credentials };
      writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
      chmodSync(authPath, 0o600);

      console.log(`\n✓ Logged in to ${provider.name}`);
      console.log(`  Credentials saved to ${authPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Login cancelled") {
        console.log("\nLogin cancelled.");
      } else {
        console.error(`\nLogin failed: ${message}`);
      }
      process.exit(1);
    }
  });

authCommand
  .command("logout [provider]")
  .description("Remove saved OAuth credentials for a provider")
  .action(async (providerArg?: string) => {
    const dataDir = getProjectDataDir(CWD);
    const authPath = join(CWD, dataDir, "global", "auth.json");

    if (!existsSync(authPath)) {
      console.log("No credentials found.");
      return;
    }

    let authData: Record<string, unknown>;
    try {
      authData = JSON.parse(readFileSync(authPath, "utf-8"));
    } catch {
      console.log("No credentials found.");
      return;
    }

    if (providerArg) {
      if (!(providerArg in authData)) {
        console.log(`No credentials for ${providerArg}.`);
        return;
      }
      delete authData[providerArg];
      writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
      console.log(`✓ Removed credentials for ${providerArg}`);
    } else {
      const keys = Object.keys(authData);
      if (keys.length === 0) {
        console.log("No credentials found.");
        return;
      }
      console.log("Logged in providers:");
      for (const key of keys) {
        console.log(`  - ${key}`);
      }
      console.log('\nRun "mercury auth logout <provider>" to remove.');
    }
  });

authCommand
  .command("status")
  .description("Show authentication status for all providers")
  .action(async () => {
    const { getOAuthProviders } = await import("@mariozechner/pi-ai/oauth");

    const dataDir = getProjectDataDir(CWD);
    const authPath = join(CWD, dataDir, "global", "auth.json");

    let authData: Record<string, { type?: string; expires?: number }> = {};
    if (existsSync(authPath)) {
      try {
        authData = JSON.parse(readFileSync(authPath, "utf-8"));
      } catch {
        // ignore
      }
    }

    // Check env vars too
    const envPath = join(CWD, ".env");
    const envVars = existsSync(envPath) ? loadEnvFile(envPath) : {};

    const providers = getOAuthProviders();
    console.log("Authentication status:\n");

    for (const provider of providers) {
      const cred = authData[provider.id];
      if (cred?.type === "oauth") {
        const expired = cred.expires ? Date.now() >= cred.expires : false;
        const status = expired ? "expired (will auto-refresh)" : "✓ logged in";
        console.log(`  ${provider.name}: ${status}`);
      } else {
        console.log(`  ${provider.name}: not logged in`);
      }
    }

    // Check for API keys in env
    console.log();
    const apiKeyVars = [
      "MERCURY_ANTHROPIC_API_KEY",
      "MERCURY_ANTHROPIC_OAUTH_TOKEN",
      "MERCURY_OPENAI_API_KEY",
    ];
    let hasEnvKeys = false;
    for (const key of apiKeyVars) {
      if (envVars[key]) {
        console.log(`  ${key}: ✓ set in .env`);
        hasEnvKeys = true;
      }
    }
    if (!hasEnvKeys) {
      console.log("  No API keys found in .env");
    }
  });

authCommand
  .command("whatsapp")
  .description("Authenticate with WhatsApp via QR code or pairing code")
  .option("--pairing-code", "Use pairing code instead of QR code")
  .option(
    "--phone <number>",
    "Phone number for pairing code (e.g., 14155551234)",
  )
  .action(async (options: { pairingCode?: boolean; phone?: string }) => {
    const cfg = loadConfig();
    const authDir = resolveProjectPath(cfg.whatsappAuthDir);
    const statusDir = resolveProjectPath(cfg.dataDir);

    try {
      await authenticate({
        authDir,
        statusDir,
        usePairingCode: options.pairingCode,
        phoneNumber: options.phone,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Authentication failed:", message);
      process.exit(1);
    }
  });

// Service management commands
const SERVICE_NAME = "mercury";
const LAUNCHD_LABEL = "com.mercury.agent";

function getServicePaths(): {
  systemdUser: string;
  systemdSystem: string;
  launchdPlist: string;
  logDir: string;
} {
  return {
    systemdUser: join(homedir(), ".config/systemd/user/mercury.service"),
    systemdSystem: "/etc/systemd/system/mercury.service",
    launchdPlist: join(
      homedir(),
      "Library/LaunchAgents/com.mercury.agent.plist",
    ),
    logDir: join(CWD, ".mercury/logs"),
  };
}

function checkCommandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0;
}

function generateSystemdService(userMode: boolean): string {
  const bunPath = resolve(process.execPath);
  const mercuryScript = resolve(process.argv[1]);
  const workDir = CWD;

  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `[Unit]
Description=Mercury Chat Agent
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} run ${mercuryScript} run
WorkingDirectory=${workDir}
Environment=PATH=${currentPath}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=${userMode ? "default.target" : "multi-user.target"}
`;
}

function generateLaunchdPlist(): string {
  const bunPath = resolve(process.execPath);
  const mercuryScript = resolve(process.argv[1]);
  const workDir = CWD;
  const { logDir } = getServicePaths();

  // Capture current PATH so docker and other tools are available
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${mercuryScript}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/mercury.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/mercury.error.log</string>
</dict>
</plist>`;
}

function installSystemd(userMode: boolean): void {
  if (!checkCommandExists("systemctl")) {
    console.error("Error: systemctl not found. Is systemd installed?");
    process.exit(1);
  }

  const paths = getServicePaths();
  const servicePath = userMode ? paths.systemdUser : paths.systemdSystem;
  const serviceContent = generateSystemdService(userMode);

  // Check if we need sudo for system-level install
  if (!userMode) {
    console.log("Installing system-level service requires sudo.");
    console.log("Consider using --user flag for user-level service instead.");
  }

  // Create directory if needed
  mkdirSync(dirname(servicePath), { recursive: true });

  // Write service file
  try {
    writeFileSync(servicePath, serviceContent);
  } catch (err) {
    if (!userMode) {
      console.error(
        "Error: Cannot write to system directory. Try with sudo or use --user flag.",
      );
    } else {
      console.error(`Error writing service file: ${err}`);
    }
    process.exit(1);
  }

  // Enable and start service
  const systemctlBase = userMode ? ["systemctl", "--user"] : ["systemctl"];

  console.log("Reloading systemd daemon...");
  const reloadResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "daemon-reload"],
    {
      stdio: "inherit",
    },
  );
  if (reloadResult.status !== 0) {
    console.error("Failed to reload systemd daemon");
    process.exit(1);
  }

  console.log("Enabling mercury service...");
  const enableResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "enable", SERVICE_NAME],
    {
      stdio: "inherit",
    },
  );
  if (enableResult.status !== 0) {
    console.error("Failed to enable service");
    process.exit(1);
  }

  console.log("Starting mercury service...");
  const startResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "start", SERVICE_NAME],
    {
      stdio: "inherit",
    },
  );
  if (startResult.status !== 0) {
    console.error("Failed to start service");
    process.exit(1);
  }

  console.log("\n✓ Mercury service installed and started");
  console.log(`  Service file: ${servicePath}`);
  console.log(
    `  View logs: journalctl ${userMode ? "--user " : ""}-u mercury -f`,
  );
}

function installLaunchd(): void {
  if (!checkCommandExists("launchctl")) {
    console.error("Error: launchctl not found. Are you on macOS?");
    process.exit(1);
  }

  const paths = getServicePaths();
  const plistContent = generateLaunchdPlist();

  // Create log directory
  mkdirSync(paths.logDir, { recursive: true });

  // Create LaunchAgents directory if needed
  mkdirSync(dirname(paths.launchdPlist), { recursive: true });

  // Unload existing service if present
  if (existsSync(paths.launchdPlist)) {
    spawnSync("launchctl", ["unload", paths.launchdPlist], { stdio: "pipe" });
  }

  // Write plist file
  writeFileSync(paths.launchdPlist, plistContent);

  // Load service
  const loadResult = spawnSync("launchctl", ["load", paths.launchdPlist], {
    stdio: "inherit",
  });
  if (loadResult.status !== 0) {
    console.error("Failed to load service");
    process.exit(1);
  }

  console.log("\n✓ Mercury service installed and started");
  console.log(`  Plist: ${paths.launchdPlist}`);
  console.log(`  Logs: ${paths.logDir}/mercury.log`);
  console.log(`  View logs: tail -f ${paths.logDir}/mercury.log`);
}

function serviceInstallAction(options: { user?: boolean }): void {
  // Verify we're in a mercury project
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    console.error("Error: .env file not found in current directory.");
    console.error("Run 'mercury init' first, or cd into your mercury project.");
    process.exit(1);
  }

  const platform = process.platform;

  if (platform === "darwin") {
    installLaunchd();
  } else if (platform === "linux") {
    // Default to user mode unless explicitly installing system-wide
    installSystemd(options.user ?? true);
  } else {
    console.error(`Unsupported platform: ${platform}`);
    console.log("See docs/deployment.md for manual setup instructions.");
    process.exit(1);
  }
}

function serviceUninstallAction(): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    if (existsSync(paths.launchdPlist)) {
      console.log("Unloading mercury service...");
      spawnSync("launchctl", ["unload", paths.launchdPlist], {
        stdio: "inherit",
      });
      unlinkSync(paths.launchdPlist);
      console.log("✓ Mercury service uninstalled");
    } else {
      console.log("Service not installed");
    }
  } else if (platform === "linux") {
    // Try user service first, then system
    if (existsSync(paths.systemdUser)) {
      console.log("Stopping mercury user service...");
      spawnSync("systemctl", ["--user", "stop", SERVICE_NAME], {
        stdio: "inherit",
      });
      console.log("Disabling mercury user service...");
      spawnSync("systemctl", ["--user", "disable", SERVICE_NAME], {
        stdio: "inherit",
      });
      unlinkSync(paths.systemdUser);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      console.log("✓ Mercury user service uninstalled");
    } else if (existsSync(paths.systemdSystem)) {
      console.log("Stopping mercury system service...");
      spawnSync("systemctl", ["stop", SERVICE_NAME], { stdio: "inherit" });
      console.log("Disabling mercury system service...");
      spawnSync("systemctl", ["disable", SERVICE_NAME], { stdio: "inherit" });
      try {
        unlinkSync(paths.systemdSystem);
      } catch {
        console.error(
          "Error: Cannot remove system service file. Try with sudo.",
        );
        process.exit(1);
      }
      spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
      console.log("✓ Mercury system service uninstalled");
    } else {
      console.log("Service not installed");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

function serviceStatusAction(): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    if (!existsSync(paths.launchdPlist)) {
      console.log("Mercury service is not installed");
      return;
    }
    console.log("Mercury service status:\n");
    spawnSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "inherit" });
  } else if (platform === "linux") {
    // Try user service first
    if (existsSync(paths.systemdUser)) {
      spawnSync("systemctl", ["--user", "status", SERVICE_NAME], {
        stdio: "inherit",
      });
    } else if (existsSync(paths.systemdSystem)) {
      spawnSync("systemctl", ["status", SERVICE_NAME], { stdio: "inherit" });
    } else {
      console.log("Mercury service is not installed");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

function serviceLogsAction(options: { follow?: boolean }): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    const logPath = join(paths.logDir, "mercury.log");
    if (!existsSync(logPath)) {
      console.error(`Log file not found: ${logPath}`);
      console.log("The service may not have been started yet.");
      process.exit(1);
    }
    const args = options.follow ? ["-f", logPath] : ["-n", "100", logPath];
    spawnSync("tail", args, { stdio: "inherit" });
  } else if (platform === "linux") {
    // Determine if user or system service
    const isUserService = existsSync(paths.systemdUser);
    const isSystemService = existsSync(paths.systemdSystem);

    if (!isUserService && !isSystemService) {
      console.error("Mercury service is not installed");
      process.exit(1);
    }

    const args = isUserService
      ? ["--user", "-u", SERVICE_NAME]
      : ["-u", SERVICE_NAME];
    if (options.follow) args.push("-f");
    spawnSync("journalctl", args, { stdio: "inherit" });
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

// Service subcommand
const serviceCommand = program
  .command("service")
  .description("Manage Mercury as a system service");

serviceCommand
  .command("install")
  .description("Install Mercury as a system service")
  .option(
    "--user",
    "Install as user service (default on Linux, no sudo required)",
  )
  .action(serviceInstallAction);

serviceCommand
  .command("uninstall")
  .description("Uninstall Mercury service")
  .action(serviceUninstallAction);

serviceCommand
  .command("status")
  .description("Show service status")
  .action(serviceStatusAction);

serviceCommand
  .command("logs")
  .description("View service logs")
  .option("-f, --follow", "Follow log output")
  .action(serviceLogsAction);

// ─── Extension management ─────────────────────────────────────────────────

/**
 * Resolve an extension source to a local directory path.
 *
 * Supports:
 * - Local paths: `./path/to/extension` or `/absolute/path`
 * - npm packages: `npm:<package-name>`
 * - git repos: `git:<url>`
 *
 * For npm/git, downloads to a temp dir and returns that path.
 * Returns { dir, name, cleanup } — call cleanup() to remove temp dirs.
 */
function resolveExtensionSource(source: string): {
  dir: string;
  name: string;
  cleanup: () => void;
} {
  // npm: prefix
  if (source.startsWith("npm:")) {
    const pkg = source.slice(4);
    const maybeName = pkg.includes("/") ? pkg.split("/").pop() : pkg;
    const name = maybeName || pkg;
    const tmp = join(tmpdir(), `mercury-ext-npm-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    console.log(`Fetching ${pkg} from npm...`);
    const packResult = spawnSync(
      "npm",
      ["pack", pkg, "--pack-destination", tmp],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: tmp,
      },
    );
    if (packResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to fetch npm package "${pkg}"`);
      console.error(packResult.stderr?.toString().trim());
      process.exit(1);
    }

    // Find the tarball
    const tarballs = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length === 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: npm pack produced no tarball for "${pkg}"`);
      process.exit(1);
    }

    // Extract tarball
    const tarball = join(tmp, tarballs[0]);
    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir, { recursive: true });
    const extractResult = spawnSync(
      "tar",
      ["xzf", tarball, "-C", extractDir, "--strip-components=1"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (extractResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to extract tarball for "${pkg}"`);
      process.exit(1);
    }

    return {
      dir: extractDir,
      name,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  // git: prefix — supports optional #subdir (e.g. git:https://repo.git#packages/media)
  if (source.startsWith("git:")) {
    const raw = source.slice(4);
    // Split off optional #subdirectory fragment
    const hashIdx = raw.indexOf("#");
    const urlPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const subdir = hashIdx >= 0 ? raw.slice(hashIdx + 1) : undefined;
    // Accept git:github.com/user/repo or git:https://github.com/user/repo
    const gitUrl = urlPart.startsWith("http") ? urlPart : `https://${urlPart}`;
    const tmp = join(tmpdir(), `mercury-ext-git-${Date.now()}`);

    console.log(`Cloning ${gitUrl}...`);
    const cloneResult = spawnSync(
      "git",
      ["clone", "--depth", "1", gitUrl, tmp],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (cloneResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to clone "${gitUrl}"`);
      console.error(cloneResult.stderr?.toString().trim());
      process.exit(1);
    }

    const extDir = subdir ? join(tmp, subdir) : tmp;
    if (subdir && !existsSync(extDir)) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: subdirectory "${subdir}" not found in cloned repo`);
      process.exit(1);
    }

    const name = basename(extDir);

    return {
      dir: extDir,
      name,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  // GitHub shorthand: user/repo or user/repo#subdir
  if (
    /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/.test(source) &&
    !source.startsWith("/") &&
    !source.startsWith(".")
  ) {
    const hashIdx = source.indexOf("#");
    const repoPart = hashIdx >= 0 ? source.slice(0, hashIdx) : source;
    const subdir = hashIdx >= 0 ? source.slice(hashIdx + 1) : undefined;
    const gitUrl = `https://github.com/${repoPart}`;
    const tmp = join(tmpdir(), `mercury-ext-git-${Date.now()}`);

    console.log(`Cloning ${gitUrl}...`);
    const cloneResult = spawnSync(
      "git",
      ["clone", "--depth", "1", gitUrl, tmp],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    if (cloneResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to clone "${gitUrl}"`);
      console.error(cloneResult.stderr?.toString().trim());
      process.exit(1);
    }

    const extDir = subdir ? join(tmp, subdir) : tmp;
    if (subdir && !existsSync(extDir)) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: subdirectory "${subdir}" not found in cloned repo`);
      process.exit(1);
    }

    const name = basename(extDir);
    return {
      dir: extDir,
      name,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  // Local path
  const absPath = resolve(CWD, source);
  if (!existsSync(absPath)) {
    console.error(`Error: path not found: ${source}`);
    console.error("\nSupported sources:");
    console.error("  mercury add ./path/to/extension     (local path)");
    console.error("  mercury add npm:<package-name>      (npm package)");
    console.error("  mercury add git:<repo-url>          (git repository)");
    console.error("  mercury add user/repo               (GitHub shorthand)");
    console.error(
      "  mercury add user/repo#subdir        (GitHub subdirectory)",
    );
    process.exit(1);
  }
  if (!existsSync(join(absPath, "index.ts"))) {
    console.error(`Error: no index.ts found in ${source}`);
    process.exit(1);
  }

  const name = basename(absPath);
  return { dir: absPath, name, cleanup: () => {} };
}

/**
 * Read extension metadata by doing a quick dry-run load.
 * Returns partial info for the install report.
 */
async function readExtensionInfo(dir: string): Promise<{
  hasCli: boolean;
  hasSkill: boolean;
  cliNames: string[];
  permissionRoles?: string[];
}> {
  const { MercuryExtensionAPIImpl } = await import("../extensions/api.js");
  const { Db } = await import("../storage/db.js");

  // Create a temporary in-memory DB for dry-run
  const tmpDbPath = join(tmpdir(), `mercury-dryrun-${Date.now()}.db`);
  const db = new Db(tmpDbPath);
  try {
    const name = basename(dir);
    const api = new MercuryExtensionAPIImpl(name, dir, db);
    const mod = await import(join(dir, "index.ts"));
    try {
      mod.default(api);
    } catch {
      // Best-effort — some extensions may fail without full runtime
    }
    const meta = api.getMeta();
    return {
      hasCli: meta.clis.length > 0,
      hasSkill: !!meta.skillDir,
      cliNames: meta.clis.map((c) => c.name),
      permissionRoles: meta.permission?.defaultRoles,
    };
  } finally {
    db.close();
    rmSync(tmpDbPath, { force: true });
  }
}

async function addAction(source: string): Promise<void> {
  const extensionsDir = getUserExtensionsDir(CWD);
  mkdirSync(extensionsDir, { recursive: true });

  const { dir: sourceDir, name, cleanup } = resolveExtensionSource(source);

  try {
    const result = await installExtensionFromDirectory({
      cwd: CWD,
      sourceDir,
      destName: name,
    });
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    const destDir = join(extensionsDir, name);

    // Read extension info for report
    let info: Awaited<ReturnType<typeof readExtensionInfo>>;
    try {
      info = await readExtensionInfo(destDir);
    } catch {
      info = { hasCli: false, hasSkill: false, cliNames: [] };
    }

    const hasSkill = existsSync(join(destDir, "skill", "SKILL.md"));

    // Report
    console.log(`\n✓ Extension "${name}" installed`);
    if (info.hasCli) {
      console.log(
        `  CLI: ${info.cliNames.join(", ")} (available after image rebuild)`,
      );
    }
    if (hasSkill || info.hasSkill) {
      console.log(`  Skill: ${name} (available to agent)`);
    }
    if (info.permissionRoles) {
      console.log(
        `  Permission: ${name} (default: ${info.permissionRoles.join(", ")})`,
      );
    }

    if (info.hasCli) {
      console.log("\nRebuild the agent image to include the CLI:");
      console.log("  mercury build");
    }

    console.log("\nRestart mercury to activate:");
    console.log("  mercury service restart");
  } finally {
    cleanup();
  }
}

function removeAction(name: string): void {
  const result = removeInstalledExtension({ cwd: CWD, name });
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`✓ Extension "${name}" removed`);
  console.log("\nRestart mercury to apply:");
  console.log("  mercury service restart");
}

function extensionsListAction(): void {
  const userExtDir = getUserExtensionsDir(CWD);
  const builtinExtDir = join(PACKAGE_ROOT, "resources/extensions");

  const extensions: Array<{
    name: string;
    features: string[];
    description: string;
    builtin: boolean;
  }> = [];

  // Scan a directory for extensions
  function scanDir(dir: string, builtin: boolean): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!VALID_EXT_NAME_RE.test(name)) continue;
      if (RESERVED_EXTENSION_NAMES.has(name)) continue;

      const extDir = join(dir, name);
      if (!existsSync(join(extDir, "index.ts"))) continue;

      const features: string[] = [];
      if (existsSync(join(extDir, "skill", "SKILL.md"))) features.push("Skill");

      // Read SKILL.md for description
      let description = "";
      const skillMd = join(extDir, "skill", "SKILL.md");
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const descMatch = content.match(
          /^description:\s*(.+?)(?:\n[a-z]|\n---)/ms,
        );
        if (descMatch) {
          description = descMatch[1].replace(/\n\s*/g, " ").trim();
        }
      }

      extensions.push({ name, features, description, builtin });
    }
  }

  scanDir(userExtDir, false);
  scanDir(builtinExtDir, true);

  if (extensions.length === 0) {
    console.log("No extensions installed.");
    console.log("\nInstall one with:");
    console.log("  mercury add ./path/to/extension");
    console.log("  mercury add npm:<package>");
    console.log("  mercury add git:<repo-url>");
    return;
  }

  // Sort: user extensions first, then built-in, alphabetically within
  extensions.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Calculate column widths
  const nameWidth = Math.max(12, ...extensions.map((e) => e.name.length));
  const featWidth = Math.max(
    10,
    ...extensions.map((e) => e.features.join(" + ").length || 3),
  );

  for (const ext of extensions) {
    const features = ext.features.length > 0 ? ext.features.join(" + ") : "—";
    const tag = ext.builtin ? " (built-in)" : "";
    const desc = ext.description
      ? `  ${ext.description.slice(0, 60)}${ext.description.length > 60 ? "…" : ""}`
      : "";
    console.log(
      `${ext.name.padEnd(nameWidth)}  ${features.padEnd(featWidth)}${tag}${desc}`,
    );
  }
}

program
  .command("chat [text...]")
  .description("Send a message to Mercury and get a reply")
  .option("-p, --port <port>", "Mercury server port", "8787")
  .option("-s, --space <spaceId>", "Space to route the message to", "main")
  .option("-f, --file <paths...>", "Attach files to the message")
  .option("--caller <callerId>", "Caller ID", "cli:user")
  .option("--json", "Output raw JSON response")
  .action(
    async (
      textParts: string[],
      options: {
        port: string;
        space: string;
        file?: string[];
        caller: string;
        json?: boolean;
      },
    ) => {
      let text: string;
      if (textParts.length > 0) {
        text = textParts.join(" ");
      } else if (!process.stdin.isTTY) {
        text = readFileSync("/dev/stdin", "utf-8").trim();
      } else {
        console.error("Usage: mercury chat <message>");
        console.error('       echo "message" | mercury chat');
        process.exit(1);
      }

      if (!text) {
        console.error("Error: empty message");
        process.exit(1);
      }

      const url = `http://localhost:${options.port}/chat`;
      const body: Record<string, unknown> = {
        text,
        callerId: options.caller,
        spaceId: options.space,
      };

      if (options.file && options.file.length > 0) {
        const files: Array<{ name: string; data: string }> = [];
        for (const filePath of options.file) {
          const abs = resolve(CWD, filePath);
          if (!existsSync(abs)) {
            console.error(`Error: file not found: ${filePath}`);
            process.exit(1);
          }
          files.push({
            name: basename(abs),
            data: readFileSync(abs).toString("base64"),
          });
        }
        body.files = files;
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          console.error(
            `Error: ${(err as { error?: string }).error || res.statusText}`,
          );
          process.exit(1);
        }

        const data = (await res.json()) as {
          reply: string;
          files: Array<{
            filename: string;
            mimeType: string;
            sizeBytes: number;
            data: string;
          }>;
          error?: string;
        };

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.reply) console.log(data.reply);
          if (data.files && data.files.length > 0) {
            for (const f of data.files) {
              const outPath = join(CWD, f.filename);
              writeFileSync(outPath, Buffer.from(f.data, "base64"));
              const kb = (f.sizeBytes / 1024).toFixed(1);
              console.error(`→ ${outPath} (${kb} KB)`);
            }
          }
        }
      } catch (err) {
        if (
          err instanceof TypeError &&
          (err.message.includes("fetch") ||
            err.message.includes("ECONNREFUSED"))
        ) {
          console.error(
            `Error: cannot connect to Mercury at localhost:${options.port}`,
          );
          console.error("Is Mercury running? Try: mercury service status");
        } else {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        process.exit(1);
      }
    },
  );

// ─── Profile management ─────────────────────────────────────────────────

const profilesCommand = program
  .command("profiles")
  .description("Manage agent profiles");

profilesCommand
  .command("list")
  .description("List available built-in profiles")
  .action(async () => {
    const { listBuiltinProfiles } = await import("../core/profiles.js");
    const profiles = listBuiltinProfiles(PROFILES_DIR);

    if (profiles.length === 0) {
      console.log("No built-in profiles found.");
      return;
    }

    console.log("Available profiles:\n");
    const nameWidth = Math.max(...profiles.map((p) => p.name.length), 10);
    for (const profile of profiles) {
      const desc = profile.description || "";
      const extCount = profile.extensions.length;
      const extras =
        extCount > 0
          ? ` (${extCount} extension${extCount > 1 ? "s" : ""})`
          : "";
      console.log(`  ${profile.name.padEnd(nameWidth)}  ${desc}${extras}`);
    }

    console.log("\nUse with: mercury setup --profile <name>");
  });

profilesCommand
  .command("show <name>")
  .description("Show details of a profile")
  .action(async (name: string) => {
    const { loadProfileFromDir } = await import("../core/profiles.js");
    const profileDir = join(PROFILES_DIR, name);

    if (!existsSync(join(profileDir, "mercury-profile.yaml"))) {
      console.error(`Profile not found: ${name}`);
      console.log("\nRun 'mercury profiles list' to see available profiles.");
      process.exit(1);
    }

    const profile = loadProfileFromDir(profileDir);
    console.log(`Profile: ${profile.name}`);
    if (profile.description) console.log(`Description: ${profile.description}`);
    console.log(`Version: ${profile.version}`);

    if (profile.defaults) {
      console.log("\nDefaults:");
      for (const [key, value] of Object.entries(profile.defaults)) {
        if (value) console.log(`  ${key}: ${value}`);
      }
    }

    if (profile.extensions.length > 0) {
      console.log("\nExtensions:");
      for (const ext of profile.extensions) {
        console.log(`  ${ext.name} (${ext.source})`);
      }
    }

    if (profile.env.length > 0) {
      console.log("\nRequired env vars:");
      for (const v of profile.env) {
        const req = v.required ? " (required)" : " (optional)";
        console.log(
          `  ${v.key}${req}${v.description ? ` — ${v.description}` : ""}`,
        );
      }
    }
  });

profilesCommand
  .command("export <output-dir>")
  .description("Export the current project as a reusable profile")
  .action(async (outputDir: string) => {
    const absOutput = resolve(CWD, outputDir);
    mkdirSync(absOutput, { recursive: true });

    // Read merged config (mercury.yaml + .env) for defaults
    const envPath = join(CWD, ".env");
    if (existsSync(envPath)) Object.assign(process.env, loadEnvFile(envPath));
    const exportCfg = loadConfig();

    const projectName = basename(CWD)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    // Copy AGENTS.md if present
    const agentsMd = join(CWD, ".mercury/global/AGENTS.md");
    if (existsSync(agentsMd)) {
      copyFileSync(agentsMd, join(absOutput, "AGENTS.md"));
    }

    // Copy extensions
    const userExtDir = join(CWD, ".mercury/extensions");
    if (existsSync(userExtDir)) {
      cpSync(userExtDir, join(absOutput, "extensions"), { recursive: true });
    }

    // Generate manifest
    const extNames: string[] = [];
    if (existsSync(userExtDir)) {
      for (const entry of readdirSync(userExtDir, { withFileTypes: true })) {
        if (entry.isDirectory()) extNames.push(entry.name);
      }
    }

    const extensions = extNames.map((name) => ({
      name,
      source: `./extensions/${name}`,
    }));

    const yaml = [
      `name: ${projectName}`,
      `description: Exported from ${basename(CWD)}`,
      "version: 0.1.0",
      "",
      existsSync(agentsMd) ? "agents_md: ./AGENTS.md" : "",
      "",
      extensions.length > 0
        ? `extensions:\n${extensions.map((e) => `  - name: ${e.name}\n    source: "${e.source}"`).join("\n")}`
        : "extensions: []",
      "",
      "env: []",
      "",
      "defaults:",
      `  model_provider: ${exportCfg.modelProvider}`,
      `  model: ${exportCfg.model}`,
      exportCfg.triggerPatterns !== "@Pi,Pi"
        ? `  trigger_patterns: "${exportCfg.triggerPatterns}"`
        : "",
      exportCfg.botUsername !== "mercury"
        ? `  bot_username: ${exportCfg.botUsername}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    writeFileSync(join(absOutput, "mercury-profile.yaml"), `${yaml}\n`);

    console.log(`Exported profile to ${absOutput}/`);
    console.log("\nContents:");
    console.log("  mercury-profile.yaml");
    if (existsSync(agentsMd)) console.log("  AGENTS.md");
    if (extNames.length > 0) {
      for (const name of extNames) {
        console.log(`  extensions/${name}/`);
      }
    }
    console.log(`\nUse with: mercury setup --profile ${absOutput}`);
  });

const spacesCommand = program.command("spaces").description("Manage spaces");

spacesCommand
  .command("list")
  .description("List all spaces")
  .action(() => {
    const spaces = withProjectDb((db) => db.listSpaces());
    if (spaces.length === 0) {
      console.log("No spaces found.");
      return;
    }
    for (const space of spaces) {
      const tags = space.tags ? ` [${space.tags}]` : "";
      console.log(`${space.id}\t${space.name}${tags}`);
    }
  });

spacesCommand
  .command("create <id>")
  .description("Create a new space")
  .option("-n, --name <name>", "Display name (defaults to id)")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .action((id: string, options: { name?: string; tags?: string }) => {
    const name = options.name?.trim() || id;
    const space = withProjectDb((db) => db.createSpace(id, name, options.tags));
    console.log(`Created space '${space.id}' (${space.name})`);
  });

spacesCommand
  .command("delete <id>")
  .description("Delete a space and all its data")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, options: { yes?: boolean }) => {
    const space = withProjectDb((db) => db.getSpace(id));
    if (!space) {
      console.error(`Error: space not found: ${id}`);
      process.exit(1);
    }

    if (!options.yes) {
      const rl = require("node:readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(
        `Delete space '${space.id}' (${space.name}) and all its data? [y/N] `,
        (answer: string) => {
          rl.close();
          if (answer.trim().toLowerCase() !== "y") {
            console.log("Aborted.");
            return;
          }
          const result = withProjectDb((db) => db.deleteSpace(id));
          const spacesDir = join(CWD, getProjectDataDir(CWD), "spaces");
          try {
            removeSpaceWorkspace(spacesDir, id);
          } catch (err) {
            console.warn(
              `Warning: could not remove workspace directory for space '${id}':`,
              err instanceof Error ? err.message : err,
            );
          }
          console.log(
            `Deleted space '${id}' — removed ${result.removed.messages} messages, ${result.removed.tasks} tasks`,
          );
        },
      );
      return;
    }

    const result = withProjectDb((db) => db.deleteSpace(id));
    const spacesDir = join(CWD, getProjectDataDir(CWD), "spaces");
    try {
      removeSpaceWorkspace(spacesDir, id);
    } catch (err) {
      console.warn(
        `Warning: could not remove workspace directory for space '${id}':`,
        err instanceof Error ? err.message : err,
      );
    }
    console.log(
      `Deleted space '${id}' — removed ${result.removed.messages} messages, ${result.removed.tasks} tasks`,
    );
  });

program
  .command("conversations")
  .alias("convos")
  .description("List conversations")
  .option("--unlinked", "Show only unlinked conversations")
  .action((options: { unlinked?: boolean }) => {
    const conversations = withProjectDb((db) =>
      db.listConversations(options.unlinked ? { linked: false } : undefined),
    );
    if (conversations.length === 0) {
      console.log("No conversations found.");
      return;
    }
    for (const convo of conversations) {
      const title = convo.observedTitle || convo.externalId;
      const status = convo.spaceId ? `→ ${convo.spaceId}` : "(unlinked)";
      console.log(`${convo.id}\t${convo.platform}\t${title}\t${status}`);
    }
  });

program
  .command("link <conversation> <space>")
  .description("Link a conversation to a space")
  .action((conversation: string, space: string) => {
    withProjectDb((db) => {
      const targetSpace = db.getSpace(space);
      if (!targetSpace) {
        console.error(`Error: space not found: ${space}`);
        process.exit(1);
      }

      let target = Number.isFinite(Number(conversation))
        ? db.listConversations().find((c) => c.id === Number(conversation))
        : null;

      if (!target) {
        const q = conversation.toLowerCase();
        const matches = db.listConversations().filter((c) => {
          const observed = c.observedTitle?.toLowerCase() ?? "";
          const external = c.externalId.toLowerCase();
          return observed.includes(q) || external.includes(q);
        });

        if (matches.length === 0) {
          console.error(`Error: conversation not found: ${conversation}`);
          process.exit(1);
        }
        if (matches.length > 1) {
          console.error("Error: conversation is ambiguous. Matches:");
          for (const match of matches) {
            const title = match.observedTitle || match.externalId;
            const status = match.spaceId ? `→ ${match.spaceId}` : "(unlinked)";
            console.error(
              `  ${match.id}\t${match.platform}\t${title}\t${status}`,
            );
          }
          process.exit(1);
        }
        target = matches[0];
      }

      const ok = db.linkConversation(target.id, space);
      if (!ok) {
        console.error(`Error: failed to link conversation ${target.id}`);
        process.exit(1);
      }

      const title = target.observedTitle || target.externalId;
      console.log(`Linked conversation ${target.id} (${title}) → ${space}`);
    });
  });

// Extension commands
program
  .command("add <source>")
  .description(
    "Install an extension (local path, npm:<pkg>, git:<url>, or user/repo)",
  )
  .action(addAction);

program
  .command("remove <name>")
  .description("Remove an installed extension")
  .action(removeAction);

const extCommand = program
  .command("extensions")
  .alias("ext")
  .description("Manage extensions");

extCommand
  .command("list")
  .description("List installed extensions")
  .action(extensionsListAction);

extCommand
  .command("create <name>")
  .description("Scaffold a new extension")
  .action((name: string) => {
    if (!VALID_EXT_NAME_RE.test(name)) {
      console.error(
        `Error: invalid extension name "${name}" (must be lowercase alphanumeric + hyphens)`,
      );
      process.exit(1);
    }
    if (RESERVED_EXTENSION_NAMES.has(name)) {
      console.error(`Error: "${name}" is a reserved built-in command name`);
      process.exit(1);
    }

    const extensionsDir = getUserExtensionsDir(CWD);
    const extDir = join(extensionsDir, name);

    if (existsSync(extDir)) {
      console.error(`Error: extension "${name}" already exists at ${extDir}`);
      process.exit(1);
    }

    mkdirSync(extDir, { recursive: true });
    mkdirSync(join(extDir, "skill"), { recursive: true });

    // index.ts scaffold
    writeFileSync(
      join(extDir, "index.ts"),
      `import type { MercuryExtensionAPI } from "mercury-ai";

export default function (mercury: MercuryExtensionAPI) {
  // Register a skill for the AI agent
  mercury.skill(import.meta.dir);

  // Register CLI commands available inside the container
  // mercury.cli({
  //   name: "${name}",
  //   description: "Description of your CLI",
  //   install: ["npm install -g your-tool"],
  // });

  // Register environment variables your extension needs
  // mercury.env({
  //   key: "MERCURY_${name.toUpperCase().replace(/-/g, "_")}_API_KEY",
  //   description: "API key for ${name}",
  //   required: true,
  // });

  // Register hooks
  // mercury.hook("before_container", async (ctx) => {
  //   ctx.env["MY_VAR"] = "value";
  // });
}
`,
    );

    // SKILL.md scaffold
    writeFileSync(
      join(extDir, "skill", "SKILL.md"),
      `---
name: ${name}
description: TODO — describe what this extension does
---

# ${name}

## When to Use

Describe when the agent should use this skill.

## Instructions

Provide instructions for the agent on how to use this extension.
`,
    );

    // package.json
    writeFileSync(
      join(extDir, "package.json"),
      `${JSON.stringify(
        {
          name: `mercury-ext-${name}`,
          version: "0.1.0",
          type: "module",
          main: "index.ts",
          description: `Mercury extension: ${name}`,
          keywords: ["mercury", "extension"],
          files: ["index.ts", "skill/"],
        },
        null,
        2,
      )}\n`,
    );

    console.log(`Created extension scaffold at ${extDir}/`);
    console.log("\nFiles:");
    console.log(`  ${name}/index.ts          — Extension entry point`);
    console.log(`  ${name}/skill/SKILL.md    — Agent skill document`);
    console.log(`  ${name}/package.json      — Package manifest`);
    console.log("\nNext steps:");
    console.log(`  1. Edit ${name}/index.ts to add your extension logic`);
    console.log(`  2. Edit ${name}/skill/SKILL.md with agent instructions`);
    console.log(
      `  3. Run 'mercury ext validate ${name}' to check your extension`,
    );
    console.log("  4. Restart Mercury to activate");
  });

extCommand
  .command("validate <name>")
  .description("Validate an extension for correctness")
  .action(async (name: string) => {
    const extensionsDir = getUserExtensionsDir(CWD);
    const extDir = join(extensionsDir, name);

    if (!existsSync(extDir)) {
      console.error(`Error: extension "${name}" not found at ${extDir}`);
      process.exit(1);
    }

    console.log(`Validating extension "${name}"...\n`);

    let errors = 0;
    let warnings = 0;

    // Check index.ts
    if (existsSync(join(extDir, "index.ts"))) {
      console.log("  ✅ index.ts found");
    } else {
      console.log("  ❌ index.ts missing (required)");
      errors++;
    }

    // Check skill
    if (existsSync(join(extDir, "skill", "SKILL.md"))) {
      const skillContent = readFileSync(
        join(extDir, "skill", "SKILL.md"),
        "utf-8",
      );
      if (skillContent.includes("TODO")) {
        console.log("  ⚠️  skill/SKILL.md contains TODO placeholders");
        warnings++;
      } else {
        console.log("  ✅ skill/SKILL.md found");
      }
    } else {
      console.log("  ⚠️  skill/SKILL.md not found (optional but recommended)");
      warnings++;
    }

    // Check package.json
    if (existsSync(join(extDir, "package.json"))) {
      console.log("  ✅ package.json found");
    } else {
      console.log("  ⚠️  package.json missing (needed for npm publish)");
      warnings++;
    }

    // Dry-run load
    if (existsSync(join(extDir, "index.ts"))) {
      const loadErr = await checkExtensionIndexLoads(extDir, name);
      if (loadErr) {
        console.log(`  ❌ Extension failed to load: ${loadErr}`);
        errors++;
      } else {
        console.log("  ✅ Extension loads successfully");
      }
    }

    // Name validation
    if (!VALID_EXT_NAME_RE.test(name)) {
      console.log(
        "  ❌ Extension name is invalid (must be lowercase alphanumeric + hyphens)",
      );
      errors++;
    } else {
      console.log("  ✅ Extension name is valid");
    }

    if (RESERVED_EXTENSION_NAMES.has(name)) {
      console.log("  ❌ Extension name conflicts with a reserved command");
      errors++;
    }

    console.log(`\n─────────────────────────────────`);
    console.log(`  ${errors} errors  ${warnings} warnings`);
    if (errors > 0) {
      console.log("\n  Fix the errors above before publishing.");
      process.exit(1);
    } else {
      console.log("\n  Extension is valid! ✅");
    }
  });

extCommand
  .command("test <name>")
  .description("Test an extension by performing a dry-run load")
  .action(async (name: string) => {
    const extensionsDir = getUserExtensionsDir(CWD);
    const extDir = join(extensionsDir, name);

    if (!existsSync(extDir)) {
      console.error(`Error: extension "${name}" not found at ${extDir}`);
      process.exit(1);
    }

    console.log(`Testing extension "${name}"...\n`);

    try {
      const info = await readExtensionInfo(extDir);

      console.log(`  Extension loaded successfully`);
      console.log(
        `  CLIs: ${info.cliNames.length > 0 ? info.cliNames.join(", ") : "none"}`,
      );
      console.log(`  Skill: ${info.hasSkill ? "yes" : "no"}`);
      if (info.permissionRoles) {
        console.log(`  Permission roles: ${info.permissionRoles.join(", ")}`);
      }
      console.log("\n  Extension test passed! ✅");
    } catch (err) {
      console.error(
        `\n  Extension test failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

program.parse();
