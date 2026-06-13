# @cortexkit/antigravity-auth-core

Harness-agnostic core for Google Antigravity OAuth. Shared by the OpenCode
plugin ([`@cortexkit/opencode-antigravity-auth`](../opencode)) and the pi
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

This package is an implementation detail of the harness packages and has no
stable public API contract of its own.

## License

MIT
