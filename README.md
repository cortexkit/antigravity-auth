# Antigravity Auth

Use Google Antigravity from OpenCode 1, OpenCode 2, or the Pi coding agent. Sign in with Google to use Antigravity quota for Gemini, Claude, and GPT-OSS models, rather than supplying a pay-as-you-go Google API key.

The host packages are [`@cortexkit/opencode-antigravity-auth`](packages/opencode) and [`@cortexkit/pi-antigravity-auth`](packages/pi). Both use the shared [`@cortexkit/antigravity-auth-core`](packages/core) library.

## Why use it

- An Antigravity model catalog with supported thinking variants.
- A shared OpenCode account pool—Google accounts added to the plugin—with rotation, quota, cooldowns, and limits.
- An `/antigravity` menu and OpenCode sidebar for account and quota management.
- An approved Claustrum vault can supply credentials instead of local logins.
- A bundled `antigravity-auth` command-line interface for login, account listing, and quota checks.

Pi local mode uses Pi's native Google login, not the OpenCode account pool.

Gemini 4 Hydrogen is supported on all three hosts with low, medium, high
(default), and xhigh thinking levels. It requires a Pro or Ultra subscription
in Google Antigravity. Low and XHigh request shapes are pinned to the native
CLI; Medium/High are inferred, and server acceptance remains unverified.

## Disclaimer

Using this software, or any proxy for Antigravity, violates Google's Terms of Service. Google account holders have reported suspensions, bans, and shadow-bans (restrictions without notice). This project is not endorsed by Google or the model providers. You are responsible for compliance with provider terms and use it at your own legal, financial, and technical risk.

Never share OAuth tokens, browser cookies, account files, bearer tokens, or raw request/response dumps in Git, issues, or chat.

## Install

Quit all OpenCode and Pi processes, then run:

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Setup detects installed hosts and configures the plugin for local Google sign-in or optional, operator-approved Claustrum vault enrollment. Review the [setup and configuration guide](packages/opencode/docs/CONFIGURATION.md#guided-setup), including stopped-host checks and dry-run behavior.

<a id="major-upgrades-migration-and-rollback"></a>

Before any major plugin upgrade, disable automatic updates. Unmigrated OpenCode account files from the plugin's 2.x releases require the [offline migration and rollback procedure](packages/opencode/docs/MIGRATION.md).

OpenCode 2: sign in with Google (antigravity-auth pool, browser), then select the saved Antigravity connection to use the plugin's accounts; requests carrying a real Google key or native login credential pass through unchanged.

After setup, run `opencode auth login` → Google and choose **Google (antigravity-auth pool, browser)** as the login method; afterward, select the saved connection labeled **Antigravity**. Setup does not perform this OpenCode 2 login. For approved vault mode, choose **Use approved Antigravity vault** instead. After starting the configured host, open `/antigravity` in OpenCode or Pi for accounts, quota, and vault actions.

## Documentation

| Guide | Contents |
| --- | --- |
| [Configuration and manual installation](packages/opencode/docs/CONFIGURATION.md) | Guided setup, host-specific registration, options, state paths, and credential safety |
| [Accounts, routing, and quota](packages/opencode/docs/MULTI-ACCOUNT.md) | Shared pool, account selection, cooldowns, quota thresholds, and limits |
| [Models and thinking variants](packages/opencode/docs/MODEL-VARIANTS.md) | Current model families, retired routes, and capture limitations |
| [Troubleshooting](packages/opencode/docs/TROUBLESHOOTING.md) | Callback, credential, transport, and TUI recovery |
| [Claustrum vault](packages/opencode/docs/VAULT.md) | Enrollment, custody, activation, and safe disconnection |
| [Commands](packages/opencode/docs/COMMANDS.md) | `/antigravity`, standalone CLI, and Pi login |
| [OpenCode 2](packages/opencode/docs/OPENCODE-2.md) | Pool browser login, saved connections, and request ownership |
| [Migration and rollback](packages/opencode/docs/MIGRATION.md) | Offline upgrade/downgrade and auto-update precautions |
| [Development and release](packages/opencode/docs/DEVELOPMENT.md) | Build, test, package, and release workflow |

For implementation details, see [Architecture](ARCHITECTURE.md), [Codebase structure](STRUCTURE.md), and the [OpenCode changelog](packages/opencode/CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
