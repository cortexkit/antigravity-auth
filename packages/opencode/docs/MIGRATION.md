# Migration and rollback

This guide describes the current source tree, not a claim that an unreleased major version is available on npm. Use `antigravity-auth` from the **build you are upgrading to**, whose `--help` lists `init`, `migrate`, and `rollback`. An older installed CLI may not implement them. Below, “new CLI” means that build's CLI.

## Hold automatic updates before a major upgrade

Set the top-level `auto_update` field to `false` in the effective `antigravity.json`, merging it into existing settings. Check each project's `.opencode/antigravity.json` too: project settings override the user config and must not set it back to `true`:

```json
{
  "auto_update": false
}
```

The published v2.2.1 default is `true`; its update check on host restart can advance pinned plugin configs across major versions. **A version specifier alone is not an update hold.** This disables the existing automatic config update, not the required offline migration. See the [v2.2.1 updater](https://github.com/cortexkit/antigravity-auth/blob/v2.2.1/packages/opencode/src/hooks/auto-update-checker/index.ts) and [schema](https://github.com/cortexkit/antigravity-auth/blob/v2.2.1/packages/opencode/src/plugin/config/schema.ts).

## Initialize or migrate before starting the host

The local OpenCode pool uses a shared account store. `antigravity-accounts.json.store.pointer.json` selects the active generation directory containing `config.json` and `state.json`; legacy `antigravity-accounts.json` is no longer the active writer target. The store now moves from OpenCode's config folder to the state-home runtime folder once every OpenCode using it has closed or restarted on this version. Both OpenCode host generations share that repository, not one pool per project. See [where the files live](CONFIGURATION.md#where-the-files-live) for the wait, linked state folders and the kept old store.

- **Fresh installation:** run `antigravity-auth init` before CLI/OpenCode 1 login. Initialization refuses an existing legacy pool; migrate it instead. Standalone `login` starts or replaces the pool; use setup login or the host account menu to add accounts, as explained in [commands](COMMANDS.md#standalone-cli). OpenCode 2's pool browser method can initialize a truly fresh store during login; it refuses a pending legacy migration.
- **Upgrade an existing legacy pool:** stop **every OpenCode and Antigravity process and timer** using the pool, then run `antigravity-auth migrate --offline`. Type `yes` at the stopped-process confirmation prompt. Optional `--yes` skips the prompt but does not make concurrent use safe.
- **Downgrade to a version before the shared store (2.x):** stop every pool user again, move the store back as described below if it has relocated, then run `antigravity-auth rollback --offline` with the **new CLI**, confirm and wait for success, then install/start the older build. Never run old and new builds concurrently.

## Move back before downgrading

Going back to **3.0.16 needs no account-store step**: it reads a moved store. Before installing 3.0.15 or earlier, close every OpenCode and run `antigravity-auth store relocate --back --offline` on the current version. The command restores the original config-folder pointer and **replaces the kept pre-move backup with your current accounts**. Keep the old generation until it finishes. A later upgrade respects the move back; `antigravity-auth store relocate --offline` moves it to the state folder again.

**Never delete or edit `antigravity-accounts.json.store.pointer.json` in OpenCode's config folder.** It forwards to the moved store and keeps older versions from starting with no accounts or creating a separate store at login. If an older version refuses with `pointer has unknown fields`, reinstall the current version, run the move-back command with every OpenCode closed, then downgrade. See [downgrading](CONFIGURATION.md#downgrading) for the separate vault-file steps.

## Rollback exports current credentials

Offline rollback exports **current credentials and metadata** from the active generation into legacy V4 JSON. It does not restore tokens from the original backup. Rollback captures account row IDs and exported data—refresh credentials, metadata, and any exported quota/routing state—as private transaction data, then rechecks the row IDs and exported data during verification and before restoration. This is implementation-generated data, not a user-editable snapshot input. Rollback refuses an existing/recreated legacy file, changes to the captured row IDs/exported data, or invalid transaction data. Do not manually restore an old account-file backup or recreate the legacy pool. On a refusal, leave hosts stopped and resolve the reported conflict.

Keep the store pointer file, the generation directories containing account configuration and state, the migration journal, protected backups, and transfer files private: store and migration data can contain account credentials and metadata. Do not delete them as a generic reset or manually splice generations into another profile. A general cross-machine store transfer procedure is not established here; prefer explicit fresh initialization and re-login on the destination, or [enrollment approved by the Claustrum vault operator](VAULT.md#enroll-and-activate).

## Host activation and vault custody are separate

Migration and rollback manage the **local OpenCode pool**, not the native Google auth slot used to activate a provider or approved credentials held by the vault. Before changing builds, disconnect vault enrollment via `/antigravity` → Vault in the currently installed plugin/extension. Re-login if native credentials cannot be safely restored; complete restoration of native host records is not promised. See [vault custody](VAULT.md).

For OpenCode 2, finish the [native login and saved-connection selection](OPENCODE-2.md#pool-browser-login). OpenCode 1's `auth.json` slot does not complete that step.

Pi's native auth file is **not** the OpenCode pool: **Pi-only users must not run these migration commands on it.** Change old `google-antigravity/…` model selections to `google/…` and run `/login google`; old credential slots are not automatically moved or overwritten. See [Pi's upgrade notes](../../pi/README.md#major-upgrades-and-downgrade).

## Implementation references

- [CLI options and stopped-process confirmation](../src/cli.ts)
- [Current-credential export and refusal checks](../../core/src/account-migration.ts)
- [Configuration and setup](CONFIGURATION.md), [account storage](MULTI-ACCOUNT.md#account-storage), and [recovery](TROUBLESHOOTING.md)
