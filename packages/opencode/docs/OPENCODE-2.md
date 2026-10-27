# OpenCode 2

The unified `@cortexkit/opencode-antigravity-auth` package supplies both server and terminal user interface (TUI) entries for OpenCode 1 and OpenCode 2. The package declares OpenCode `>=2.0.22` support; the repository's [pinned host input](../../e2e-tests/docker/ga-binary-pin.json) is `2.0.22`. A declared range is not evidence that every later host/runtime combination has been exercised.

## Install and register

Quit all OpenCode and Pi processes, then use the [guided setup](CONFIGURATION.md#guided-setup):

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Setup configures registration but does not complete OpenCode 2's native Google connection. Existing legacy OpenCode pools need [offline migration](MIGRATION.md) before login.

For manual directory registration, the shipped top-level `server.js` and `tui.js` forward to the package's public `./server` and `./tui` entries:

```jsonc
{
  "plugins": ["/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth"]
}
```

The [pinned harness](../../e2e-tests/src/opencode-ga-harness.ts) uses an absolute instrumented wrapper directory with those entries. The directory example follows the shipped forwarders, **not a verified OpenCode 2 npm-installer command**. Direct npm-spec registration and host CLI installation syntax are not established here. Consult the matching host's documentation; do not reuse OpenCode 1's singular `plugin`, `opencode plugin`, or `tui.json` recipe.

Do not copy the harness's synthetic Google key or mock `baseURL` into real configuration. Its default fixture config has no user model map; no copied model-map requirement is established. Models use `google/…`; the plugin supplies the Antigravity catalog.

## Pool browser login

1. Start the configured host and run `opencode auth login`.
2. Select **Google**, then the login method **Google (antigravity-auth pool, browser)** (`antigravity-auth-pool-browser`). If that method is absent, stop and use a plugin build that provides it; a native Google key/login is not a substitute.
3. Complete Google consent. The listener at `http://localhost:51121/oauth-callback` handles the browser callback and PKCE exchange. Only one login can bind that listener at a time. Use the [callback troubleshooting guide](TROUBLESHOOTING.md#port-already-in-use) for an occupied port or remote browser.
4. Select the saved **Antigravity** connection. The browser choice above is a **login method**; Antigravity is the **saved connection label**, not a third method.
5. Open `/antigravity` to inspect Accounts and Quota, then select a supported `google/antigravity-…` model.

Pool login persists credentials in the plugin's local repository before returning a non-secret common-auth Google placeholder to the host. It may initialize a truly fresh store at the location's resolved account path. If an old `antigravity-accounts.json` account file exists without an active shared store, login refuses until that file is [migrated offline](MIGRATION.md#initialize-or-migrate-before-starting-the-host); it does not overwrite or automatically import it. Additional logins must have distinct identities; use the account reauthorization action to replace an existing account's credentials. Local login is allowed only when the current enrollment state permits local credentials, not while approved vault custody is active.

For vault mode, obtain enrollment approval from the person who manages the Claustrum vault (the vault operator), then use the other Google login method, **Use approved Antigravity vault** (`antigravity-vault`). Both methods save under **Antigravity**. The vault method is not local OAuth. See [vault activation and disconnection](VAULT.md).

## Request ownership: marker-only support boundary

The plugin owns a Google request exactly when the **host-prepared `x-goog-api-key`** equals common-auth's public `placeholderSecret('google')` byte-for-byte. Antigravity is the only currently supported producer of that Google placeholder. A hypothetical second producer of the same provider marker is outside the supported composition; the marker does not identify an enrollment or login method.

Ownership is checked before title, model, retirement, or body handling. It does not look up the active connection or allowlist method IDs. Requests carrying a real Google key or native Google OAuth credential pass through untouched: no body read/clone/rewrite, account acquisition, response adaptation, or plugin retry decision. Switching connections after preparation cannot change those outgoing bytes. Existing vault placeholders do not need rewriting or forced reconnection.

For owned content requests, title routing precedes primary model checks; supported primary, compaction, and generate requests use the loopback bridge and shared executor. Owned unsupported/non-content paths or off-catalog models refuse locally instead of sending a placeholder to an external provider. An empty or unavailable pool produces a native error, not fabricated HTTP 200 assistant success or a fallback to an ordinary Google credential. When the freshly read enrollment state selects an approved vault, requests use vault credentials and never fall back to the local pool.

The host retry API identifies the session but not the exact HTTP attempt. The plugin remembers whether each session's latest Google transport was owned (up to 512 entries). If it was owned, the plugin tells OpenCode not to retry the failed request; the plugin's own account rotation and retry handling remain separate. If the latest transport was unowned, or its entry is missing or evicted, OpenCode keeps its normal retry decision. Session cleanup and teardown retire entries. Mixed-ownership concurrency within one session remains a heuristic limitation, not a promise of exact attempt attribution. Response adaptation remains tied to the actual request/bridge record.

## UI and evidence limits

OpenCode 2's sidebar and menu use location-scoped snapshots through native host RPC, not OpenCode 1's sidebar/port-file configuration. The sidebar section draws the same frame as OpenCode 1's (the `▼`/`▶ ANTIGRAVITY` badge with the plugin version, `Quota` and `Routing` headings, one line per account when collapsed) in the host theme's colors, with OpenCode 1's default settings; it does not read `tui-preferences.jsonc`. A click on the badge collapses or expands it, and the choice is kept in the host's plugin storage, so it survives a TUI reload. Credentials, project IDs, and fingerprints do not belong in renderer snapshots or support reports. See [commands](COMMANDS.md) and [credential safety](CONFIGURATION.md#security-and-redaction).

The [released-host contract](opencode2-ga-2.0.22-contract.md) records pinned contracts and proof obligations. Source tests, a packed TUI smoke run, and a native-host run are distinct evidence. A native host using simulated OAuth responses does not prove Google's live OAuth acceptance or account entitlement. Live model verification means sending requests to the actual Antigravity service, not a mock server. This guide does not claim that native gates or live-service verification have run: [Argon MEDIUM/HIGH remain unverified live](MODEL-VARIANTS.md#gemini).
