# PRD: Mercury config load (YAML + environment)

**Status:** Implemented  
**Area:** Host configuration (`loadConfig`, CLI paths)  
**Related:** [configuration.md](configuration.md) (operator reference)

---

## 1. Problem

Mercury historically put all settings in `MERCURY_*` environment variables. That mixes **secrets** (API keys, tokens) with **non-secret operational** settings (model chain, ingress toggles, port, image name, compaction). Long JSON in `.env` is hard to read and review, and example `.env` files risk leaking patterns or real keys. Operators want **committed, structured defaults** while keeping **secrets in `.env`** (or the secret store), with a clear override story.

## 2. Goals

1. Support an **optional project file** (`mercury.yaml` / `mercury.yml`) for **non-secret** settings that today flow through `loadConfig()` / Zod in `config.ts`.
2. Preserve **full backward compatibility**: existing deployments that only use env vars behave unchanged when no YAML file is present.
3. **Environment variables override** the file whenever the corresponding `MERCURY_*` key is set in `process.env` (including empty string where applicable).
4. **Never** load host secrets from YAML for the blocklisted keys (see §5).
5. **Fail fast** on invalid YAML shape (strict schema) so misconfiguration is obvious at startup.

## 3. Non-goals (explicit)

- **Soft-disable** adapters when enabled in config but tokens are missing (e.g. Telegram on, no bot token) — remains **hard error** at startup.
- Moving **extension-only** or **non–`loadConfig`** variables (e.g. `MERCURY_BRAVE_API_KEY`, `MERCURY_BRIDGE_STEALTH`) into YAML — out of scope unless added to the main config schema later.
- Changing **container passthrough** rules for `MERCURY_*`.

## 4. Functional requirements

| ID | Requirement |
|----|----------------|
| F1 | If `MERCURY_CONFIG_FILE` is unset, load `./mercury.yaml` if it exists, else `./mercury.yml`, else skip file load. |
| F2 | If `MERCURY_CONFIG_FILE` is set to a non-empty path, load that file (relative paths resolved from `process.cwd()`). |
| F3 | If `MERCURY_CONFIG_FILE` is `""` or `none` (case-insensitive), do not load any YAML file. |
| F4 | Parsed YAML must map to the same logical fields as `schema.parse` input in `config.ts` (nested YAML sections flattened in code). |
| F5 | Model chain MAY be expressed as YAML array under `model.chain` or top-level `model_chain` (max 4 legs, `{ provider, model }` per leg). |
| F6 | Model capabilities override MAY be expressed as YAML object under `model.capabilities`, equivalent to `MERCURY_MODEL_CAPABILITIES` JSON. |
| F7 | After merging file + env, `loadConfig()` returns the same `AppConfig` shape as before, including derived `resolvedModelChain`, capability resolution, and `whatsappAuthDir` defaulting. |
| F8 | `mercury init` SHOULD copy a commented `mercury.example.yaml` into the project when missing. |
| F9 | CLI paths that depend on data dir / WhatsApp auth dir (`mercury auth whatsapp`, standalone whatsapp-auth, doctor WhatsApp check) SHOULD use `loadConfig()` so YAML applies consistently. |

## 5. Security requirements

| ID | Requirement |
|----|----------------|
| S1 | Values for `apiSecret`, `chatApiKey`, and `discordGatewaySecret` MUST NOT be taken from YAML; only `process.env` after merge. |
| S2 | YAML schema MUST reject unknown top-level / section keys (strict) to avoid “hidden” config. |
| S3 | Operator docs MUST state that platform tokens and provider keys remain env-only unless explicitly added to a future schema. |

## 6. Precedence (normative)

For each mapped setting, `mergeRawMercuryConfig` applies:

1. If `process.env` **has** the corresponding `MERCURY_*` key and the retrieved value is **not** `undefined`, use env (empty string still overrides YAML).  
2. Else if the YAML file supplied a value for that setting, use file.  
3. Else omit and let Zod defaults in `config.ts` apply.

*(See `mergeRawMercuryConfig` and `CAMEL_TO_ENV` in `src/config-file.ts`.)*

## 7. Success criteria

- With no YAML file and unchanged env, behavior matches pre-feature Mercury.
- With YAML only (env keys unset for those fields), `loadConfig()` reflects YAML values.
- With both YAML and env set for the same field, env wins.
- Invalid YAML or invalid model chain produces a clear error including the config file path.
- Unit tests disable accidental file load via `MERCURY_CONFIG_FILE=""` where appropriate.

## 8. Implementation map

| Component | Location |
|-----------|----------|
| YAML parse, Zod file schema, flatten, merge | `src/config-file.ts` |
| Shared model-leg validation | `src/config-model-chain.ts` |
| `loadConfig`, Zod app schema | `src/config.ts` |
| Tests | `tests/config.test.ts` (+ guards in `router.test.ts`, `session-context-estimate.test.ts`) |
| Template | `resources/templates/mercury.example.yaml` |
| Operator guide | `docs/configuration.md` |

## 9. Revision history

| Date | Change |
|------|--------|
| 2026-03-20 | Initial PRD (post-implementation documentation of YAML + env merge). |
