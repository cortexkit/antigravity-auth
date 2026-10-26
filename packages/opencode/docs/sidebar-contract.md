# OpenCode 1 sidebar snapshot contract (version 2)

This owner-only JSON file is the machine-readable projection of the OpenCode 1
(V1) Antigravity account pool. The plugin writes it atomically; the V1 TUI and
other owner-authorized consumers may read it. It is not the OpenCode 2 (GA) RPC
protocol.

## Location and privacy

The default path is
`$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json`, falling back to
`~/.local/state/cortexkit/antigravity-auth/sidebar-state.json` when XDG state is
unset. `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE` overrides the complete file path.
Use a dedicated private parent directory for an override: writers enforce mode
`0700` on that parent and `0600` on the file (POSIX).

Version 2 contains **email addresses (PII)** when genuinely known. Do not publish
or indiscriminately log this file. It never contains credentials (refresh or
access tokens, cookies, authorization headers), project IDs, fingerprints, or
OAuth profile names. The renderer's privacy boundary is stricter than the file's:
the TUI never renders email or includes it in logs or toasts. Account labels stay
ordinal, even when email is known.

In vault mode only vault-served accounts appear. Dormant local accounts and their
routing are excluded. With unreadable enrollment authority the projection is
empty, not a fallback to local accounts.

## Version policy

`version` is the integer major contract version. Writers emit **2**. Consumers
must refuse an unknown major version rather than interpret it as a known schema.
Unknown additive fields within a supported version may be ignored.
A writer never replaces a file with a newer major version; it skips its write
instead.

The V1 reader accepts both 1 and 2, normalizing them to an in-memory version 2
state. A pre-upgrade version 1 file is therefore readable without a crash. Missing
email, fraction precision, or observation times are **not invented** from labels,
rounded percentages, or machine publication time. The next genuine quota reading
supplies the missing data. Missing, unreadable, malformed, or unknown-version
files produce an empty default state; unknown versions set
`lastError: "unsupported-version:<version>"`.

## Fields

All timestamps below are finite Unix epoch **milliseconds**, not seconds.
Optional properties are omitted from serialized JSON when unknown.

| Top-level field | Meaning |
| --- | --- |
| `version` | Major contract version, currently `2`. |
| `checkedAt` | Machine snapshot **publication** time. `0` means no publication. It is not a quota observation time. Machine writes merge by this clock. |
| `accounts` | Array of account projections described below. May be empty. |
| `activeRouting` | Session ID → routing entry map. Entries older than 24 hours are pruned on writes; at most the newest 100 are retained. |
| `routingAuthoritative` | Whether a routing-capable writer has published; sticky true once set. |
| `quotaBackoffUntil` | Optional time until quota checks are paused. Not an observation time. |
| `lastError` | Optional publication/read status or remedy. Not a quota reading. |

| Account field | Meaning |
| --- | --- |
| `id` | Positional key: `acct-N` for local accounts, `vault-acct-N` for vault accounts, with zero-based N. Not a durable identity across roster reorderings. |
| `label` | Ordinal display label `Account N`, with one-based N. Never an email or profile name. |
| `email` | Optional genuine local metadata email, or vault `route.email` when defined. Never derived, guessed, or substituted from a label/ID. For owner-only machine identity matching, not TUI display. |
| `enabled` | Whether the account is enabled. |
| `health` | Health score in `[0, 100]`. |
| `current` | Whether it is serving at least one model family. More than one account may be current. Vault machine projections initialize this to false; session routing identifies the served account. |
| `cooldownUntil` | Optional end of the account cooldown. |
| `quota` | Partial map of the stable quota group keys `gemini`, `non-gemini` and `gemini-argon`. A missing group means no cached reading for that group. `gemini-argon` appears only for accounts whose quota reading includes Google's separate Argon weekly allowance (paid Pro plans); readers that don't know the key can ignore it. |
| `tier` | Optional captured plan metadata: `id` (raw upstream tier string), optional `paidId` (raw paid tier string), and `capturedAt` (capture time). Absence means unknown, not free-tier. |

Each `quota` group contains:

| Group field | Meaning |
| --- | --- |
| `remainingPercent` | Whole-number remaining percentage, rounded from the fraction and bounded to `[0, 100]`. Aggregate is the most-constrained window. |
| `remainingFraction` | Unrounded remaining fraction bounded to `[0, 1]`. New projections preserve source precision, not `remainingPercent / 100`. Optional only for legacy percentage-only data normalized from version 1. |
| `checkedAt` | Optional **observation** time: exactly the account's `cachedQuotaUpdatedAt`, the successful quota cache's fetch time. Not the machine publication time. |
| `resetAt` | Optional upstream quota reset time. |
| `windows` | Optional array of window readings. Absent for aggregate-only legacy data; no synthetic windows are invented. |

Each window has `window`, `remainingPercent`, `remainingFraction`, optional
`checkedAt`, and optional `resetAt`, with the same meanings as the group fields.
Its observation time comes from the same `cachedQuotaUpdatedAt` as its group.
The window keys **`5h` and `weekly` are stable machine keys**. Display text such
as `7d` is presentation only; consumers must not substitute it for `weekly`.

Each `activeRouting` entry has `accountId` (one of the account positional keys),
`modelFamily` (`claude` or `gemini`), `headerStyle` (always `antigravity`),
optional `strategy` (`sticky`, `round-robin`, or `hybrid`), and `updatedAt` (routing
observation time). Routing timestamps do not date quota readings.

## Reading age and refresh behavior

Define staleness using `now - accounts[i].quota[group].checkedAt`, never the
machine `checkedAt`. A **missing observation time means "no reading yet, never
treat as current"**, even if a legacy percentage is present. Undated readings
stay undated. Consumers choose their own staleness threshold; this schema does
not promise a fixed refresh cadence or that every group is always present.

With `background_quota_refresh` enabled, a vault-only producer uses
`background_quota_refresh_interval_minutes`, startup jitter up to 30 seconds,
and interval jitter of up to 10%, like the unchanged local producer. Inside the
polling fence it reads the current pool and durable provider state. A tick is due
when any current row has no matching dated quota reading, or when the oldest
matching `cachedQuotaUpdatedAt` reaches the age threshold
`max(intervalMs - 60_000, floor(intervalMs / 2))`. Matching uses the same account,
route and credential IDs as the sidebar projection. Missing quota or observation
time is due; an empty pool performs no fetch. Sidebar publication time never
postpones a vault quota check, and another process's fresh durable readings skip
redundant requests. The distinct renewable
`bg-vault-quota-poll` advisory fence permits one process to perform a check;
contention or lock errors skip the tick. Disposal and fresh non-vault/unreadable
authority stop further physical requests.

Manual Quota menu checks and automatic ticks share the same post-record
publication path. Only attributed, successful readings accepted by durable
provider state cause publication. Failed, refused, or unattributed readings do
not replace quota or advance its observation time. Vault projection reads quota
from provider state indexed by the row's account identity, only when the stored
observation's route and credential IDs also match the current row. Readings
written by another process therefore appear even when an existing selector row
has an older in-memory cache.

The v2 `headerStyle` field is retained for QTA readers and is always `"antigravity"`. Old snapshots containing `"gemini-cli"` normalize to `"antigravity"`; they cannot select a request path.
