# opencode-v2-antigravity

Google Antigravity provider for **OpenCode 2.x**, built on
[`@cortexkit/antigravity-auth-core`](https://www.npmjs.com/package/@cortexkit/antigravity-auth-core).

`@cortexkit/opencode-antigravity-auth` targets the OpenCode 1.x host
(`engines.opencode: ">=1.17.13 <2"`): it patches `fetch()` and registers a TUI sidebar.
OpenCode 2.x replaced that surface with a typed plugin API (`session.hook`,
`integration.transform`, `tool.transform`, native provider packages), so the 1.x plugin cannot
load there. This package is that missing host adapter — OAuth, transport, account-pool rotation,
rate-limit bookkeeping, and the model registry all stay in the shared core.

> **Terms-of-service warning.** This calls Antigravity's non-public internal API. It is not
> endorsed by Google and may violate Google's Terms of Service; accounts have reportedly been
> suspended for similar use. Use at your own risk and never with an important account.

## Design

```
OpenCode 2.x                          this plugin                    Antigravity
────────────                          ───────────                    ───────────
native @opencode-ai/ai/providers/google
  builds Gemini request  ──▶  session.hook("http.request")
                                rewrites the URL to a 127.0.0.1 loopback
                                       │
                                       ▼
                             loopback HTTP server
                                · picks an account (hybrid strategy)
                                · refreshes the OAuth token
                                · ensureProjectContext()
                                · agent envelope + labels/sessionId
                                · fetchWithAgyCliTransport()  ──▶  daily-cloudcode-pa
                                                                    (fallback cloudcode-pa)
                                       │
  parses Gemini SSE      ◀───────  unwrapped, schema-normalised SSE
```

Keeping the native `@opencode-ai/ai/providers/google` package as the codec means image, PDF and
tool-call handling comes from the host instead of a hand-written adapter.

Why a loopback server instead of returning a `Response` from the hook: OpenCode 2.x sends
whatever `event.request` the hook leaves behind through its own HTTP client, and the
`http.response` hook only runs after that request succeeded. A loopback endpoint keeps the
core's raw HTTP/1.1 transport (agy header order, proxy support) while the host still sees a
plain SSE response it can stream and cancel.

The `oc-plugin` manifest enables only the server entry. The exported `/tui` and `/rpc` modules
are inert and exist solely because OpenCode 2's cross-platform package resolver probes those
subpaths even for server-only packages; OpenCode 2 continues to render its native provider UI.

## Install

Install the adapter package itself (the shared core is pulled in automatically):

```bash
npm install @cortexkit/opencode-v2-antigravity-auth
# or from this repository (Bun workspace):
bun install
```

Register the package and the Antigravity-backed Google models in `opencode.json`.
Use the package name for an npm installation, or the absolute package directory
(`/path/to/antigravity-auth/packages/opencode-v2`) for a local checkout.
The complete model catalog is in [`example/opencode.json`](example/opencode.json).

```jsonc
{
  "plugins": ["@cortexkit/opencode-v2-antigravity-auth"],
  "providers": {
    "google": {
      "models": {
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "modelID": "gemini-3.8-flash",
          "package": "@opencode-ai/ai/providers/google",
          "capabilities": { "tools": true, "input": ["text", "image", "pdf"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65536 },
          "variants": [{ "id": "low" }, { "id": "medium" }, { "id": "high" }]
        }
      }
    }
  }
}
```

## Windows PowerShell verification

The adapter has been tested with OpenCode **2.0.18** on Windows 11 in Windows
PowerShell. The similarly named `@cortexkit/opencode-antigravity-auth@2.2.1`
package is for OpenCode 1.x; use this separate adapter for OpenCode 2.x.

For a built local checkout, register its package directory, for example:

```jsonc
{
  "plugins": ["C:/path/to/antigravity-auth/packages/opencode-v2"]
}
```

The root `server.js` forwards to the compiled entry. OpenCode's local-directory
resolver probes `server`/`index` directly rather than the npm exports map.
Build the package before loading it. With dependencies installed, the TypeScript
build can run directly in PowerShell without the Unix `rm -rf` build prefix:

```powershell
cd packages/core
npx tsc -p tsconfig.build.json
cd ../opencode-v2
npx tsc -p tsconfig.build.json
opencode run --standalone --model google/gemini-3.8-flash "Reply exactly OK"
```

OpenCode 2.0.18 uses `@opencode/ai/providers/google`; use that package path in
the model definitions. Its snake_case function declarations must be normalized
before the shared schema transform; otherwise Antigravity can reject tool
parameters such as `exclusiveMinimum` with HTTP 400 `INVALID_ARGUMENT`.

## Accounts

- Pool file: `antigravity-accounts.json` in the OpenCode config dir
  (`$OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode`, `%APPDATA%\opencode`, or
  `~/.config/opencode`); override with `ANTIGRAVITY_ACCOUNTS_FILE`. Storage schema v4 with the
  core's fenced file lock, so the pool is shared with the 1.x plugin and the standalone CLI.
- Add an account: connect the `google` integration and pick
  **"Google Antigravity (add account)"**. Each login appends to the pool; existing accounts are
  preserved. The callback listens on `127.0.0.1:51121/oauth-callback`.
- Disable an account with `"enabled": false`.
- Selection uses the core `hybrid` strategy. A `401` forces one token refresh, `429` rotates
  after recording rate-limit state, and specific `ACCOUNT_INELIGIBLE` / `VALIDATION_REQUIRED`
  responses disable the affected account before selecting another. Terminal transport and SSE
  errors propagate through OpenCode's native error path.

## Models

| Selector | Variants | Wire model |
| --- | --- | --- |
| `google/gemini-3.8-flash` | low, medium, high | `gemini-3.8-flash-{tier}` |
| `google/gemini-3.7-flash` | low, medium, high | `gemini-3.7-flash-{tier}` |
| `google/gemini-3.6-flash` | low, medium, high | `gemini-3.6-flash-{tier}` |
| `google/gemini-3.5-flash` | low, medium, high | `gemini-3.5-flash-extra-low` / `gemini-3.5-flash-low` / `gemini-3-flash-agent` |
| `google/gemini-3.1-pro` | low, high | `gemini-3.1-pro-low` / `gemini-pro-agent` |
| `google/gemini-3.1-flash-image` | — | `gemini-3.1-flash-image` |
| `google/claude-sonnet-4-6-thinking` | — | `claude-sonnet-4-6` |
| `google/claude-opus-4-6-thinking` | — | `claude-opus-4-6-thinking` |
| `google/gpt-oss-120b-medium` | — | `gpt-oss-120b-medium` |

Model ids and tiers come from `resolveModelForHeaderStyle()`, so the registry stays the single
source of truth.

## Host quirks this plugin works around

1. **GPT-OSS tool schemas** — the AGY GPT bridge re-encodes protobuf numeric constraints as
   strings, so `minLength: 1` fails OpenAI JSON-Schema validation with `400 INVALID_ARGUMENT`.
   Fixed by calling `normalizeGeminiTools(request, { moveNumericConstraintsToDescription: true })`
   for `gpt-*` wire models.
2. **Strict native event schema** — GPT-OSS opens a turn with `content` and no `parts`, and
   Claude sometimes uses role `assistant`. Both are rejected by the native Gemini event schema
   (`Invalid google/gemini stream event`), so every frame is normalised before being forwarded.
3. **Response encoding** — the core transport already inflates gzip, so upstream
   `content-encoding` headers must not be copied onto the loopback response.
4. **Image output** — image-model title requests are routed to the supported Gemini 3.5 Flash
   low tier, unsupported tools and thinking settings are removed from image-generation payloads,
   and generated images are
   written to `~/.opencode/generated-images/` with private permissions before being announced
   as text.

## Logging and privacy

`<state dir>/antigravity-v2.log` records routing, `#<account index>`, upstream status codes,
rotation and saved image paths. No prompts, tokens, e-mail addresses or refresh tokens are
written. Credentials live only in the pool file owned by the core.

## Verification

The deterministic OpenCode 2 E2E suite launches the real pinned host binary with an explicit
isolated `OPENCODE_DB` and routes requests through a loopback Antigravity server. CI and release
run the suite in Docker with container networking disabled, so no live endpoint is reachable. It
verifies:

- package entry resolution and real host hook dispatch;
- final AGY model metadata, `VALIDATED` tool mode, and user-turn termination;
- account-ineligible persistence and account rotation;
- generated-image and log file permissions;
- terminal transport, embedded SSE error, and clean-EOF propagation.

## License

MIT.
