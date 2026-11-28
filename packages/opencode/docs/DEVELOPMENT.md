# Development and release

This monorepo uses Bun for contribution commands; npm consumers run `npx @cortexkit/opencode-antigravity-auth`. Build core before dependent packages and checks. Source documentation is not an announcement that a major version has been published.

## Build from a checkout

Run from the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
npm run build
npm run typecheck
npm run test
npm run lint
bun run format:check
bun run --cwd packages/opencode smoke:tui
```

The root scripts build core, unified OpenCode, then Pi. TUI builds use the repository-only **Bun 1.4.2** private compiler input; install its frozen lockfile first. `bun run --cwd packages/opencode build:tui` regenerates the separate OpenCode 1 and OpenCode 2 compiled/raw trees selected by the public loader. Copying only `dist/` omits directory forwarders and the TUI entry.

`smoke:tui` installs fresh tarballs in a scratch consumer, checks server/TUI resolution, the packed README contract, and renderer startup. Packed Markdown must not reference removed launchers or generated targets. A passing smoke run is not proof of native host login, Google's live OAuth acceptance or account entitlement, or vault activation.

Use isolated HOME/XDG configuration and an explicit temporary `OPENCODE_DB` for host probes; never use an everyday host profile. Register the complete package using the [OpenCode 1](CONFIGURATION.md#opencode-1-manual-registration) or [OpenCode 2](OPENCODE-2.md#install-and-register) instructions for that host generation.

`bun run dev` is an OpenCode 1 helper: it builds core/OpenCode, links `.opencode/plugins/antigravity-auth.js` to the built `dist/index.js`, and starts watchers. `bun run dev:clean` removes that link. It is not an OpenCode 2 installer or Pi development profile. See [dev.ts](../../../scripts/dev.ts).

Pre-commit [hooks](../../../lefthook.yml) run Biome on changed code/config. CI also runs format and lint gates. Biome does not validate Markdown links.

## Test scopes and evidence

| Scope | Command from repository root | Boundary |
| --- | --- | --- |
| Deterministic source tests | `npm run test` | Isolated selectors in [package.json](../../../package.json); not bare root `bun test` |
| Deterministic black-box E2E | `bun run test:e2e` | Mock Antigravity, plugin/CLI/RPC/TUI flows |
| Packed TUI smoke | `bun run --cwd packages/opencode smoke:tui` | Fresh tarballs and consumer-local renderer resolution |
| Pinned OpenCode 2 smoke | `bun run test:e2e:opencode-v2` | Real host in the standing network-isolated Docker profile |
| Extended OpenCode 2 inventory | `bun run test:e2e:opencode-v2:extended` | Full pinned-host driver inventory |
| Live model inventory | `bun run test:e2e:models` | Real Google infrastructure; opt-in/CI-label gated |
| Cross-model regression | `bun run test:e2e:regression` | Live network, separate from deterministic gates |

The [released-host contract](opencode2-ga-2.0.22-contract.md) describes retained controls and pin/containment requirements. Native evidence must include actual host-run results and the exact tested commit; listing commands, source assertions, or historical packed bytes is not a passing native result. Use the existing Docker or offline-native runner, which checks isolation and process ownership before host execution. No native run is claimed by this guide.

Live model scripts are under `packages/opencode/script/`, using fixtures under `test-fixtures/`. Keep tokens, account files, raw request/response dumps, and internal evidence out of tracked documentation. Model evidence is narrower than complete wire parity: [Argon LOW is captured, MEDIUM/HIGH remain unverified live](MODEL-VARIANTS.md#gemini).

## OpenCode 1 shutdown

OpenCode 1 disposal marks the plugin closing synchronously, aborts/waits for live and retiring requests and refresh shutdown before releasing account managers, then closes signature/session state. Registered sidebar producers stop before queued writes drain; consumers (RPC/logger) stop after the drain. Ordering does not guarantee every attempted write succeeded or the terminal rendered a final snapshot. See [lifecycle.ts](../src/plugin/lifecycle.ts). OpenCode 2 has its own location lifecycle; OpenCode 1 disposal is not an OpenCode 2 host contract.

## Release process

Maintainers supply the chosen semver to [release.sh](../../../scripts/release.sh); `--dry` previews version synchronization without committing/pushing. This is a description, not an instruction to publish during development.

The script enforces semver, refuses a dirty tree, and requires confirmation on a non-`main`/`master` branch. See [RELEASING.md](../../../RELEASING.md) for the two phases: `--prepare` syncs versions and commits only, and the tag phase checks CI, the prepared version, and the recorded gate, then pushes only the tag. [version-sync.mjs](../../../scripts/version-sync.mjs) sets the three publishable package versions and adapter core pins, not every workspace.

The [Release workflow](../../../.github/workflows/release.yml) runs from a tag or explicit dispatch ref. Publishing requires **test**, **rpc-runtime-matrix**, and **windows-migration**. The test job includes embedding, typecheck, build, TUI smoke, source tests, deterministic E2E, OpenCode 2 Docker smoke, format, and lint. The RPC job tests Node.js 20.0.0, Node.js 24.16.0, Bun 1.3.14, and Bun 1.4.2; Windows migration is a separate prerequisite, not covered by a Linux source-test pass.

The publish matrix handles core, unified OpenCode, and Pi serially with package-scoped OIDC/npm Trusted Publishing and provenance. It checks out the selected ref, synchronizes manifests to the requested version, builds, and skips package versions already published. The GitHub Release job generates release notes. [CI](../../../.github/workflows/ci.yml) runs the normal checks on pushes/pull requests; workflow definitions do not certify that a given revision has passed.

Major changes must retain the [auto-update hold, offline migration, and rollback instructions](MIGRATION.md). Do not publish an intermediate composition whose native release gates remain open.
