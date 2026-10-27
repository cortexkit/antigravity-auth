# Claustrum vault custody

Vault custody uses approved Claustrum credentials instead of the local OpenCode pool or Pi's native Google login. Enrollment authority is the freshly read choice between local and approved vault operation; do not hand-edit mode files, copy credentials, or overwrite a host slot to bypass a refusal.

## Enroll and activate

Use `/antigravity` → Vault to request enrollment, choose approved accounts, or disconnect. Alternatively, [guided setup](CONFIGURATION.md#guided-setup) can request enrollment with `--claustrum`. The running vault's operator approves the request using the request ID and `ck auth enroll approve` command printed by setup. `--yes` does not grant approval. `--no-claustrum` selects local setup instead.

Activation is host-specific:

- **OpenCode 1:** a saved Google auth entry is the host's prerequisite for loading the provider. Once loaded, approved enrollment supplies vault credentials without reading, validating, or refreshing that dormant entry. Existing ordinary Google logins and placeholders from other enrollments remain unchanged. Explicit fresh activation refuses to overwrite an occupied Google slot or an unreadable native auth file.
- **OpenCode 2:** after approval, run `opencode auth login` → Google → **Use approved Antigravity vault** (`antigravity-vault`), then select the saved **Antigravity** connection. This is a login method distinct from **Google (antigravity-auth pool, browser)**, which adds local pool accounts. Request ownership means which outgoing requests the adapter handles: it checks the host-prepared Google placeholder, not connection metadata or a marker unique to one enrollment. See the [marker-only request boundary](OPENCODE-2.md#request-ownership-marker-only-support-boundary).
- **Pi:** custody saves the native Google login in a private backup and replaces the native Google slot with a non-secret marker for the enrollment. Pi requires that marker for vault streams. Startup or slot conflicts refuse rather than silently using ordinary local credentials.

OpenCode 1 leaves an existing saved Google login unused while vault credentials serve. OpenCode 2 instead checks each outgoing request for the placeholder before handling it. Pi checks its native Google-slot custody marker. These are different contracts; do not transplant one host's rules into another.

## Source selection and credential exclusion

Local OpenCode authority uses the initialized/migrated shared account repository. Approved vault authority uses vault-served accounts and fresh per-send grants, excluding the local pool. Unreadable authority, unavailable enrollment, or unavailable vault credentials do not permit local fallback. Local OAuth, local quota polling, and proactive local refresh are not vault fallback work.

Pi local mode uses one native Google credential rather than OpenCode pool rotation. Pi vault mode lists/selects approved accounts one at a time; it does not provide local rotation, recorded quota gating, killswitch, or operator settings.

Renderer snapshots and command responses must exclude refresh/access tokens, project IDs, fingerprints, and other credential-shaped data. Keep enrollment/custody files and saved native logins private. Logs and wire dumps may contain sensitive request/response data; see [security and redaction](CONFIGURATION.md#security-and-redaction).

## Preflight is not activation authority

Real-run setup preflight runs **only after the stopped-host check**; all OpenCode and Pi processes must be stopped so credential inspection does not race a running host. Unchanged public readers may create missing owned auth/state parents, acquire/release Pi-specific native-slot or stash locks, and tighten Windows auth, saved-login-stash, and authority-file DACLs (access permissions) to owner-only. `PrivateFileMigration` warnings report repairs to existing Windows file permissions and remain visible.

Those metadata effects never change file contents, ownership, permissions on existing ancestors, account authority, or configuration. `enterVault` and each operation's fresh authority/slot checks remain authoritative; preflight is advisory, not a reusable permission to mutate credentials. A changed native slot, revoked enrollment, or inconsistent saved backup must still refuse. **Dry-run invokes none of these readers, locks, or repairs and writes nothing.**

Pi's native folder follows `PI_CODING_AGENT_DIR` (including `~` expansion), or `~/.pi/agent`. `PI_AGENT_DIR` and `PI_ANTIGRAVITY_AUTH_FILE` retain plugin account/vault-state roles and do not redirect the native login. See [setup](CONFIGURATION.md#guided-setup).

## Where the vault files live

OpenCode's vault files (`antigravity-auth-vault/`: enrollment token and state, vault roster, vault provider state and mode) live in the plugin's runtime folder, `~/.local/state/cortexkit/antigravity-auth/opencode/` (`opencode-<16 hex>/` for a config folder other than `~/.config/opencode`), not in OpenCode's config folder. Versions before the move kept them beside `antigravity-accounts.json`; the first start after every OpenCode using that config folder has restarted on a newer version moves them, and an approved enrollment survives the move without enrolling again. The local account store does not move: it stays in OpenCode's config folder, and moving it is planned for a later release. Close every OpenCode before upgrading. See [where the files live](CONFIGURATION.md#where-the-files-live) for the move, its refusals and how to downgrade.

## Disconnect and change builds safely

Disconnect through `/antigravity` → Vault in the currently installed plugin/extension before changing builds. Restoration is conditional: it must not overwrite a native login changed by another process, and conflicting saved custody state refuses. Re-login may be needed; no complete restoration of all native host records is promised.

[Migration and rollback](MIGRATION.md) manage local OpenCode account storage; they do not migrate vault credentials, restore native Google records, or migrate Pi's native auth file. Do not delete enrollment/custody state or saved native-login backups as a generic reset.

Implementation references: [OpenCode custody](../src/plugin/vault-custody.ts), [OpenCode 1 auth loader](../src/plugin/auth-loader.ts), [activation](../src/plugin/vault-activation.ts), and [Pi guide](../../pi/README.md).
