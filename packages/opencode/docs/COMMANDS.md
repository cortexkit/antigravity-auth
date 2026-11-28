# Commands

## `/antigravity` menu

Open `/antigravity` in the configured OpenCode or Pi host. It opens a shared menu rather than accepting the old per-feature slash commands or their arguments. Sections and actions depend on the host and active credential source.

| Section | OpenCode 1 and 2 | Pi |
| --- | --- | --- |
| Accounts | Local pool: enable or disable an account, pin it for model families, remove it, set its quota floor, edit **Models**, or **Clear limits**. OpenCode 2 also offers **Add account** and **Reauthorize** here. Vault: **Clear limits** and **Models**, not local sign-in or removal. | Local: explains use of Pi's native Google slot. Vault: **Models** for vault accounts when model-list editing is available. |
| Quota | Inspect readings and use **Check quota now** when available. | Explains that Pi does not record or check quota. |
| Routing | Inspect the effective account selection strategy; account choices are under Accounts. | Inspect the active credential source or selected vault account. No rotation. |
| Limits | **Change limits** controls the quota killswitch and minimum remaining percent; per-account floors are under Accounts in local mode. | Explains that Pi does not apply quota floors or the killswitch. |
| Diagnostics | Adjust log level and wire-dump capture; dismiss a settings move report when shown. Treat dumps as sensitive. | Not present. |
| Sign in | OpenCode 1 local mode: **Start sign-in** and **Finish sign-in**. OpenCode 2 adds accounts from Accounts. | Not present; use `/login google` and `/logout` instead. |
| Vault | Request access, check approval, activate custody, or disconnect as allowed. Thalamus owns the connection when hosted. | Select or turn off vault accounts, request access, activate custody, or disconnect as allowed. In Thalamus, account choices remain available but there are no enrollment or disconnect actions. |

Both OpenCode generations expose the [shared account menu](../../core/src/antigravity-command-menu.ts) through their own terminal UI; account and credential operations run on the server. See [OpenCode 2's menu and sidebar](OPENCODE-2.md#ui-and-evidence-limits) for its host integration.

With vault enrollment actions available, the menus are ordered as follows:

- **OpenCode 1 local:** Accounts → Quota → Routing → Limits → Diagnostics → Sign in → Vault
- **OpenCode 2 local:** Accounts → Quota → Routing → Limits → Diagnostics → Vault
- **Pi:** Accounts → Quota → Routing → Limits → Vault

Actions and sections may be hidden or disabled when the credential source, permissions or settings do not allow them.

## Standalone CLI

The `antigravity-auth` bin ships inside `@cortexkit/opencode-antigravity-auth`; no separate CLI package is needed:

```bash
npx -y @cortexkit/opencode-antigravity-auth --help
npx -y @cortexkit/opencode-antigravity-auth login --no-browser
npx -y @cortexkit/opencode-antigravity-auth list --json
npx -y @cortexkit/opencode-antigravity-auth quota --refresh --json
```

Use the intended build's CLI, especially for initialization, migration, or rollback; an older npm CLI may not implement those operations. The parser accepts:

```text
antigravity-auth setup
antigravity-auth login [--project <id>] [--no-browser]
antigravity-auth list [--json]
antigravity-auth quota [--json] [--refresh]
antigravity-auth init
antigravity-auth migrate --offline [--yes]
antigravity-auth rollback --offline [--yes]
```

- `setup`: [guided host detection/registration and optional vault enrollment](CONFIGURATION.md#guided-setup). See `setup --help` for its options.
- `login`: PKCE and a local callback at `http://localhost:51121/oauth-callback`. `--project <id>` pins the project before login. `--no-browser` prints the URL; headless detection (`SSH_*`, `OPENCODE_HEADLESS=1`) also avoids browser launch. It does not free an occupied callback port. See [remote callback troubleshooting](TROUBLESHOOTING.md#wsl2--docker--remote-development).
- `list`: `INDEX`, `EMAIL`, and `STATUS` (`active`, `disabled`, `ineligible`, or `verification-required`); `--json` emits the same data as JSON.
- `quota`: local accounts only. Shows `ACCOUNT`, `STATUS`, `GROUP`, `REMAINING`, and `RESET`. `--refresh` forces a live reading; `--json` gives an object with an `accounts` array. For vault accounts, use `/antigravity` → Quota.
- `init`, `migrate`, `rollback`: change the active local store. Follow [offline migration and rollback](MIGRATION.md) first; `--yes` skips the prompt, not the stopped-process requirement.

Exit codes are `0` for success, `1` for a thrown error, and `2` for parse failure, including unsupported commands/options. `list` and `quota` do not initialize or migrate account storage.

**Pool replacement, not account addition:** standalone `antigravity-auth login` starts or replaces the local account pool; it does not append an account to an existing pool. Use `/antigravity` → Sign in on OpenCode 1 or Accounts → **Add account** on OpenCode 2 to add a login without replacing the pool. Initialize a fresh store or complete offline migration first; do not recreate the legacy file or delete store files to bypass those requirements.

## Host login routes

- **OpenCode 1:** initialize/migrate the pool, then select **Antigravity (Google OAuth)** from Google provider login, or use `/antigravity` → Sign in.
- **OpenCode 2:** use **Google (antigravity-auth pool, browser)**, then select the saved **Antigravity** connection. For approved vault mode, choose **Use approved Antigravity vault** instead. [The OpenCode 2 guide](OPENCODE-2.md) explains why ordinary native Google credentials do not activate plugin requests.
- **Pi:** `pi install npm:@cortexkit/pi-antigravity-auth`, start `pi`, then `/login google`. Models use `google/antigravity-…`. The extension is discovered via `pi.extensions`; local credentials stay in Pi's native Google slot, not the OpenCode pool. See [Pi's guide](../../pi/README.md) and [vault custody](VAULT.md).

If project lookup fails, local login can use fallback project `rising-fact-p41fc`. For a project permission refusal, enable the Gemini for Google Cloud API on your own project and use `login --project <id>`; do not hand-edit retired pool JSON. Vault accounts require the vault operator's help.
