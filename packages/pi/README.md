# @cortexkit/pi-antigravity-auth

Google Antigravity OAuth extension for [pi](https://github.com/earendil-works/pi-mono).
Authenticate with your Google account and use Gemini 3 models through
Antigravity's endpoints.

> [!CAUTION]
> Using this extension violates Google's Terms of Service. Accounts may be
> suspended or banned. This is an unofficial tool not endorsed by Google.

## Install

```bash
pi install npm:@cortexkit/pi-antigravity-auth
```

## Login

```
/login google
```

A browser URL is shown. Complete the Google OAuth flow and paste the resulting
callback URL (or authorization code) back into the prompt.

The extension replaces Pi's built-in `google` catalog with Antigravity models.
Use Antigravity OAuth for this provider, not a Google AI Studio API key. If upgrading
from the old provider ID, change model selections to `google/antigravity-…` and
run `/login google`. Credentials saved under `google-antigravity` are not migrated
to `google` automatically.

Use `/antigravity` to request vault access and select a vault account. Local and
vault modes use the same `google/antigravity-…` model IDs. After the operator
approves access, the extension backs up Pi's native Google login and temporarily
replaces its slot with a non-secret marker before the first model request.
Requests then use only vault credentials; an empty or unreachable vault does not
fall back to the local login. Disconnecting vault enrollment attempts to restore
the saved Google login only when the native slot still matches the non-secret
marker installed for that enrollment.
If another process changed the slot, the extension keeps the backup and refuses
to overwrite that change; re-login may be needed. This is not a promise to restore
every native auth record when changing plugin versions.

## Models

The extension registers the Antigravity model catalog under the
`google` provider, including:

- `antigravity-gemini-3.8-flash`
- `antigravity-gemini-4-argon`
- `antigravity-claude-sonnet-5-5`
- `antigravity-claude-opus-5-5`

Claude 5.5 supports low, medium and high effort, a 1,000,000-token context and
128,000-token output limit. Retired Claude 4.6 requests refuse before credential
acquisition or transport; they are not redirected to 5.5.
Gemini 3.1 Pro, Gemini 3.5/3.6/3.7 Flash and `gemini-pro-agent` were withdrawn by
Antigravity. Their grouped and native tier selectors also refuse before
credential acquisition or transport, without aliases; history stays readable.

Gemini 4 Argon requires **Google AI Ultra** and supports low, medium and high
effort (medium by default), with 1,048,576 context and 65,536 output tokens.
It uses Antigravity only. Argon's per-model remaining quota and reset time are
reported separately because the redacted quota summary does not identify an
Argon weekly shared-quota bucket; weekly pool attribution remains unverified.
- `antigravity-gpt-oss-120b-medium`

The image-generation model is currently OpenCode-only because Pi's provider event
protocol does not expose image-output stream events.

Select a model with `/model` or `pi -m google/antigravity-gemini-3.8-flash`.

## Configuration

| Environment variable | Description |
| --- | --- |
| `PI_AGENT_DIR` | Override the pi agent directory (default `~/.pi/agent`). |
| `PI_ANTIGRAVITY_AUTH_FILE` | Relocate the base path used to place `antigravity-auth-vault/` beside it; does not relocate Pi's native `auth.json` Google slot or create an OpenCode pool. |

## Notes

This package shares its transport, OAuth, fingerprint, and request-transform
logic with the unified OpenCode V1/GA plugin via
[`@cortexkit/antigravity-auth-core`](../core). Local mode uses one account in Pi's
native `google` OAuth slot (`auth.json` in Pi's agent directory). Vault mode can
list/select approved vault accounts, but serves one at a time; Pi has no local
pool rotation, recorded quota gating, killswitch, or operator settings.

### Major upgrades and downgrade

Pi's native auth file is **not** the legacy OpenCode pool. Pi-only users must not
run `antigravity-auth migrate` or `rollback` against it. When upgrading from the
old `google-antigravity` provider, update model IDs to `google/antigravity-…` and
run `/login google`: credentials in the `google-antigravity` auth slot are not
automatically moved or overwritten.

Before changing builds while enrolled in a vault, disconnect via `/antigravity` →
Vault in the currently installed extension, then re-login if safe native-slot
restoration is not possible. An older build may expect a different provider slot;
do not copy tokens between slots or assume disconnect restores all native records.
If you also use an OpenCode legacy pool, follow its separate
[offline migration/rollback guide](../../README.md#major-upgrades-migration-and-rollback).
The provider and custody behavior is implemented in [`src/index.ts`](src/index.ts)
and [`src/vault-setup.ts`](src/vault-setup.ts).

## License

MIT
