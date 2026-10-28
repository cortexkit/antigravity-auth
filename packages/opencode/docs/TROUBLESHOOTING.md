# Troubleshooting

Solutions to common issues with the Antigravity Auth plugin.

> **Do not delete store or custody files as a generic reset.** Stop the host, inspect the initialization/migration/source refusal, then use account actions or re-login once the active source is healthy. Deletion can destroy rollback evidence or a saved native login. See [migration and rollback](MIGRATION.md) and [vault custody](VAULT.md).

---

## Configuration Paths (All Platforms)

OpenCode uses `~/.config/opencode/` on **all platforms** including Windows.

| File | Path |
|------|------|
| Main config | `~/.config/opencode/opencode.json` |
| Accounts | After the move, `~/.local/state/cortexkit/antigravity-auth/opencode/antigravity-accounts.json.store.pointer.json` selects the sibling `antigravity-accounts.json.store.<id>.generation/` directory containing `config.json` / `state.json` (`opencode-<16 hex>/` for another config folder). The config-folder pointer forwards to it; legacy `antigravity-accounts.json` is import/export only. |
| Plugin config | `~/.config/opencode/antigravity.json` |
| Vault files | `~/.local/state/cortexkit/antigravity-auth/opencode/antigravity-auth-vault/` (`opencode-<16 hex>/` for another config folder). See [where the files live](CONFIGURATION.md#where-the-files-live). |
| Signature cache | `~/.local/state/cortexkit/antigravity-auth/antigravity-signature-cache.json` |
| Debug logs | `~/.local/state/cortexkit/antigravity-auth/logs/`, or `OPENCODE_ANTIGRAVITY_LOG_DIR`, then `log_dir` |

`~/.local/state` is `$XDG_STATE_HOME` when that is set. The account store moves at the first local-account start after every OpenCode using it has closed or restarted on this version. If the state path goes through a link, it stays put; set `XDG_STATE_HOME` to the real path and restart with every other OpenCode closed. See [where the files live](CONFIGURATION.md#where-the-files-live) for the retained backup and move refusals.

**Never delete `antigravity-accounts.json.store.pointer.json` in OpenCode's config folder.** That forwarding pointer keeps older versions from starting with no accounts. Before downgrading to 3.0.15 or earlier, close every OpenCode and run `antigravity-auth store relocate --back --offline` on the current version; it replaces the old pre-move backup with your current accounts. If an older version refuses with `pointer has unknown fields`, reinstall the current version to run the command, then downgrade. Going back to 3.0.16 needs no account-store step. See [downgrading](CONFIGURATION.md#downgrading).

> **Windows users**: `~` resolves to your user home directory (e.g., `C:\Users\YourName`). Do NOT use `%APPDATA%`.

---

## Quick Fixes

### Auth problems
Verify the active source and initialized/migrated store before reauthorization. Use `/antigravity` → Accounts to reauthorize or remove a local account; do not hand-edit legacy JSON. For OpenCode 2, finish [pool browser login and saved Antigravity connection selection](OPENCODE-2.md#pool-browser-login). A real native Google key/login deliberately passes through instead of using plugin accounts.

### "This version of Antigravity is no longer supported"
This almost always means an outdated Antigravity `User-Agent` is still being used.

1) Stop any running OpenCode processes (stale processes can overwrite your accounts file):

**macOS/Linux:**
```bash
pkill -f opencode || true
```

**Windows (PowerShell):**
```powershell
Stop-Process -Name "opencode" -Force -ErrorAction SilentlyContinue
```

2) Reinstall the intended plugin build using the [OpenCode 1 registration instructions](CONFIGURATION.md#opencode-1-manual-registration) or the [OpenCode 2 guide](OPENCODE-2.md). Preserve the store and custody files. Before a major upgrade, [hold automatic updates](MIGRATION.md#hold-automatic-updates-before-a-major-upgrade) and [migrate offline](MIGRATION.md#initialize-or-migrate-before-starting-the-host). For a downgrade, follow the [stopped-process rollback instructions](MIGRATION.md#initialize-or-migrate-before-starting-the-host). Before changing builds, [disconnect vault custody safely](VAULT.md#disconnect-and-change-builds-safely). Do not bypass these steps with a cache reset.

### "Model not found"
Gemini 3.1 Pro, Gemini 3.6/3.7 Flash and `gemini-pro-agent` were withdrawn by
Antigravity. Their grouped selectors and native tier routes are no longer
available. Requests refuse with a static nonretryable message before any physical
send, without aliases or redirects. Historical transcripts remain readable.
Changing the CLI identity or re-authenticating does not restore these routes.
Gemini 4 Argon requires Google AI Ultra.

Add this to your `google` provider config:
```json
"npm": "@ai-sdk/google"
```

### Session errors
Type `continue` to trigger auto-recovery, or use `/undo` to roll back.

### Configuration Key Typo

For **OpenCode 1**, the key is `plugin` (singular):

```json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth@latest"]
}
```

**Not** `"plugins"` (will cause "Unrecognized key" error).

### "Invalid SemVer: beta"

**Error:**
```
Invalid SemVer
{
  "name": "UnknownError",
  "data": {
    "message": "Error: Invalid SemVer: beta ... isOutdated (src/bun/registry.ts:...)"
  }
}
```

**Why this happens:** OpenCode's cache may keep the plugin dependency as a dist-tag (`"beta"`) in `~/.cache/opencode/package.json` and `~/.cache/opencode/bun.lock`. Some OpenCode versions compare plugin versions as strict semver and fail on non-numeric tags.

**Fix (recommended):** Re-resolve the dependency in OpenCode cache so it is pinned to a real version.

**macOS / Linux:**
```bash
cd ~/.cache/opencode
bun add opencode-antigravity-auth@latest
```

**Windows (PowerShell):**
```powershell
Set-Location "$env:USERPROFILE\.cache\opencode"
bun add opencode-antigravity-auth@latest
```

Then restart OpenCode.

> If you intentionally run beta channel, use `bun add opencode-antigravity-auth@beta` instead.

---

## Gemini 3 Models 400 Error ("Unknown name 'parameters'")

**Error:**
```
Invalid JSON payload received. Unknown name "parameters" at 'request.tools[0]'
```

**Causes:**
- Tool schema incompatibility with Gemini's strict protobuf validation
- MCP servers with malformed schemas
- Plugin version regression

**Solutions:**
1. **Update to latest beta:**
   ```json
   { "plugin": ["opencode-antigravity-auth@beta"] }
   ```

2. **Disable MCP servers** one-by-one to find the problematic one

3. **Add npm override:**
   ```json
   { "provider": { "google": { "npm": "@ai-sdk/google" } } }
   ```

---

## MCP Servers Causing Errors

Some MCP servers have schemas incompatible with Antigravity's strict JSON format.

**Diagnosis:**
1. Disable all MCP servers in your config
2. Enable one-by-one until error reappears
3. Report the specific MCP in a [GitHub issue](https://github.com/cortexkit/antigravity-auth/issues)

---

## Rate Limits, Shadow Bans, and Hanging Prompts

**Pre-response timeout:** A logical generation request has a fixed, provisional **10-minute limit** while seeking an accepted main response's headers. It includes credential/project preparation, account waits, warmups, and retries across endpoints/accounts; it is not a configurable setting. Expiry produces a native HTTP 412 (`FAILED_PRECONDITION`) with “Antigravity did not begin a response within the pre-response time limit. Check your connection and try again later.” Pi uses its native error event. Check your connection/proxy before trying a new request. Cancellation is not converted to this error.

This is **not a first-visible-token guarantee**: after accepted main headers, the response body can keep streaming past ten minutes. An empty-response resend still uses the original deadline. Per-attempt header timers stay at 180 seconds, and body-idle watchdogs stay at 180 seconds in OpenCode 1/Pi and 300 seconds in GA. The separate cumulative no-eligible-account wait budget still resets on eligible selection; whichever limit expires first wins (quota policy wins a tie). A quota-wait value of `0` disables only that quota cap, not the fixed pre-response limit.

**Symptoms:**
- Prompts hang indefinitely (200 OK in logs but no response)
- 403 "Permission Denied" errors even with fresh accounts
- "All accounts rate-limited" but quota looks available
- New accounts get rate-limited immediately after adding

**Why this happens:**

Google has significantly tightened quota and rate-limit enforcement. This affects ALL users, not just this plugin. Key factors:

1. **Stricter enforcement** — Even when quota "looks available," Google may throttle or soft-ban accounts that trigger their abuse detection
2. **OpenCode's request pattern** — OpenCode makes more API calls than native apps (tool calls, retries, streaming, multi-turn chains), which triggers limits faster than "normal" usage
3. **Shadow bans** — Some accounts become effectively unusable for extended periods once flagged, while others continue working normally

> ⚠️ **Important:** Using this plugin may increase the chance of triggering automated abuse/rate-limit protections. The upstream provider can restrict, suspend, or terminate access at their discretion. **USE AT YOUR OWN RISK.**

**Solutions:**

<details>
<summary><b>1. Wait it out (most reliable)</b></summary>

Rate limits typically reset after a few hours. If you're seeing persistent issues:
- Stop using the affected account for 24-48 hours
- Use a different account in the meantime
- Check `rateLimitResetTimes` in your accounts file to see when limits expire

</details>

<details>
<summary><b>2. "Warm up" accounts in Antigravity IDE (community tip)</b></summary>

Users have reported success with this approach:

1. Open [Antigravity IDE](https://idx.google.com/) directly in your browser
2. Log in with the affected Google account
3. Run a few simple prompts (e.g., "Hello", "What's 2+2?")
4. After 5-10 successful prompts, try using the account with the plugin again

**Why this might work:** Using the account through the "official" interface may reset some internal flags or make the account appear less suspicious.

</details>

<details>
<summary><b>3. Reduce request volume and burstiness</b></summary>

- Use shorter sessions
- Avoid parallel/retry-heavy workflows (e.g., spawning many subagents at once)
- If using oh-my-opencode, consider reducing concurrent agent spawns
- Lower `max_rate_limit_wait_seconds` to bound cumulative all-account waits (`0` disables only that quota-wait cap; the separate fixed ten-minute limit on seeking accepted main response headers still applies)

</details>

<details>
<summary><b>4. Use Antigravity IDE directly (single account users)</b></summary>

If you only have one account, you'll likely have a better experience using [Antigravity IDE](https://idx.google.com/) directly instead of routing through OpenCode, since OpenCode's request pattern triggers limits faster.

</details>

<details>
<summary><b>5. Fresh account setup</b></summary>

If adding new accounts:
1. Initialize a truly fresh store or migrate a legacy pool [offline](MIGRATION.md).
2. Use the [host-specific login route](COMMANDS.md#host-login-routes) to add an account without deleting existing rows.
3. Inspect Accounts and Quota in `/antigravity`; a new login does not prove entitlement or reset server-side limits.

</details>

**What to report:**

If you're seeing unusual rate limit behavior, please share in a [GitHub issue](https://github.com/cortexkit/antigravity-auth/issues):
- Status codes from debug logs (403, 429, etc.)
- How long the rate-limit state persists
- Number of accounts and selection strategy used

---

## Infinite `.tmp` Files Created

Stop every process/timer using the pool and inspect the reported error before touching temporary files. Do not remove migration, transfer, or custody artifacts while diagnosing a failed operation. Rate-limit recovery should use account/quota actions or wait for reset, not delete store evidence.

---

## Safari OAuth Callback Fails (macOS)

**Symptoms:**
- "fail to authorize" after successful Google login
- Safari shows "Safari can't open the page" or connection refused

**Cause:** Safari's "HTTPS-Only Mode" blocks the `http://localhost` callback URL.

**Solutions:**

1. **Use a different browser** (easiest):
   Copy the URL from `opencode auth login` and paste it into Chrome or Firefox.

2. **Temporarily disable HTTPS-Only Mode:**
   - Safari > Settings (⌘,) > Privacy
   - Uncheck "Enable HTTPS-Only Mode"
   - Run `opencode auth login`
   - Re-enable after authentication

3. **Manual callback extraction** (advanced):
   - When Safari shows the error, the address bar contains `?code=...&scope=...`
   - See [issue #119](https://github.com/cortexkit/antigravity-auth/issues/119) for manual auth support

---

## Port Already in Use

If OAuth fails with "Address already in use":

**macOS / Linux:**
```bash
lsof -i :51121
kill -9 <PID>
opencode auth login
```

**Windows:**
```powershell
netstat -ano | findstr :51121
taskkill /PID <PID> /F
opencode auth login
```

---

## WSL2 / Docker / Remote Development

The OAuth callback requires the browser to reach `localhost` on the machine running OpenCode.

<details>
<summary><b>WSL2</b></summary>

- Use VS Code's port forwarding, or
- Configure Windows → WSL port forwarding

</details>

<details>
<summary><b>SSH / Remote</b></summary>

```bash
ssh -L 51121:localhost:51121 user@remote
```

</details>

<details>
<summary><b>Docker / Containers</b></summary>

- OAuth with localhost redirect doesn't work in containers
- Wait 30s for manual URL flow, or use SSH port forwarding

</details>

---

## Migrating Accounts Between Machines

A migrated pool is not one legacy JSON file. Do not copy only `antigravity-accounts.json` or manually splice generations. A general cross-machine store-transfer procedure is not established; prefer explicit initialization and re-login on the destination or approved vault enrollment. [Offline rollback](MIGRATION.md) is a downgrade operation, not a generic backup restore.

---

## Plugin Compatibility Issues

### @tarquinen/opencode-dcp

DCP creates synthetic assistant messages that lack thinking blocks. **List this plugin BEFORE DCP:**

```json
{
  "plugin": [
    "opencode-antigravity-auth@latest",
    "@tarquinen/opencode-dcp@latest"
  ]
}
```

### oh-my-opencode

Disable built-in auth:
```json
{
  "google_auth": false
}
```

When spawning parallel subagents, multiple processes may hit the same account. **Workaround:** Enable `pid_offset_enabled: true` or add more accounts.

### Other gemini-auth plugins

You don't need them. This plugin handles all Google OAuth.

---

## Migration Guides

### Claude 5.5 (3.0.1)

Replace saved Claude 4.6 selections with `antigravity-claude-opus-5-5` or
`antigravity-claude-sonnet-5-5`. Retired 4.6 requests refuse locally rather than
redirecting to another model. Use low, medium or high adaptive effort:

```json
{
  "antigravity-claude-opus-5-5": {
    "variants": {
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

Older `max` and custom Claude thinking-budget examples do not define supported
5.5 efforts. See [Model Variants](MODEL-VARIANTS.md) for current selectors and
[migration and rollback](MIGRATION.md) for offline account migration.

---

## Debugging

Enable debug logging:
```json
{
  "debug": true,
  "debug_tui": true
}
```

Logs are in `~/.local/state/cortexkit/antigravity-auth/logs/`, unless `OPENCODE_ANTIGRAVITY_LOG_DIR` or `log_dir` names another folder. Older versions wrote them to `~/.config/opencode/antigravity-logs/`; you can delete that folder.

---

## "antigravity-auth cannot start" after an upgrade

The plugin moves its vault files out of OpenCode's config folder once, and refuses to serve any accounts while it cannot tell where they are. The message says which case you hit and what to do; the cases are listed under [refusals and recovery](CONFIGURATION.md#refusals-and-recovery). Close every OpenCode before upgrading so the move never races an older one.

---

## E2E Testing

The plugin includes regression tests (consume API quota):

```bash
npx tsx script/test-regression.ts --sanity      # 7 tests, ~5 min
npx tsx script/test-regression.ts --heavy       # 4 tests, ~30 min
npx tsx script/test-regression.ts --dry-run     # List tests
```

---

## Still stuck?

Open an issue on [GitHub](https://github.com/cortexkit/antigravity-auth/issues).
