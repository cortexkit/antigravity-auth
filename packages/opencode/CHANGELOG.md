# Changelog

## Unreleased

- In routed vault setups such as Thalamus, each completed streamed reply is now reported to routing as served. Before, a streamed Gemini reply that finished normally was never reported, because the plugin ends the stream at the reply's finish event without waiting for the server to close it.

## [3.0.42] - 2026-11-12

- In routed vault setups such as Thalamus, a request whose account routing refuses now sends nothing and ends with "Routing has no Antigravity account available for this request right now; try again later.", with routing's wait in `Retry-After`.
- Under the hood, embedded common-auth is now published 0.47.0: a lock release waits until its lock file is gone, and account routing can return a refusal when the caller opts in.

## [3.0.41] - 2026-11-12

- Settings now live in `antigravity-auth.jsonc` in the shared CortexKit config folder (`~/.config/cortexkit/` by default). The first start copies `antigravity.json` there once, leaves the old file unchanged and writes `antigravity.json.MOVED_READPLEASE` beside it. Menu changes are saved to the new file and keep its comments. An OpenCode install with its own config folder or its own vault folder keeps using `antigravity.json`.
- A project settings file (`.cortexkit/antigravity-auth.jsonc`, or the old `.opencode/antigravity.json`) now applies only `quiet_mode`, `toast_scope`, `session_recovery`, `claude_tool_hardening` and `claude_prompt_auto_caching`. Any other setting there is ignored, and `/antigravity` → Diagnostics names it.
- An invalid setting value is now skipped and its default applies, instead of the whole file being ignored or the value being clamped. Diagnostics names each skipped value.
- Per-account quota floors are now keyed by a stable account id, so they survive signing in again. A floor that can't be matched to one account isn't moved, and Diagnostics says so.
- `tool_id_recovery` and `max_backoff_seconds` are retired; the move reports them as not moved. The plugin never read either one.
- Per-account model lists are now enforced (#67): `account_models` in `antigravity-auth.jsonc` limits which models each account serves, in local and vault modes. A listed model covers its thinking tiers and aliases, an account without a list serves every model, and a request no account may serve ends with a 412 that names the setting. Set lists from `/antigravity` → Accounts → Models.
- In routed vault setups such as Thalamus, a session's first request now waits up to 2 seconds for routing's account choice, instead of 0.5 seconds, before using the plugin's own choice.
- Updated the embedded common-auth library to 0.45.0: a leftover lock temp file from a crashed process is now cleaned up the next time that lock is taken.

## [3.0.40] - 2026-11-11

### Added

- In Thalamus and other routed vault setups, antigravity-auth now reports each request's usage for billing, and logs which account source served it. On OpenCode 2, the account-source line goes to the host process's stderr.

### Changed

- Vault setup now asks for antigravity-auth's account access in the same approval, so no separate `ck auth grant` is needed with a current vault.
- Updated the embedded common-auth library to published 0.44.0 and the Claustrum client to 0.18.0.

## [3.0.39] - 2026-11-10

### Added

- Gemini 4 Carbon (Low, Medium, High) is available on OpenCode and Pi.

### Changed

- Vault approval requests from setup now show "Antigravity sign-in for OpenCode" or "Antigravity sign-in for Pi".
- Updated the embedded common-auth library to published 0.43.0 and the Claustrum client to 0.17.0.

### Fixed

- Fix the Antigravity menu not opening in OpenCode 2 after switching to a session in another folder. Polling follows the session's location and releases unused location clients. A menu command with no Antigravity window showing that session now explains why no menu appeared.

## [3.0.38] - 2026-11-08

### Added

- Add account on OpenCode 2 now also takes a pasted redirect URL, so it works over SSH. The sign-in list gains "Google (antigravity-auth pool, paste redirect URL)", which asks for the address your browser ends on and never waits for the browser to return. The side menu's Add account shows a paste box and finishes on whichever comes first: the pasted address or the browser returning.

## [3.0.37] - 2026-11-08

### Fixed

- In vault mode, a short busy refusal from the CortexKit vault service no longer drops the last good credential, so requests keep being served. The vault client libraries move to claustrum-client 0.16 and subc-client 0.24, which can report that busy state.

### Changed

- Embedded common-auth 0.42.0. Nothing else changes for antigravity-auth users.

## [3.0.36] - 2026-11-07

### Fixed

- On OpenCode 2, every action in the Antigravity side menu works again. Since 3.0.0 the server had refused all of them (Add account, Remove, Enable/Disable, the three "Use for" choices, Check quota now, the killswitch, log level and wire dump) because the menu sent an old request format. Each one now goes through the server's own menu actions, with the same labels and order.

### Changed

- On OpenCode 2, Remove asks "Remove account N? Its saved login is deleted.", the same confirmation as OpenCode 1.
- On OpenCode 2, the side menu shows the Vault section in local and vault mode, as OpenCode 1's `/antigravity` menu already does.
- In vault and Thalamus mode, the OpenCode 2 side menu hides the local account buttons that the server doesn't offer there (Add account, Remove, Enable/Disable and the three "Use for" choices).
- "Add account" on OpenCode 2 needs the browser to reach this machine. If the sign-in doesn't return within 5 minutes it stops with "Antigravity sign-in did not complete." and saves nothing. OpenCode 1 also accepts a pasted sign-in link.

## [3.0.35] - 2026-11-07

### Added

- Embedded common-auth 0.40.0: OpenCode and Pi hosts inside Thalamus use its vault accounts without plugin enrollment; outside Thalamus, vault and local-account behavior is unchanged.

## [3.0.34] - 2026-11-07

### Fixed

- On OpenCode 2, refusing a Google model that Antigravity doesn't serve now names the model and the matching Antigravity model; a refused non-model request has its own message (#65).

## [3.0.33] - 2026-11-07

### Fixed

- Embedded common-auth 0.39.1: a lock file is now created in one step, so a crash while taking a lock can no longer leave an empty lock that blocks the next start.

## [3.0.32] - 2026-11-06

### Fixed

- Pi now finishes saving vault state before a session ends or Pi exits, so a quick restart no longer refuses requests for a few seconds.

### Changed

- Embedded common-auth 0.39.0. Nothing changes for antigravity-auth users.

## [3.0.31] - 2026-11-06

### Changed

- Gemini 3.5 Flash is removed because Antigravity no longer offers it; use Gemini 3.8 Flash instead. Title requests for a model the plugin doesn't serve now go to Gemini 3.8 Flash Low.
- The refusal for a retired model now names current models: Gemini 3.8 Flash, or Claude Sonnet 5.5 or Opus 5.5.
- Embedded common-auth 0.38.0 and claustrum-client 0.15.0. Nothing changes for antigravity-auth users.

## [3.0.30] - 2026-11-03

### Fixed

- Setup for OpenCode 2 now reports the real error when the account store can't be read, and suggests reconnecting an existing pool only when that pool would actually serve a request. Thanks to @mv2sa (#62).

### Changed

- Embedded common-auth 0.34.0: on Windows, releasing a lock file the system briefly holds now retries instead of failing.

## [3.0.29] - 2026-11-02

### Fixed

- Gemini 4 Argon requests no longer try a free account that doesn't offer the model again on every request: the plugin remembers that answer for up to an hour (or until the account's quota reading changes), and tries accounts that report an Argon allowance first. (#63)

## [3.0.28] - 2026-11-02

### Changed

- On OpenCode 2 in vault mode, background quota checks now read the shared insula cache first, as OpenCode 1 does, and ask Google only when insula has no usable reading. "Check quota now" still asks Google directly.

### Fixed

- On OpenCode 2 in vault mode, the first request in a newly opened project no longer fails with "The vault roster is not available yet" while the vault is still answering; it waits for the first account list for up to 30 seconds, and stops at once if the request is cancelled. (#61)
- Retry times from Google are read the same way everywhere, so OpenCode 2 now receives a matching `Retry-After` on quota and rate-limit failures, and a failure thrown before headers keeps its real status.

## [3.0.26] - 2026-11-02

### Fixed

- OpenCode no longer refuses to open a healthy account store, or fails an OpenCode 2 reconnect, when another process saves a quota reading at the same moment.

### Changed

- A failed OpenCode 2 reconnect now logs which step failed, as a fixed code with no account data.

## [3.0.25] - 2026-11-01

### Fixed

- Waits for a pool that mixes rate-limited, cooling-down and low-quota accounts now use one estimate for the next usable account, and refusals no longer show a reset time that has already partly passed.

## [3.0.24] - 2026-11-01

### Added

- OpenCode 2 can reconnect an existing local Antigravity pool without browser consent, adding accounts, or refreshing their credentials.

### Fixed

- Request waits and soft-quota protection now use only the accounts eligible for that request, including operator and model exclusions, and honor account cooldowns.

## [3.0.23] - 2026-11-01

### Changed

- In vault mode, OpenCode now also tells a CortexKit routing service when an account's quota group is used up. A report needs both Google's "quota exhausted" refusal and a dated 0% reading for that group, and only that group is blocked.
- `OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR` sets one vault folder for several OpenCode hosts, so a runner that starts many hosts needs one approved enrollment instead of one per host.
- After a crash or power loss, an old plugin's leftover process record no longer blocks the vault or account-store move until an unrelated program with the same process number exits.

## [3.0.22] - 2026-10-31

### Added

- OpenCode vault mode can optionally ask a local CortexKit routing service which account should serve a session's first chat request and report which account served a reply. Titles, summaries and retries do not ask for routing, and requests fall back to the plugin's choice if routing does not answer in time. Pi is unchanged.

### Changed

- Quota windows without a dated reading now stay visible as greyed `no reading` rows, without a bar or percentage. Accounts with no readings keep their quota groups visible.

### Fixed

- Windows now retries brief lock-file sharing errors while waiting for an account-file lock, through common-auth 0.33.0.

## [3.0.21] - 2026-10-31

### Changed

- OpenCode 1 and 2 sidebar quota bars now fill as quota is used, while the percent-left figure stays unchanged. Narrow sidebars shrink bars before dropping reset times.
- Reading age now has its own `checked … ago` line under each account's quota windows, and group titles use the normal text colour.
- The sidebar panel now uses its full width without the blank row or side margins.
- Collapsed account rows now end with the status dot and show their quota summary complete or not at all. Stale accounts and accounts not serving the current session are greyed out.
- Quota windows without a known reading time are hidden instead of implying quota is available. Accounts without dated readings show "no quota reading yet".
- `header.label` and `header.showVersion` settings keep working, and the header never substitutes `LIMITED` for the version.

## [3.0.20] - 2026-10-30

### Changed

- The minimum OpenCode 1 version is now 1.18.4, the first release that ships the terminal UI library the sidebar is built for.
- The sidebar header always shows the plugin version; it no longer switches to LIMITED during quota backoff.

## [3.0.19] - 2026-10-28

### Changed

- Soft quota reserve is now off by default. Existing `soft_quota_threshold_percent` values are kept; set it to `80` in `antigravity.json` to retain the previous 20-percent reserve.

### Fixed

- Soft quota refusals now explain how to set `"soft_quota_threshold_percent": 100`, and quota floor refusals point to `/antigravity → Limits`.

## [3.0.18] - 2026-10-28

### Fixed

- Updating OpenCode 2 from 3.0.16 or earlier to 3.0.17 without restarting no longer breaks Antigravity. A process that ran an older plugin keeps the account store in OpenCode's config folder until restart, logs the deferral once, and moves the store on the next restart.

## [3.0.17] - 2026-10-28

### Changed

- The local account store now moves out of OpenCode's watched config folder into `~/.local/state/cortexkit/antigravity-auth/opencode/`, respecting `XDG_STATE_HOME` and using an `opencode-<16 hex digits>/` folder for other config roots. Accounts, sign-ins and quota move with it; Pi's files do not move.
- The move waits until every OpenCode using that config folder has restarted on this version, and until local accounts are active. Close every OpenCode before upgrading. If the state folder's path goes through a symbolic link, the store stays where it is; set `XDG_STATE_HOME` to the real path to resolve it.
- The old store is kept as a backup. Never delete `antigravity-accounts.json.store.pointer.json` in the config folder: older versions need it to find the moved store.
- Before downgrading to 3.0.15 or earlier, close every OpenCode and run `npx @cortexkit/opencode-antigravity-auth store relocate --back --offline` to replace the backup with current accounts. Downgrading to 3.0.16 needs no extra step.

### Fixed

- Windows vault and account files now work at paths of 260 characters or more instead of timing out on a lock.

## [3.0.16] - 2026-10-27

### Fixed

- Windows now finds stores migrated in the old `%APPDATA%\opencode` folder instead of showing no accounts or starting a second store. If both folders contain a store, the error names both and asks you to keep one.

### Changed

- This release can read a store moved by a later release, so returning to 3.0.16 after that move needs no extra step. No account store moves in this release.

## [3.0.15] - 2026-10-27

### Fixed

- OpenCode 2 now shows background vault quota readings in the sidebar with their age and last-check time instead of "no quota reading yet".
- Vault quota checks now save all accounts' readings in one write instead of one write per account.

### Changed

- The OpenCode 2 sidebar now matches OpenCode 1, using host theme colours, a versioned `▼`/`▶ ANTIGRAVITY` header, persistent click-to-collapse, Quota and Routing headings and the host's section indent, without the health line.

## [3.0.14] - 2026-10-27

### Changed

- Vault files, the signature cache and new debug logs now move out of OpenCode's watched config folder to `~/.local/state/cortexkit/antigravity-auth/opencode/`, respecting `XDG_STATE_HOME`. Vault enrollment carries over, the signature cache is rebuilt, and old logs stay where they were. The account store does not move yet.
- Close every OpenCode before upgrading: the move waits while an older plugin is running. Conflicting vault files stop account serving with an error naming both paths, never a fallback to local accounts.
- To downgrade, close every OpenCode, move vault files back to `antigravity-auth-vault/` in the config folder, and delete `layout.json` from the new folder. Until then, older versions remain in vault mode and refuse requests.
- `OPENCODE_ANTIGRAVITY_LOG_DIR` now sets the debug log folder and takes precedence over `log_dir`.

### Fixed

- Gemini now accepts nullable tool-schema types such as `["string", "null"]`, sent with `nullable: true`.
- Builds now work under folders named `antigravity`, `plugin`, `hooks` or `rpc`; the sidebar check no longer matches parent folder names.
- Windows setup no longer fails when a file lock disappears while another process waits for it.
- Empty-response errors now say "1 attempt" instead of "1 attempts".

## [3.0.13] - 2026-10-27

### Added

- Paid Pro accounts now show their separate Gemini 4 Argon weekly allowance in an Argon group. Argon account choice uses that allowance without blocking Gemini; accounts without an Argon allowance are unchanged.

### Fixed

- OpenCode 2 now replaces a stalled vault connection after 30 seconds, limits each connection attempt to ten seconds, and shares one connection per process instead of per project.
- OpenCode 2 background vault quota checks and the manual "Check quota now" action work again, following each project's background refresh setting.
- Vault grant guidance in OpenCode and Pi now names the approved enrollment when it differs from the default name.
- OpenCode 2 now reads vault enrollment files far less often while still observing approvals and disconnects on the next read.
- Unchanged vault account lists no longer rewrite lock files on every check.

## [3.0.12] - 2026-10-26

### Fixed

- Vault menus now explain how to upgrade an incompatible Claustrum vault with `ck upgrade`, or keep using local accounts.
- Cancelling a request during a vault credential refresh now ends as cancelled instead of reporting the earlier credential as rejected.

## [3.0.11] - 2026-10-23

### Fixed

- Manual quota checks no longer let the separate Gemini 4 Argon allowance overwrite Gemini quota on Pro accounts, or show a suspended five-hour limit as stale.
- Quota errors with a reset time now hold the account off that model until the stated reset, while other accounts remain usable.
- Gemini tool schemas no longer keep `items` on non-array types or `properties` on non-object types.
- Shutdown now runs every cleanup step even if an earlier step fails, and still reports the error.
- Setup and vault menus now distinguish an incompatible older vault from a vault that is not running.

## [3.0.10] - 2026-10-22

### Fixed

- A model unavailable to one account now moves the request to the next account without a second-server retry or a rate-limit cooldown for the pool.
- Requests fail immediately with a clear message when none of the configured accounts has the requested model.
- Google permission refusals are no longer retried on the second server.

## [3.0.9] - 2026-10-21

### Fixed

- Quota checks now use only Google's main Antigravity server, avoiding Gemini allowance from a different pool. If it is unavailable, the sidebar keeps the last good reading and marks it as old.

### Changed

- OpenCode 1 vault mode now uses recent readings from the vault's quota service before asking Google, avoiding duplicate quota requests.

## [3.0.8] - 2026-10-20

### Changed

- When the vault is unreachable, model requests and quota checks keep using each account's last good credential. Rejected credentials are dropped immediately, and revoked accounts stop being served shortly after the vault reconnects.
- OpenCode 1 now reads vault accounts on connection, reconnect and change notices instead of polling every five seconds. Vaults without change notices retain polling.
- The collapsed OpenCode 1 sidebar now shows each account's lowest remaining quota window per group, or only its name and status dot when space is too narrow.

### Fixed

- Post-request quota checks no longer delay replies; OpenCode 2 also receives reply headers immediately.

## [3.0.7] - 2026-10-18

### Fixed

- Requests now stop if Antigravity has not started answering within ten minutes across all retries, servers and account switches. Once an answer starts, the limit no longer applies.
- `max_rate_limit_wait_seconds` now limits total waiting while all accounts are rate-limited or below soft quota, rather than each wait. `0` still means no limit.
- Error messages now list at most 20 tool names and mask Google project IDs; full requests remain in debug logs only.
- Empty-vault messages now distinguish missing grants from grants that reach no sign-in, and show the commands to resolve either case when the vault supports this diagnosis.
- OpenCode 2 quota and route rows now fit narrow sidebars, using the same group names, reset times and reading ages as OpenCode 1.
- First-time account-store setup now makes fewer disk writes and leaves either no store or a complete store after interruption.
- Setup now fails immediately when `pi install` cannot start, and Pi keeps its login-file lock held during slow writes.

## [3.0.6] - 2026-10-17

### Added

- Added `setup` to detect installed OpenCode and Pi hosts, register the plugin and guide local sign-in or vault enrollment. Hosts must be stopped first; `setup --dry-run` previews changes.

### Changed

- OpenCode 2 local-pool users must sign in once through Google → Google (antigravity-auth pool, browser) after upgrading. Existing vault connections keep working; native Google and API-key connections now pass through untouched, including session titles.
- OpenCode 1 quota rows now fit narrow sidebars, show reset times with two units and reading age once per account, and mark windows that reset since the last check.
- Vault messages now use plainer wording and name the shared folder when a token cannot be saved.

### Fixed

- Escape or Ctrl-C at the vault setup question now cancels without changing files.
- OpenCode 2 now applies selected Gemini thinking variants, refuses retired models clearly, reports stalled or shutdown stream failures, and rejects pool requests with a custom Google `baseURL`.
- Custom Google addresses that merely contain Google's host name are no longer taken over.
- Stuck background vault quota checks no longer prevent later checks; failed or unsaved checks log why.
- CLI login now saves to an already initialized or migrated store. An occupied sign-in port fails immediately without a later timeout error, and vault enrollment works on Windows.

## [3.0.5] - 2026-10-16

### Removed

- Removed the Gemini CLI request path and its separate quota pool after Google stopped serving consumer accounts. Plugin requests use Antigravity only, without fallback between the pools.
- Removed the Gemini CLI routing switches and `cli_first`, `quota_fallback`, `quota_style_fallback` and `operator.routing` settings. Old settings are ignored without affecting other configuration or saved accounts.

### Changed

- The Routing menu now shows the account selection strategy and where to configure it, or identifies vault mode. Antigravity server fallback, account rotation and quota protections are unchanged.

### Fixed

- The sidebar writer now leaves newer-format state files untouched. Older plugin processes must be restarted to gain this protection.
- OpenCode 2 now applies selected Gemini thinking variants and no longer takes over requests made with a user's own Google API key or native login.

## [3.0.4] - 2026-10-14

### Added

- Added `google/antigravity-gemini-4-argon` for Google AI Ultra subscribers, with low, medium and high thinking levels, medium by default, and a separate per-model quota. It accepts 1,048,576 input and 65,536 output tokens, including images and video.
- Vault enrollment now explains approval and grant commands, empty approved vaults and pending requests in OpenCode and Pi.

### Changed

- Updated the client identity to Antigravity CLI 1.3.5. Argon uses its level-based thinking format without a token budget; only the low request format has been verified against the CLI.
- Updated common-auth to 0.15.0 and the vault client to Claustrum 0.9.0. Windows account, lock, port and enrollment files are now private to the user, and folders writable by other users are refused.

### Fixed

- Pi no longer offers to forget a pending vault enrollment, which discarded the approval request, or reports the same failure twice.

### Removed

- Removed withdrawn Gemini 3.1 Pro, 3.6 Flash and 3.7 Flash models. Saved requests fail clearly instead of being sent or silently switched; earlier conversations remain readable.

## [3.0.3] - 2026-10-13

### Fixed

- Tool schemas now pass through one shared conversion step for OpenCode, OpenCode 2 and Pi, preventing unsupported schema features from breaking every request.
- Boolean and numeric constants and enums now retain their real types, with allowed values described to the model. Exclusive bounds become inclusive integer bounds or descriptions.
- Unsupported schema keywords are converted or dropped, while combined object schemas keep every part's properties. Supported Gemini fields and Claude's stricter handling remain intact.

## [3.0.2] - 2026-10-13

### Added

- Vault quota now refreshes automatically on `background_quota_refresh_interval_minutes`, with only one OpenCode process polling and only when a reading is due.

### Changed

- Sidebar state format 2 adds known account emails, unrounded `remainingFraction` values and reading timestamps for external tools. The sidebar itself still uses ordinal account labels and never displays emails.

### Fixed

- Manual vault quota checks now update the sidebar immediately, and readings retain their real fetch time across OpenCode windows.
- Switching between local and vault mode now refreshes the menu's accounts and actions immediately.
- Main-entry type declarations now use resolvable `.js` import paths, matching the OpenCode 2 entry.

## [3.0.1] - 2026-10-12

### Added

- Added Claude Opus 5.5 and Sonnet 5.5 with low, medium and high adaptive effort, a 1,000,000-token context and a 128,000-token output limit.

### Changed

- Refreshed model metadata and client identity from Antigravity CLI 1.3.3, preserving server-offered Gemini 3.5 Flash and Gemini 3.1 Flash Image.
- Claude requests now use native adaptive-thinking fields and retain explicit output caps, including warmups. Medium and high effort wire behavior is not yet verified.

### Fixed

- Windows migration now opens regular files with write access for flushing, avoiding `EPERM` failures without changing POSIX behavior or ownership checks.
- Migration after a failed 3.0.0 attempt now starts afresh without adopting or modifying the abandoned backup. Stop every account-writing host first; already-active stores do not need migration again.

### Removed

- Retired Claude 4.6 routes now refuse locally instead of silently switching models. Use `google/antigravity-claude-opus-5-5` or `google/antigravity-claude-sonnet-5-5`.

## [3.0.0] - 2026-10-12

### Added

- One `@cortexkit/opencode-antigravity-auth` package now supports OpenCode 1.17.13 or later in 1.x and OpenCode 2.0.22 or later, with account, quota, routing and vault actions in `/antigravity`.
- Added approved Claustrum vault accounts for OpenCode and Pi under the same `google/` model names. Vault mode uses fresh vault credentials, leaves local accounts dormant and hides local account-writing actions; an empty or unavailable vault never falls back to local credentials.

### Changed

- Existing OpenCode account pools require offline migration to the new account store. Disable `auto_update` before upgrading, stop every OpenCode and Antigravity process and background timer, run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`, then restart only after migration completes. Fresh installs do not need migration; never run old and new plugins against the same pool.
- Downgrading a migrated pool requires disconnecting the vault, stopping every host and timer, and running `npx @cortexkit/opencode-antigravity-auth@3.0.0 rollback --offline` before installing the older build. Rollback exports current credentials; do not restore an old account-file backup over them.
- Pi model selections move from `google-antigravity/...` to `google/...`, with `/login google` for local OAuth. Existing credentials are not moved automatically, and Pi-only users do not run the OpenCode migration. Vault disconnect restores the previous native Google login only while the native Google login file entry still belongs to that vault enrollment.
- Quota displays now consistently show percent left, reported windows, valid reset countdowns and the age of stale readings. Changing sources does not make old readings appear fresh.

### Fixed

- Reloading OpenCode 1 authentication preserves admitted response streams; final shutdown blocks new work and cancels outstanding I/O.
- Transport and streaming failures remain native host errors, with selected credentials masked in HTTP/SSE diagnostics, headers and cancellation failures. Successful model and tool content is unchanged.

## [2.3.0] - 2026-09-17

### Added

- Added the separately installable `@cortexkit/opencode-v2-antigravity-auth` adapter for OpenCode 2.x, backed by the shared account pool and Antigravity transport.

### Fixed

- Request cancellation now destroys in-flight direct and HTTPS-proxy connections immediately instead of leaving sockets alive until the transport timeout.
- Raw AGY connections that close before sending HTTP response headers now fail immediately instead of consuming the full 180-second header timeout for every endpoint and account fallback.

## [2.2.1] - 2026-09-04

### Fixed

- Terminal transport failures now propagate through OpenCode's native retry and error pipeline instead of appearing as successful assistant text.

## [2.2.0] - 2026-09-02

### Added

- Added Gemini 3.8 Flash with low, medium (default), and high thinking tiers using model routes and metadata captured from native AGY CLI 1.1.24.

### Changed

- Updated the Antigravity CLI wire identity and fixtures from 1.1.13 to 1.1.24.

## [2.1.0] - 2026-08-14

### Added

- Added Gemini 3.7 Flash with low, medium (default), and high thinking tiers, using the model routes and metadata captured from native AGY CLI 1.1.13.

### Changed

- Updated the Antigravity CLI wire identity and fixtures from 1.1.6 to 1.1.13.

## [2.0.0] - 2026-07-22

### Breaking

- The OpenCode package root now exports plugin factories only. Import
  `authorizeAntigravity` and `exchangeAntigravity` from
  `@cortexkit/antigravity-auth-core` instead.
- `@opencode-ai/plugin` peer dependency is now `^1.17.13` (was `^0.15.30`).
- New required peer dependencies: `@opentui/core`, `@opentui/keymap`,
  `@opentui/solid` at `^0.4.5`.

### Migration from 1.x

1. Update `@opencode-ai/plugin` to `>=1.17.13` in your host.
2. Install new peers: `bun add -d @opentui/core @opentui/keymap @opentui/solid`
   (each `^0.4.5`).
3. Replace root OAuth imports:
   - Before: `import { authorizeAntigravity } from '@cortexkit/opencode-antigravity-auth'`
   - After: `import { authorizeAntigravity } from '@cortexkit/antigravity-auth-core'`
4. No config file changes required; account storage format is unchanged.

### Changed

- Missing accounts return HTTP 401 `UNAUTHENTICATED` instead of HTTP 200
  synthetic assistant text.

## [1.6.0] - 2026-02-20

### Fixed

- **#397** - Gemini tool-call payload handling now enforces valid `thought_signature` behavior for `functionCall` parts, preventing `400 INVALID_ARGUMENT` in mixed and parallel call turns.

- **#454** - Request sanitization now removes empty/invalid `contents.parts` entries and invalid `systemInstruction.parts` before forwarding to Antigravity.

- **#444** - Response transform fallback now uses cloned responses and preserves recovery signaling, eliminating `Body already used` failures.

- **#368 (Tackled)** - Claude thinking/signature handling now replaces foreign signatures with sentinels and tightens thinking-order classification to reduce false-positive recovery triggers.

### Changed

- **Debug Sink Split** - `debug` now controls file logging only, while `debug_tui` independently controls TUI panel logging.

- **Header Normalization** - `x-goog-user-project` is now stripped across Antigravity and Gemini CLI request styles.

- **Claude Prompt Auto-Caching (Optional)** - Added `claude_prompt_auto_caching` to inject `cache_control: { type: "ephemeral" }` when Claude prompt caching is desired and unset.

### Documentation

- Updated README, architecture/config/troubleshooting docs, and generated schema docs to reflect new debug sink semantics and config keys.

## [1.5.2] - 2026-02-18

### Changed

- Added support for Sonnet 4.6 and removed old models support.

## [1.5.1] - 2026-02-11

### Changed

- **Header Identity Alignment** - `ideType` changed from `IDE_UNSPECIFIED` to `ANTIGRAVITY` and `platform` from `PLATFORM_UNSPECIFIED` to dynamic `WINDOWS`/`MACOS` (based on `process.platform`) across all header sources (`getAntigravityHeaders`, `oauth.ts`, `project.ts`). Now matches Antigravity Manager behavior

- **Gemini CLI `Client-Metadata` Header** - Gemini CLI requests now include `Client-Metadata` header, aligning with actual `gemini-cli` behavior. Previously only Antigravity-style requests sent this header

- **Gemini CLI User-Agent Format** - Updated from `GeminiCLI/{ver}/{model}` to `GeminiCLI/{ver}/{model} ({platform}; {arch})` to match real `gemini-cli` UA strings. Version pool updated from `1.2.0/1.1.0/1.0.0` to `0.28.0/0.27.4/0.27.3` to align with actual release numbers

- **Randomized Headers Model-Aware** - `getRandomizedHeaders()` now accepts an optional `model` parameter, embedding the actual model name in Gemini CLI User-Agent strings instead of a hardcoded default

- **Fingerprint Platform Alignment** - Antigravity-style `Client-Metadata` platform now consistently matches the randomized User-Agent platform, fixing a potential mismatch where headers could disagree on reported platform

### Removed

- **Linux Fingerprints** - Removed `linux/amd64` and `linux/arm64` from `ANTIGRAVITY_PLATFORMS` and fingerprint generation. Linux users now masquerade as macOS (Antigravity does not support Linux as a native platform)

- **`getAntigravityUserAgents()` Function** - Removed unused helper that had no callers in the codebase

- **`X-Opencode-Tools-Debug` Header** - Removed debug telemetry header from outgoing requests

## [1.5.0] - 2026-02-11

### Added

- **Account Verification Flow** - Auth login menu now supports `verify` and `verify-all` actions. When Antigravity returns a 403 with `validation_required`, the account is automatically disabled, marked with a verification URL, and cooled down. Users can verify accounts directly from the menu with a probe request to confirm resolution

- **Dynamic Antigravity Version** - Plugin version is now fetched at startup from the Antigravity updater API, with a changelog-scrape fallback and a hardcoded last-resort. Eliminates stale "version no longer supported" errors after Antigravity updates

- **Storage V4 Schema** - New storage version adds `verificationRequired`, `verificationRequiredAt`, `verificationRequiredReason`, `verificationUrl`, and `fingerprintHistory` fields per account. Full migration chain from v1/v2/v3 to v4

- **`saveAccountsReplace`** - New destructive-write storage function that replaces the entire accounts file without merging, preventing deleted accounts from being resurrected by concurrent reads

- **`setAccountEnabled` / Account Toggling** - New account management methods: `setAccountEnabled()`, `markAccountVerificationRequired()`, `clearAccountVerificationRequired()`, `removeAccountByIndex()`

- **Secure File Permissions** - Credential storage files are now created with mode `0600` (owner read/write only). Existing files with overly permissive modes are tightened on load

- **`opencode.jsonc` Support** - Configure models flow now detects and prefers existing `opencode.jsonc` files. JSONC parsing strips comments and trailing commas before JSON.parse

- **Header Contract Tests** - New `src/constants.test.ts` validates header shapes, randomization behavior, and optional header fields for both Antigravity and Gemini CLI styles

### Changed

- **Unified Gemini Routing** - Gemini quota fallback between Antigravity and Gemini CLI pools is now always enabled for Gemini models. The `quota_fallback` config flag is deprecated and ignored (backward-compatible, no breakage)

- **`cli_first` Honored in Routing** - `resolveHeaderRoutingDecision()` centralizes routing logic and properly respects `cli_first` for unsuffixed Gemini models

- **Fingerprint Headers Simplified** - `buildFingerprintHeaders()` now returns only `User-Agent`. Removed `X-Goog-QuotaUser`, `X-Client-Device-Id`, `X-Goog-Api-Client`, and `Client-Metadata` from outgoing content requests to align with Antigravity Manager behavior

- **Client Metadata Reduced** - Fingerprint client metadata trimmed to `ideType`, `platform`, `pluginType` only. Removed `osVersion`, `arch`, `sqmId`

- **Gemini CLI User-Agent Format** - Updated from `google-genai-sdk/...` to `GeminiCLI/...` format

- **Search Model** - Changed from `gemini-2.0-flash` to `gemini-2.5-flash` for improved search result quality

- **Deterministic Search Generation** - Search requests now use `temperature: 0` and `topP: 1` instead of thinking config

- **OAuth Headers Dynamic** - `oauth.ts` and `project.ts` now use `getAntigravityHeaders()` instead of static constants, removing stale `X-Goog-Api-Client` from token/project calls

### Fixed

- **#410**: Strip `x-goog-user-project` header for ALL header styles, not just Antigravity. This header caused 403 errors on Daily/Prod endpoints when the user's GCP project lacked Cloud Code API
- **#370 / #336**: Account deletion now persists correctly. Root cause: `saveAccounts()` merged deleted accounts back from disk. Fixed by introducing `saveAccountsReplace()` for destructive writes and syncing in-memory state immediately
- **#381**: Disabled accounts no longer selected via sticky index. `getCurrentAccountForFamily()` now skips disabled accounts and advances the active index
- **#384**: `google_search` tool no longer returns empty citations when using `gemini-3-flash`. Search model switched to `gemini-2.5-flash`
- **#377**: Configure models flow now respects existing `opencode.jsonc` files instead of creating duplicate `opencode.json`
- **Excessive Disk Writes** - Fixed project context auth updates causing 3000+ writes/sec during streaming. Changed from reference equality to value comparison on auth tokens and added throttled saves. Prevents SSD wear on macOS
- **Fingerprint Alignment** - Force-regenerated fingerprints to match current Antigravity Manager behavior, fixing `ideType` and stripping stale client metadata fields

### Removed

- **Extra Outgoing Headers** - `X-Goog-Api-Client`, `Client-Metadata`, `X-Goog-QuotaUser`, `X-Client-Device-Id` no longer sent on content requests
- **Fingerprint Metadata Fields** - `osVersion`, `arch`, `sqmId` removed from fingerprint client metadata
- **`updateFingerprintVersion` Helper** - Removed from accounts module (fingerprint version rewriting no longer needed)

### Documentation

- **AGENTS.md** expanded with detailed architecture, code style, and fingerprint system documentation
- **README.md**, **CONFIGURATION.md**, **MULTI-ACCOUNT.md** updated to reflect deprecated `quota_fallback` and automatic Gemini pool fallback behavior
- **`antigravity.schema.json`** marks `quota_fallback` as deprecated/ignored

## [1.4.5] - 2026-02-05

### Added

- **Configure Models Menu Action** - Auth login menu now includes a "Configure models" action that writes plugin model definitions directly into `opencode.json`, making setup easier for new users

- **`cli_first` Config Option** - New configuration option to route Gemini models to Gemini CLI quota first, useful for users who want to preserve Antigravity quota for Claude models

- **`toast_scope` Configuration** - Control toast visibility per session with `toast_scope: "root_only"` to suppress toasts in subagent sessions

- **Soft Quota Protection** - Skip accounts over 90% usage threshold to prevent Google penalties, with configurable `soft_quota_threshold_percent` and wait/retry behavior

- **Gemini CLI Quota Management** - Enhanced quota display with dual quota pool support (Antigravity + Gemini CLI)

- **`OPENCODE_CONFIG_DIR` Environment Variable** - Custom config location support for non-standard setups

- **`quota_refresh_interval_minutes`** - Background quota cache refresh (default 15 minutes)

- **`soft_quota_cache_ttl_minutes`** - Cache freshness control for soft quota checks

### Changed

- **Model Naming and Routing** - Documented antigravity-prefixed model names and automatic mapping to CLI preview names (e.g., `antigravity-gemini-3-flash` → `gemini-3-flash-preview`)

- **Antigravity-First Quota Strategy** - Exhausts Antigravity quota across ALL accounts before falling back to Gemini CLI quota (previously per-account)

- **Quota Routing Respects `cli_first`** - Fallback behavior updated to respect `cli_first` preference

- **Config Directory Resolution** - Now prioritizes `OPENCODE_CONFIG_DIR` environment variable

- **Enhanced Debug Logging** - Process ID included for better traceability across concurrent sessions

- **Improved Quota Group Resolution** - More consistent quota management with `resolveQuotaGroup` function

### Fixed

- **#337**: Skip disabled accounts in proactive token refresh
- **#233**: Skip sandbox endpoints for Gemini CLI models (fixes 404/403 cascade)
- **Windows Config Auto-Migration**: Automatically migrates config from `%APPDATA%\opencode\` to `~/.config/opencode/`
- **Root Session Detection**: Reset `isChildSession` flag correctly for root sessions
- **Stale Quota Cache**: Prevent spin loop on stale quota cache
- **Quota Group Default**: Fix quota group selection defaulting to `gemini-pro` when model is null

### Removed

- **Fingerprint Headers for Gemini CLI** - Removed fingerprint headers from Gemini CLI model requests to align with official behavior
- **`web_search` Configuration Leftovers** - Cleaned up remaining `web_search` config remnants from schema

### Documentation

- Updated README with model configuration options and simplified setup instructions
- Updated MODEL-VARIANTS.md with Antigravity model names and configuration guidance
- Updated CONFIGURATION.md to clarify `quota_fallback` behavior across accounts
- Updated MULTI-ACCOUNT.md with dual quota pool and fallback flow details

---

## [1.3.2] - 2026-01-27

### Added

- **Quota check and account management in auth login** - Added new `--quota` and `--manage` options to the `auth login` command for checking account quota status and managing accounts directly from the CLI ([#284](https://github.com/cortexkit/antigravity-auth/issues/284))

- **Request timing jitter** - Added configurable random delay to requests to reduce detection patterns and improve rate limit resilience. Requests now include small random timing variations

- **Header randomization for fingerprint diversity** - Headers are now randomized to create more diverse fingerprints, reducing the likelihood of requests being grouped and rate-limited together

- **Per-account fingerprint persistence** - Fingerprints are now persisted per-account in storage, allowing consistent identity across sessions and enabling fingerprint history tracking
  - Added fingerprint restore operations to AccountManager
  - Extended per-account fingerprint history for better tracking
  - Fingerprint now shown in debug output

- **Scheduling mode configuration** - Added new scheduling modes including `cache-first` mode that prioritizes accounts with cached tokens, reducing authentication overhead

- **Failure count TTL expiration** - Account failure counts now expire after a configurable time period, allowing accounts to naturally recover from temporary issues

- **Exponential backoff for 503/529 errors** - Implemented exponential backoff with jitter for capacity-related errors, matching behavior of Antigravity-Manager

### Changed

- **Increased MODEL_CAPACITY backoff to 45s with jitter** - Extended the base backoff time for model capacity errors from previous values to 45 seconds, with added jitter to prevent thundering herd issues

- **Regenerate fingerprint after capacity retry exhaustion** - When all capacity retries are exhausted, the fingerprint is now regenerated to potentially get assigned to a different backend partition

- **Enhanced duration parsing for Go format** - Improved parsing of duration strings to handle Go-style duration formats (e.g., `1h30m`) used in some API responses

### Fixed

- **Prevent toast spam for rate limit warnings** - Added 5-second debounce for rate limit warning toasts to prevent notification flooding when multiple requests hit rate limits simultaneously ([#286](https://github.com/cortexkit/antigravity-auth/issues/286))

- **`getEnabledAccounts` now treats undefined as enabled** - Fixed issue where accounts without an explicit `enabled` field were incorrectly filtered out. Accounts now default to enabled when the field is undefined

- **Show correct position in account toast for enabled accounts** - Fixed the account position indicator in toast notifications to only count enabled accounts, showing accurate position like "Account 2/5" instead of including disabled accounts

- **Filter disabled accounts in all selection methods** - Ensured disabled accounts are properly excluded from all account selection strategies (round-robin, least-used, random, etc.)

- **Robust handling for capacity/5xx errors** - Implemented comprehensive retry logic for model capacity and server errors, achieving parity with Antigravity-Manager's behavior
  - Reordered parsing logic to prioritize capacity checks
  - Fixed loop retry logic to prevent state pollution
  - Added capacity retry limit to prevent infinite loops ([#263](https://github.com/cortexkit/antigravity-auth/issues/263))

- **Fixed @opencode-ai/plugin dependency location** - Moved `@opencode-ai/plugin` from devDependencies to dependencies section, fixing runtime errors when the plugin was installed without dev dependencies

### Removed

- **Removed deprecated `web_search` configuration** - The deprecated `web_search.default_mode` and `web_search.grounding_threshold` configuration options have been fully removed. Use the `google_search` tool instead (introduced in 1.3.1)

## [1.3.1] - 2026-01-21

### Added

- **New `google_search` tool for web search** - Implements Google Search grounding as a callable tool that the model can invoke explicitly
  - Makes separate API calls with only `{ googleSearch: {} }` tool, avoiding Gemini API limitation where grounding tools cannot be combined with function declarations
  - Returns formatted markdown with search results, sources with URLs, and search queries used
  - Supports optional URL analysis via `urlContext` when URLs are provided
  - Configurable thinking mode (deep vs fast) for search operations
  - Uses `gemini-3-flash` model for fast, cost-effective search operations

### Changed

- Upgraded to Zod v4 and adjusted schema generation for compatibility
- **Deprecated `web_search` config** - The `web_search.default_mode` and `web_search.grounding_threshold` config options are now deprecated. Google Search is now implemented as a dedicated tool rather than automatic grounding injection

### Fixed

- **`keep_thinking=true` now works without debug mode** - Fixed Claude multi-turn conversations failing with "Failed to process error response" when `keep_thinking=true` after tool calls, unless debug mode was enabled
  - Root cause: `filterContentArray` trusted any signature >= 50 chars for last assistant messages, but Claude returns its own signatures that Antigravity doesn't recognize
  - Fix: Now verifies signatures against our cache via `isOurCachedSignature()` before passing through. Foreign/missing signatures get replaced with `SKIP_THOUGHT_SIGNATURE` sentinel
  - Why debug worked: Debug mode injects synthetic thinking with no signature, triggering sentinel injection correctly

- **Fixed tool calls failing for tools with no parameters** - Tools like `hive_plan_read`, `hive_status`, and `hive_feature_list` that have no required parameters would fail with Zod validation error `state.input: expected record, received undefined`
  - Root cause: When Claude calls a tool with no parameters, it returns `functionCall` without an `args` field. The response transformation only processed parts where `functionCall.args` was defined, leaving `args` as `undefined`
  - Fix: Changed condition to handle all `functionCall` parts, defaulting `args` to `{}` when missing, ensuring opencode's `state.input` always receives a valid record

- **Auth headers aligned with official Gemini CLI** - Updated authentication headers to match the official Antigravity/Gemini CLI behavior, reducing "account ineligible" errors and potential bans ([#178](https://github.com/cortexkit/antigravity-auth/issues/178))
  - `GEMINI_CLI_HEADERS["User-Agent"]`: `9.15.1` → `10.3.0`
  - `GEMINI_CLI_HEADERS["X-Goog-Api-Client"]`: `gl-node/22.17.0` → `gl-node/22.18.0`
  - `ANTIGRAVITY_HEADERS["User-Agent"]`: Updated to full Chrome/Electron user agent string
  - Token exchange now includes `Accept`, `Accept-Encoding`, `User-Agent`, `X-Goog-Api-Client` headers
  - Userinfo fetch now includes `User-Agent`, `X-Goog-Api-Client` headers
  - `fetchProjectID` now uses centralized constants instead of hardcoded strings

- **`quiet_mode` now properly suppresses all toast notifications** - Fixed `quiet_mode: true` in `antigravity.json` not suppressing "Status dialog dismissed" and other toast notifications ([#207](https://github.com/cortexkit/antigravity-auth/issues/207))
  - Root cause: The `showToast` helper function didn't check `quietMode`, and only some call sites had manual `!quietMode &&` guards
  - Fix: Moved `quietMode` check inside `showToast` helper so all toasts are automatically suppressed when `quiet_mode: true`

### Removed

- **Removed automatic `googleSearch` injection** - Previously attempted to inject `{ googleSearch: {} }` into all Gemini requests, which never worked due to API limitations. Now uses the explicit tool approach instead

## [1.3.0] - Previous Release

See [releases](https://github.com/cortexkit/antigravity-auth/releases) for previous versions.
