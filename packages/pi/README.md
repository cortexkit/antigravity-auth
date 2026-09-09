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
/login google-antigravity
```

A browser URL is shown. Complete the Google OAuth flow and paste the resulting
callback URL (or authorization code) back into the prompt.

Repeat `/login google-antigravity` (or `/agy-add`) and choose a different Google
account to add agy2, agy3, and so on. Login upserts by email, then refresh token;
re-authenticating an existing account updates its credentials without replacing
the pool or changing an operator's disabled flag. `/agy-add` invokes the same
registered OAuth flow through Pi's auth storage.

## Account controls

| Command | Effect |
| --- | --- |
| `/agy-accounts` | List agy1-based indexes, partially redacted email, enabled state, process-local health, cooldown, last selected account, and cached quota. |
| `/agy-add` | Start OAuth to add or re-authenticate an account. |
| `/agy-quota` | Display cached quota for every account, including stale/unknown state. |
| `/agy-quota refresh` | Refresh enabled accounts through core's quota manager; report failures while retaining cached values. |
| `/agy-strategy` | Show strategy and PID-offset setting. |
| `/agy-strategy sticky` | Keep using an eligible account until it becomes unavailable. |
| `/agy-strategy hybrid` | Use core health, token-bucket, freshness/LRU scoring and stickiness (default). |
| `/agy-strategy round-robin` | Rotate eligible accounts on each request, including tool continuations. |
| `/agy-disable agy2` | Disable an account without deleting its credentials (`2` also works). |
| `/agy-enable agy2` | Re-enable an account. Existing upstream eligibility/verification blocks must be resolved first. |

Pi uses the existing core AccountManager and v4 storage. Current quota groups
are `gemini` (Flash/Pro) and `non-gemini` (Claude/GPT-OSS). With multiple enabled
accounts, core skips accounts at 80% usage while their quota cache is fresh.
Quota is refreshed on demand before requests when missing or 30 minutes old;
the cache expires after 60 minutes. Failed refreshes use core's bounded backoff.
Core's single-enabled-account exception and stale/unknown-cache fail-open
behavior are preserved. Disabled accounts are never selected.

HTTP 429, 500, 503 and 529 responses before streaming use core classification,
RetryInfo/Retry-After parsing and cooldowns, then try another eligible account.
Each credential is attempted at most once per request, with one extra selection
to tolerate a concurrent token rotation. All-unavailable pools return an error
without waiting/spinning. Non-retryable HTTP errors, ambiguous transport failures,
and streams that have already emitted content are not replayed. Pi retains its
existing Antigravity transport; Gemini CLI header fallback, OpenCode killswitch
controls, and image-output routes are not enabled by this integration.

## Models

The extension registers the Antigravity model catalog under the
`google-antigravity` provider, including:

- `antigravity-gemini-3.8-flash`
- `antigravity-gemini-3.7-flash`
- `antigravity-gemini-3.6-flash`
- `antigravity-gemini-3.5-flash`
- `antigravity-gemini-3.1-pro`
- `antigravity-claude-sonnet-4-6-thinking`
- `antigravity-claude-opus-4-6-thinking`
- `antigravity-gpt-oss-120b-medium`

The image-generation model is currently OpenCode-only because Pi's provider event
protocol does not expose image-output stream events.

Select a model with `/model` or `pi -m google-antigravity/antigravity-gemini-3.8-flash`.

## Configuration

| Environment variable | Description |
| --- | --- |
| `PI_AGENT_DIR` | Override the pi agent directory (default `~/.pi/agent`). |
| `PI_ANTIGRAVITY_AUTH_FILE` | Override the account storage file path. |

The pool defaults to `~/.pi/agent/antigravity-accounts.json`, or
`$PI_AGENT_DIR/antigravity-accounts.json`. A small JSON settings file lives at
`<account-file>.config.json` (so the auth-file override also relocates settings):

```json
{
  "account_selection_strategy": "hybrid",
  "pid_offset_enabled": true
}
```

Missing settings use these defaults. `/agy-strategy` persists only the strategy;
edit the JSON file to configure PID offset. Invalid settings fail closed. Pi
does not load OpenCode's host configuration. Restart Pi after changing PID offset
to observe a new initial assignment.

PID offset seeds core's selection once per model family using PID modulo pool
size, for all three strategies. It spreads independent workers' starting points;
it is not an exclusive reservation, and different PIDs can have the same offset.
Routing cursors, health and token-bucket scores are process-local, as in core;
credentials, quota and cooldowns survive restarts. `/agy-accounts` marks the last
account dispatched by the current process, not a global cross-process selection.

### Migration, concurrency and security

Existing Pi `auth.json` remains host-managed. At session start (or first use of a
host credential), the extension imports that single credential into a missing or
empty v4 pool. It never overwrites a nonempty pool with stale host auth and never
deletes the old credential. A malformed/unsupported pool is left intact and core
attempts a protected `.corrupt-*` backup; repair the original file before retrying.
Core also handles its existing v1–v3 account-file migrations.
Legacy credentials without an email can only be matched by refresh token. If
Google issues a different token on re-login, that unidentifiable legacy entry
may remain separately; disable it after confirming the new account works.

All pool updates use core's renewable fenced lock and atomic `0600` writes.
Credential refresh holds that lock so two processes cannot overwrite a rotated
refresh token with stale data. Access tokens are cached only in process memory
by this extension (Pi still maintains its own host credential). Long refreshes
can cause another process to exhaust core's bounded lock-wait budget; retry the
request if storage is busy.

Each selection reloads durable state while retaining local routing state.
Cooldown writes patch the current token's record and retain the longest deadline;
they do not overwrite enable flags, concurrent additions, or newer credentials.
An already dispatched request may finish after an account is disabled; the next
selection sees the new flag. Quota in-flight deduplication is per process, so
concurrent workers can still perform duplicate quota probes.

Both `auth.json` and the account pool contain sensitive tokens. Keep them private,
including backups; never attach them to bug reports. Account/quota commands omit
tokens, project IDs, fingerprints and arbitrary account labels. The unofficial
authentication warning above applies to every account added to the pool.

## Manual smoke test

Build this checkout with `bun install --frozen-lockfile && bun run build`.
To load the local build without installing a release, from the repository root:

```bash
pi -e ./packages/pi/dist/index.js
```

Use an otherwise unconfigured Pi extension list to avoid loading the released
and local versions together. In Pi:

```text
/login google-antigravity
/login google-antigravity
/login google-antigravity
/agy-accounts
/agy-quota refresh
/agy-strategy round-robin
```

Choose a different Google account for each login. For the exact sequence below,
set `pid_offset_enabled` to `false` in `<account-file>.config.json` and restart Pi.
Keep `account_selection_strategy` set to `round-robin`. With all three accounts
eligible, send four simple prompts with no tool calls, running `/agy-accounts`
after each: the selected markers should be agy1, agy2, agy3, agy1. With PID offset
enabled the same cycle can start at another account. Tool calls are additional
requests and also advance round-robin.

```text
/agy-strategy hybrid
/agy-disable agy1
/agy-accounts
```

Send another prompt; agy1 must be bypassed. Re-enable with `/agy-enable agy1`.
Refresh quota and, if an account is naturally exhausted or cooling down, confirm
that hybrid selects an eligible peer. Do not deliberately exhaust a live account;
the automated tests inject exhausted quota and HTTP rate limits deterministically.

For parallel verification, set PID offset back to `true`, start three terminals
with the same `PI_AGENT_DIR`/`PI_ANTIGRAVITY_AUTH_FILE` and the local extension,
then inspect `/agy-accounts` after requests. Disable an account in one terminal;
subsequent requests in the others must bypass it. PID collisions are possible;
this test checks shared durable state and offset behavior, not exclusive leases.

## Notes

This package shares its transport, OAuth, fingerprint, and request-transform
logic with the OpenCode plugin via
[`@cortexkit/antigravity-auth-core`](../core), including multi-account storage,
selection and quota routing. Pi's existing models and streaming event protocol
remain unchanged.

## License

MIT
