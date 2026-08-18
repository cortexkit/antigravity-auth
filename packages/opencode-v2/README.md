# opencode-v2-antigravity

Google Antigravity provider for **OpenCode 2.x**, built on
[`@cortexkit/antigravity-auth-core`](https://www.npmjs.com/package/@cortexkit/antigravity-auth-core).

`@cortexkit/opencode-antigravity-auth` targets the OpenCode 1.x host
(`engines.opencode: ">=1.17.13 <2"`): it patches `fetch()` and registers a TUI sidebar.
OpenCode 2.x replaced that surface with a typed plugin API (`session.hook`,
`integration.transform`, `tool.transform`, native provider packages), so the 1.x plugin cannot
load there. This package is that missing host adapter — OAuth, transport, account pool, quota
bookkeeping and the model registry all stay in the shared core.

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

## Install

Install the adapter package itself (the shared core is pulled in automatically):

```bash
# once the package is published:
npm install @cortexkit/opencode-v2-antigravity-auth
# or from this repository (Bun workspace):
bun install
```

The plugin entry is `src/plugin.mjs` inside the package. In `opencode.json`, point
`plugins[].package` at that file — for an npm install use
`node_modules/@cortexkit/opencode-v2-antigravity-auth/src/plugin.mjs` relative to the project,
for a checkout use the absolute path
`/path/to/antigravity-auth/packages/opencode-v2/src/plugin.mjs`. The example below uses a
checkout path.

Register the plugin and the models in `opencode.json` (full snippet in
[`example/opencode.json`](example/opencode.json)):

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/antigravity-auth/packages/opencode-v2/src/plugin.mjs",
      "options": {
        // Optional: restrict which directories antigravity_read_document may read.
        // Default: anything under the user's home directory (credential/secret
        // paths are always blocked).
        "readDocumentRoots": ["/absolute/path/to/project/docs"]
      }
    }
  ],
  "providers": {
    "google": {
      "models": {
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash",
          "modelID": "gemini-3.7-flash",
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

## Accounts

- Pool file: `antigravity-accounts.json` in the OpenCode config dir
  (`$OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode`, `%APPDATA%\opencode`, or
  `~/.config/opencode`); override with `ANTIGRAVITY_ACCOUNTS_FILE`. Storage schema v4 with the
  core's fenced file lock, so the pool is shared with the 1.x plugin and the standalone CLI.
- Add an account: connect the `google` integration and pick
  **"Google Antigravity (add account)"**. Each login appends to the pool; existing accounts are
  preserved. The callback listens on `127.0.0.1:51121/oauth-callback`.
- Disable an account with `"enabled": false`.
- Selection uses the core `hybrid` strategy. On `429`/`403` the account is cooled down and the
  next one is tried, `401` forces a token refresh, and a bare `STOP` (empty candidates) is
  retried up to three times.

## Models

| Selector | Variants | Wire model |
| --- | --- | --- |
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
4. **PDF attachments** — the OpenCode 2.x CLI drops PDF attachments before the provider sees
   them (the request arrives without any `inlineData`). The plugin therefore also registers an
   `antigravity_read_document` tool that loads the file itself:
   `antigravity_read_document({ path, question?, model? })` for `.pdf`, `.png`, `.jpg`, `.webp`,
   `.gif`, `.heic`. Images attached in chat work without the tool.
   **Security note:** the tool reads local files and sends them to the Antigravity server —
   an untrusted PDF/image is a prompt-injection vector that could instruct the model to read
   sensitive files. Paths are therefore checked: well-known credential/secret locations
   (`~/.ssh`, `~/.config`, `~/.local`, `AppData`, `.env`, `*.key`, `*.pem`, `*.p12`, `*.pfx`,
   `id_rsa`, `credentials`, `auth.json`, `antigravity-accounts.json`, …) are always refused,
   and by default only files under the user's home directory are readable. To narrow the
   readable root further, set the `readDocumentRoots` plugin option (array of absolute
   directories). Prefer attaching documents in chat where the host preserves them.
5. **Image output** — the native parser renders text and tool calls only, so generated images
   are written to `<data dir>/antigravity-images/` and announced as text.

## Logging and privacy

`<state dir>/antigravity-v2.log` records routing, `#<account index>`, upstream status codes,
rotation and saved image paths. No prompts, tokens, e-mail addresses or refresh tokens are
written. Credentials live only in the pool file owned by the core.

## Verified

Windows 11, Node 24, OpenCode `0.0.0-beta-17595`, two-account pool:

- all eight selectors above answered a live prompt, including every reasoning tier;
- tool calling works end to end (the model called `read` and returned a directory listing);
- PNG attachment recognised (a red square → "Red");
- PDF read through `antigravity_read_document` (exact embedded string returned);
- image generation produced two JPEG files on disk;
- forced failover: disabling account `#0` routed the next request to account `#1`.

## License

MIT.
