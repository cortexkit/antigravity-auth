# @cortexkit/pi-antigravity-auth

> [!CAUTION]
> **Using this extension can get your Google account suspended.** Using it
> violates Google's Terms of Service. Since mid-November 2026, users report
> that Google is suspending whole Google accounts for Antigravity use through
> third-party tools, with `403 PERMISSION_DENIED` / `TOS_VIOLATION`; the
> suspension also blocks Google's own Antigravity CLI
> ([#74](https://github.com/cortexkit/antigravity-auth/issues/74)). Don't use an
> account you can't afford to lose. This is an unofficial tool not endorsed by
> Google.

Google Antigravity OAuth extension for [pi](https://github.com/earendil-works/pi-mono).
Authenticate with your Google account and use Gemini 3 models through
Antigravity's endpoints.

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
approves access, the extension replaces Pi's native Google login with a
non-secret marker before the first model request. No local login is saved.
Requests then use only vault credentials; an empty or unreachable vault does not
fall back to a local login. Disconnecting vault enrollment removes that marker;
sign in to Google again with `/login google` to use local mode. If another
process has replaced the marker with a login, the extension leaves it unchanged.
Legacy saved-login files from older builds are deleted without reading them when
entering or leaving vault mode.

### Inside Thalamus

Thalamus provides Pi's vault accounts. No `setup --claustrum` is needed; setup
and Pi's vault connection action refuse because Thalamus owns the connection.
The `/antigravity` Vault section shows **Served by Thalamus**, without Connect or
Disconnect. Pi discards its native Google login and puts the non-secret vault
marker in Pi's `google` slot in `auth.json`, while holding that file's lock.
When Pi later runs outside Thalamus, it removes that marker, just as when
disconnecting an enrolled vault. Sign in again with `/login google` for local
mode. An entry that no longer matches the marker is left unchanged.

## Models

The extension registers the Antigravity model catalog under the
`google` provider, including:

- `antigravity-gemini-3.8-flash`
- `antigravity-gemini-4-argon`
- `antigravity-gemini-4-carbon`
- `antigravity-gemini-4-hydrogen`
- `antigravity-gemini-4-neon`
- `antigravity-claude-sonnet-5-5`
- `antigravity-claude-opus-5-5`
- `antigravity-gpt-oss-120b-medium`

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

Gemini 4 Carbon supports low, medium and high effort (medium by default), with
1,048,576 context and 262,144 output tokens. Its native CLI 1.5.5 Low capture
uses an uppercase thinking level without a thinking budget or `toolConfig`;
Medium/High follow Argon's tier mapping and are inferred, not captured.
Carbon counts against the ordinary Gemini pool until a Carbon quota bucket is observed.

Gemini 4 Hydrogen requires Pro or Ultra in Google Antigravity and supports low,
medium, high (default) and xhigh effort, with 1,048,576 context and 262,144 output
tokens. Pi preserves Hydrogen's xhigh instead of clamping it to high. Native CLI
1.5.5 sends Low as `"LOW"` and XHigh as the JSON number `100`; Medium and High
follow Carbon's `"MEDIUM"`/`"HIGH"`. A live probe on 13 November saw all four
levels accepted, each thinking longer than the one below. The server does not
name the level it served, so thinking depth is the evidence. Hydrogen uses the
ordinary Gemini quota pool; no Hydrogen-specific allowance has been observed.

Gemini 4 Neon supports low, medium, high (default) and xhigh effort, with
1,048,576 context and 262,144 output tokens. Pi preserves XHigh for Neon just
as it does for Hydrogen. Neon uses the ordinary Gemini quota pool.

The image-generation model is currently OpenCode-only because Pi's provider event
protocol does not expose image-output stream events.

Select a model with `/model` or `pi -m google/antigravity-gemini-3.8-flash`.

## Configuration

| Environment variable | Description |
| --- | --- |
| `PI_AGENT_DIR` | Override the pi agent directory (default `~/.pi/agent`). |
| `PI_ANTIGRAVITY_AUTH_FILE` | Relocate the base path used to place `antigravity-auth-vault/` beside it; does not relocate Pi's native `auth.json` Google slot or create an OpenCode pool. |

## Notes

If a request or startup refusal points to the plugin log, start Pi with `ANTIGRAVITY_CORE_CONSOLE_LOG=1` to see the underlying diagnostic in its console output.

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
Vault in the currently installed extension, then sign in again with `/login google`.
An older build may expect a different provider slot; do not copy tokens between
slots or expect a saved local login to survive vault use.
If you also use an OpenCode legacy pool, follow its separate
[offline migration/rollback guide](../../README.md#major-upgrades-migration-and-rollback).
The provider and custody behavior is implemented in [`src/index.ts`](src/index.ts)
and [`src/vault-setup.ts`](src/vault-setup.ts).

## License

MIT
