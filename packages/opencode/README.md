# `@cortexkit/opencode-antigravity-auth`

One package for OpenCode 1.x (V1) and OpenCode 2.x general availability (GA), with server and terminal user interface (TUI) entries. Use Google sign-in for the Antigravity model catalog, a local account pool with rotation and quota limits, and the `/antigravity` menu/sidebar. The bundled `antigravity-auth` CLI provides account and quota commands; read its [standalone login pool-replacement behavior](docs/COMMANDS.md#standalone-cli) before using it with an existing pool.

> Using this plugin or any proxy for Antigravity violates Google's Terms of Service. Account holders have reported suspensions, bans, and shadow-bans. The project is not endorsed by Google; use it at your own risk. Never include credentials, account files, or raw request/response dumps in Git or support reports.

This guide describes the current source tree, not an announcement that an unreleased version is available on npm. See the [project overview](../../README.md) and [current models and evidence caveats](docs/MODEL-VARIANTS.md): Gemini 4 Argon's MEDIUM/HIGH thinking levels and toolConfig omission remain unverified live.

## Host requirements and entries

OpenCode 1 from 1.18.4 (the first release with OpenTUI 0.4.5), or OpenCode 2 from 2.0.22.

| Host field | Required range |
| --- | --- |
| OpenCode engine | `>=1.18.4 <2` or `>=2.0.22` |
| V1 SDK peer (`@opencode-ai/plugin`) | `*` (checkout pin `1.17.13`) |
| GA SDK peer (`@opencode/plugin`) | `>=2.0.22` (checkout pin `2.0.22`) |
| OpenTUI core/keymap/solid peers | `>=0.4.5` each |
| `solid-js` peer | `>=1.9.0` |
| Node | `>=20` |

Peers are optional in the [manifest](package.json) because each host uses its matching runtime. The checkout pins V1 OpenTUI `0.4.5` and GA OpenTUI `0.5.14`; declared peer ranges alone do not establish that every host/runtime combination has been tested or works.

- `.` → `dist/index.js`, the legacy V1 root.
- `./server` → `dist/server.js`, the hybrid V1/GA server.
- `./tui` → [`src/tui/entry.mjs`](src/tui/entry.mjs), the V1/GA TUI dispatcher.

Top-level [`server.js`](server.js) and [`tui.js`](tui.js) forward directory-based loading to the public entries. There is no separate OpenCode 2 adapter package. Register the complete package, not a copy of `dist/` alone.

## Installation

Quit all OpenCode and Pi processes, then run:

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Read [guided setup](docs/CONFIGURATION.md#guided-setup) for explicit host selection, local versus approved-vault mode, dry-run, and bounded real-run metadata effects. Setup does not bypass stopped-host checks or complete OpenCode 2's native connection. See [migration and rollback](docs/MIGRATION.md) before upgrading an existing pool; a version pin alone is not an automatic-update hold.

- **OpenCode 1:** follow [V1 registration and login](docs/CONFIGURATION.md#opencode-1-manual-registration).
- **OpenCode 2:** follow [pool browser login](docs/OPENCODE-2.md#pool-browser-login), then select the saved **Antigravity** connection. Ordinary real Google keys/native credentials pass through unchanged.
- **Vault:** use the [approved vault method and custody guide](docs/VAULT.md); do not use vault activation for local pool mode.

After starting the host, open `/antigravity` for account, quota, routing, limits, diagnostics, and vault actions. Available actions depend on the active credential source. [Commands](docs/COMMANDS.md) covers the menu and standalone CLI.

## Contributor build and TUI

From the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
bun run build
bun run --cwd packages/opencode smoke:tui
```

Use **Bun 1.4.2** for TUI regeneration: `bun run --cwd packages/opencode build:tui`. The public loader selects `src/tui-compiled/tui.js` or the raw fallback `src/tui-raw/tui.tsx` for V1; OpenCode 2 has separate compiled/raw trees. Runtime support is probed before selection; unrelated import errors propagate. The private compiler and input archive are repository-only, never shipped.

`smoke:tui` installs fresh tarballs in a scratch consumer and checks resolution and renderer startup. It does not prove login, provider activation, or request serving in a real OpenCode host. Use an isolated host config/database for source work so test runs cannot change your usual accounts or conversations. See [development and release](docs/DEVELOPMENT.md) for the complete gates.

## Documentation

- [Configuration and manual installation](docs/CONFIGURATION.md)
- [Accounts, routing, quota, and storage](docs/MULTI-ACCOUNT.md)
- [Models and thinking variants](docs/MODEL-VARIANTS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Claustrum vault](docs/VAULT.md)
- [Menu and CLI commands](docs/COMMANDS.md)
- [OpenCode 2](docs/OPENCODE-2.md)
- [Migration and rollback](docs/MIGRATION.md)
- [Development and release](docs/DEVELOPMENT.md)
- [Architecture](ARCHITECTURE.md), [structure](STRUCTURE.md), and [internal architecture guide](docs/ARCHITECTURE.md)
- [Antigravity API reference](docs/ANTIGRAVITY_API_SPEC.md) and [JSON Schema](assets/antigravity.schema.json)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
