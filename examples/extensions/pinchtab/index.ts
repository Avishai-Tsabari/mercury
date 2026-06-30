export default function (mercury: {
  cli(opts: { name: string; install: string }): void;
  skill(relativePath: string): void;
  permission(opts: { defaultRoles: string[] }): void;
  /** biome-ignore lint/suspicious/noExplicitAny: minimal stub matching MercuryExtensionAPI subset */
  on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
}) {
  mercury.cli({
    name: "pinchtab",
    install:
      'npm install -g pinchtab@0.13.2 playwright && npx playwright install --with-deps chromium && CHROMIUM=$(NODE_PATH="$(npm root -g)" node -e "try{process.stdout.write(require(\'playwright\').chromium.executablePath())}catch(e){}" 2>/dev/null) && { test -x "$CHROMIUM" || CHROMIUM=$(find /home/mercury/.cache/ms-playwright -type f -path \'*/chrome-linux/chrome\' ! -path \'*headless_shell*\' 2>/dev/null | head -1); } && test -n "$CHROMIUM" && test -x "$CHROMIUM" && ln -sf "$CHROMIUM" /usr/local/bin/chromium && ln -sf "$CHROMIUM" /usr/bin/chromium && rm -rf /var/lib/apt/lists/*',
  });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");

  // Chrome needs --no-sandbox when running inside Docker (no user namespace for sandboxing).
  // Also inject search engine preference and authenticated-session support into system prompt.
  mercury.on("before_container", async () => {
    // Bash ${...} must be escaped as \${...} so this TS template is valid.
    const pinchtabEnsure = `pinchtab_ensure() {
  local bind="\${BRIDGE_BIND:-127.0.0.1}"
  local port="\${BRIDGE_PORT:-9867}"
  local log="\${PINCHTAB_LOG:-/tmp/pinchtab.log}"
  local max_wait="\${1:-120}"
  mkdir -p "$(dirname "$log")" 2>/dev/null || true
  : >"$log"
  if [ ! -x "\${CHROME_BINARY:-}" ]; then
    for _c in /usr/local/bin/chromium /usr/bin/chromium; do
      if [ -x "$_c" ]; then export CHROME_BINARY="$_c"; break; fi
    done
  fi
  if [ ! -x "\${CHROME_BINARY:-}" ]; then
    echo "No executable Chromium (CHROME_BINARY=\${CHROME_BINARY:-}; tried /usr/local/bin/chromium, /usr/bin/chromium). Rebuild mercury-agent-ext (restart Mercury)." | tee -a "$log"
    return 1
  fi
  _pinchtab_port_open() { (echo >/dev/tcp/$bind/$port) 2>/dev/null; }
  if command -v pinchtab >/dev/null 2>&1 && _pinchtab_port_open; then
    return 0
  fi
  pkill -f '[p]inchtab' 2>/dev/null || true
  nohup pinchtab >>"$log" 2>&1 &
  local pid=$!
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "pinchtab exited immediately (pid $pid). Log:" >&2
    tail -120 "$log" >&2
    return 1
  fi
  local i=0
  while [ "$i" -lt "$max_wait" ]; do
    if _pinchtab_port_open; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "pinchtab died during startup. Log:" >&2
      tail -120 "$log" >&2
      return 1
    fi
    sleep 1
    i=$((i+1))
  done
  echo "pinchtab did not listen on $bind:$port within \${max_wait}s. Log:" >&2
  tail -120 "$log" >&2
  return 1
}`;

    let sessionFunctions = "";
    let navExampleCommand = 'pinchtab nav "https://search.brave.com/search?q=your+query+here"';
    let sessionPromptFragment = "";

    if (process.env.MERCURY_BROWSER_SESSIONS) {
      // Node.js injection script — pure ES5-style, no backticks or ${} so no TS escaping needed.
      // Reads MERCURY_BROWSER_SESSIONS from env, looks up the domain, injects cookies +
      // localStorage via the pinchtab HTTP bridge, then reloads. Exits 0 on success (session
      // found and injected), 1 if no session for this domain, 2 on unexpected error.
      const nodeInjectScript = `var url = process.argv[2];
if (!url) process.exit(1);
var raw = process.env.MERCURY_BROWSER_SESSIONS;
if (!raw) process.exit(1);
var sessions;
try { sessions = JSON.parse(Buffer.from(raw, "base64").toString()); } catch (e) { process.exit(1); }
var hostname = (new URL(url)).hostname;
var parts = hostname.split(".");
var multiPartTld = /\.(co|com|org|net|gov|ac|edu|or|ne|gr|gen|plc|ltd|me)\.[a-z]{2}$/i;
var domain = parts.length <= 2 ? hostname : (multiPartTld.test(hostname) ? parts.slice(-3).join(".") : parts.slice(-2).join("."));
var b64 = sessions[domain];
if (!b64) process.exit(1);
var state;
try { state = JSON.parse(Buffer.from(b64, "base64").toString()); } catch (e) { process.exit(1); }
var bind = process.env.BRIDGE_BIND || "127.0.0.1";
var port = process.env.BRIDGE_PORT || "9867";
var bridge = "http://" + bind + ":" + port;
Promise.resolve()
  .then(function () {
    return fetch(bridge + "/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url }),
    });
  })
  .then(function () {
    if (!state.cookies || !state.cookies.length) return;
    return fetch(bridge + "/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url, cookies: state.cookies }),
    }).catch(function () {});
  })
  .then(function () {
    var origins = state.origins || [];
    return origins.reduce(function (p, o) {
      return p.then(function () {
        if (!o.localStorage || !o.localStorage.length) return;
        var script =
          "(function(){" +
          o.localStorage
            .map(function (i) {
              return "localStorage.setItem(" + JSON.stringify(i.name) + "," + JSON.stringify(i.value) + ")";
            })
            .join(";") +
          "})()";
        return fetch(bridge + "/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expression: script }),
        }).catch(function () {});
      });
    }, Promise.resolve());
  })
  .then(function () {
    return fetch(bridge + "/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "window.location.reload()" }),
    }).catch(function () {});
  })
  .then(function () {
    process.exit(0);
  })
  .catch(function (e) {
    console.error(e.message);
    process.exit(2);
  });`;

      // Single-quoted heredoc (<< 'JSSCRIPT') so the JS code is written verbatim.
      // JSSCRIPT terminator must stay at column 0 — do not indent it.
      sessionFunctions = `
_pinchtab_write_inject() {
  cat > /tmp/_pinchtab_inject.js << 'JSSCRIPT'
${nodeInjectScript}
JSSCRIPT
}

pinchtab_nav() {
  local url="$1"
  pinchtab_ensure || return 1
  if [ ! -f /tmp/_pinchtab_inject.js ]; then
    _pinchtab_write_inject
  fi
  if node /tmp/_pinchtab_inject.js "$url" 2>/dev/null; then
    return 0
  fi
  pinchtab nav "$url"
}`;

      navExampleCommand = 'pinchtab_nav "https://search.brave.com/search?q=your+query+here"';
      sessionPromptFragment =
        "\n\nAuthenticated browser sessions are available. Use `pinchtab_nav <url>` instead of `pinchtab nav <url>` for all navigations — it automatically injects the saved session (cookies + localStorage) before navigation when one is available for the domain. If after navigating you land on a login or authentication page (session expired), tell the user their session has expired.";
      if (process.env.MERCURY_CONSOLE_URL) {
        sessionPromptFragment += ` Include a re-authentication link: ${process.env.MERCURY_CONSOLE_URL}/dashboard/browser-sessions?recapture=<eTLD+1-of-the-site> (e.g. for chase.com: ${process.env.MERCURY_CONSOLE_URL}/dashboard/browser-sessions?recapture=chase.com). Never attempt to enter credentials on the user's behalf.`;
      }
    }

    return {
      env: {
        CHROME_BINARY: "/usr/local/bin/chromium",
        CHROME_FLAGS: "--no-sandbox --disable-dev-shm-usage",
        // container-runner strips MERCURY_ prefix on passthrough, so the inner
        // container only gets BROWSER_SESSIONS. The inject script reads
        // MERCURY_BROWSER_SESSIONS, so re-add it explicitly via extraEnv
        // (extraEnv keys are passed verbatim, not stripped).
        ...(process.env.MERCURY_BROWSER_SESSIONS
          ? { MERCURY_BROWSER_SESSIONS: process.env.MERCURY_BROWSER_SESSIONS }
          : {}),
      },
      systemPrompt: `When searching the web, always use Brave Search. Never use Google.

Before any pinchtab CLI use in Docker, define and run:

\`\`\`bash
${pinchtabEnsure}${sessionFunctions}
pinchtab_ensure || exit 1
${navExampleCommand}
sleep 3
pinchtab text
\`\`\`${sessionPromptFragment}`,
    };
  });
}
