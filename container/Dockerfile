# syntax=docker/dockerfile:1
# Mercury Agent Container
# Bun binary copied from official image — avoids bun.sh/install script deps
FROM oven/bun:1 AS bun-source
FROM node:22-slim AS node-source
FROM golang:1.24.1 AS go-source

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dev tools and language runtimes
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    ca-certificates git curl wget jq vim zsh openssh-client gpg unzip \
    build-essential \
    # Python
    python3 python3-pip python3-venv \
    # Sandboxing: bubblewrap for defense-in-depth in runc mode.
    # Not used when CONTAINER_RUNTIME=runsc (gVisor handles isolation at the syscall boundary).
    # Remove once runc mode is deprecated.
    bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Rename the built-in ubuntu user (UID 1000) to mercury
# Ubuntu 24.04 ships with an 'ubuntu' user at UID/GID 1000; useradd -u 1000 fails with exit code 4
RUN usermod -l mercury -d /home/mercury -m ubuntu && groupmod -n mercury ubuntu

# Copy Bun from official image
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-source /usr/local/bin/bunx /usr/local/bin/bunx

# Copy Node.js from official image (avoids flaky nodesource apt repository)
# npm/npx are symlinks in the upstream image; Docker COPY dereferences single-file
# symlinks, so recreate them with ln -s after copying node_modules.
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-source /usr/local/include/node /usr/local/include/node
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV HOME="/home/mercury"
ENV BUN_INSTALL="/home/mercury/.bun"
ENV PATH="$BUN_INSTALL/bin:/usr/local/bin:$PATH"

# Copy Go from official image (avoids curl installer and network flakiness)
COPY --from=go-source /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:$PATH"

# Install Playwright + Chromium (used by multiple extensions: web-browser, diagrams, charts)
# HOME=/home/mercury causes playwright to install browsers to /home/mercury/.cache/ms-playwright
RUN npx playwright install --with-deps chromium

# Point puppeteer to Playwright's Chromium so npm packages skip downloading their own
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN ln -sf $(find /home/mercury/.cache/ms-playwright -name chrome -type f | head -1) /usr/local/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium

# Allow Chromium to run without sandbox in Docker (required for non-root too)
RUN echo '{"args":["--no-sandbox"]}' > /home/mercury/.puppeteerrc.json
ENV CHROMIUM_FLAGS="--no-sandbox"

# Install CLIs
RUN bun add -g @mariozechner/pi-coding-agent@^0.67.2

WORKDIR /app

COPY container/agent-package.json /app/package.json
RUN bun install --production

# Patch pi: skip thinkingConfig for Gemma models (Google API rejects thinkingBudget for them,
# but pi marks gemma-4 as reasoning:true and sends thinkingBudget:0 to disable it)
RUN node <<'EOF'
const fs = require('fs'), path = require('path');
function patch(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).isDirectory()) patch(p);
        else if (f === 'google.js' && p.includes('@mariozechner/pi-ai')) {
          let c = fs.readFileSync(p, 'utf8');
          const noThinking = '&& !model.id.startsWith("gemma")';
          const p1 = 'if (options.thinking?.enabled && model.reasoning) {';
          const p2 = 'else if (model.reasoning && options.thinking && !options.thinking.enabled) {';
          if (!c.includes(noThinking)) {
            c = c.replace(p1, 'if (options.thinking?.enabled && model.reasoning ' + noThinking + ') {');
            c = c.replace(p2, 'else if (model.reasoning && options.thinking && !options.thinking.enabled ' + noThinking + ') {');
            fs.writeFileSync(p, c);
            console.log('Patched:', p);
          }
        }
      } catch(e) {}
    }
  } catch(e) {}
}
patch('/home/mercury/.bun');
patch('/app/node_modules');
EOF

COPY src/agent/container-entry.ts /app/src/agent/container-entry.ts
COPY src/agent/model-capabilities-core.ts /app/src/agent/model-capabilities-core.ts
COPY src/agent/pi-failure-class.ts /app/src/agent/pi-failure-class.ts
COPY src/agent/pi-jsonl-parser.ts /app/src/agent/pi-jsonl-parser.ts
COPY src/agent/preferences-prompt.ts /app/src/agent/preferences-prompt.ts
COPY src/cli/mrctl.ts /app/src/cli/mrctl.ts
COPY src/cli/mrctl-http.ts /app/src/cli/mrctl-http.ts
COPY src/extensions/reserved.ts /app/src/extensions/reserved.ts
COPY src/extensions/permission-guard.ts /app/src/extensions/permission-guard.ts
COPY src/types.ts /app/src/types.ts
COPY resources/ /app/resources/
COPY examples/extensions/ /tmp/examples-extensions/
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      ext=$(echo "$ext" | xargs); \
      [ -z "$ext" ] && continue; \
      cp -r "/tmp/examples-extensions/$ext" "/app/resources/extensions/$ext"; \
    done < /app/resources/builtin-extensions.txt && \
    rm -rf /tmp/examples-extensions/

RUN echo '#!/bin/sh\nbun run /app/src/cli/mrctl.ts "$@"' > /usr/local/bin/mrctl && \
    chmod +x /usr/local/bin/mrctl

# Fix ownership of all mercury home dir artifacts before switching user
RUN chown -R mercury:mercury /home/mercury

USER mercury

ENTRYPOINT ["bun", "run", "/app/src/agent/container-entry.ts"]
