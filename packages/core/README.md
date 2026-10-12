# @cortexkit/antigravity-auth-core

Harness-agnostic core for Google Antigravity OAuth. Shared by the unified OpenCode
1.x (V1) and 2.x general-availability (GA) server and TUI ([`@cortexkit/opencode-antigravity-auth`](../opencode)) and the Pi
extension ([`@cortexkit/pi-antigravity-auth`](../pi)).

Provides:

- **OAuth** — authorization, code exchange, and token refresh against Google's
  Antigravity OAuth client.
- **Transport** — a raw HTTP/1.1 transport (`fetchWithAgyCliTransport`) that
  matches the `agy` CLI's on-wire header order and framing.
- **Fingerprint** — Antigravity CLI device identity and User-Agent construction.
- **Request transforms** — Gemini/Claude request shaping, schema sanitization,
  thinking-config handling, and cross-model metadata stripping.
- **Model registry & resolver** — Antigravity model catalog plus the
  model/thinking-budget wire mappings.
- **Managed project** — `loadCodeAssist`/`onboardUser` resolution with caching.
- **Accounts and quota** — shared local account repository, selection, cooldowns,
  quota readings, and the common `/antigravity` menu used by the host adapters.
- **Store lifecycle** — explicit fresh initialization, offline legacy OpenCode
  pool migration, and current-credential rollback in
  [`src/account-migration.ts`](src/account-migration.ts).
- **Vault integration** — approved enrollment and request credentials kept
  separate from local account authority; unavailable vault custody does not
  silently fall back to local credentials.

OpenCode V1 and GA use the same local store when they resolve the same account
path. Pi local mode instead uses Pi's native `google` OAuth slot, not the OpenCode
pool; Pi vault mode selects one account approved by the vault operator at a time.
Both adapters expose models under the `google` provider.

For a major upgrade, stop every OpenCode/Antigravity process and timer before
`antigravity-auth migrate --offline`. Fresh local pools use `antigravity-auth init`.
To downgrade a migrated pool, use the **new CLI's** `rollback --offline` and wait
for success before installing an older build. Rollback exports current credentials
to legacy V4 JSON, not the original backup. See the
[upgrade guide](../../README.md#major-upgrades-migration-and-rollback) for refusal
conditions and the separate host/vault disconnect and re-login requirements.
Do not apply OpenCode pool migration to Pi's native auth file.

This package is an implementation detail of the harness packages and has no
stable public API contract of its own.

## License

MIT
