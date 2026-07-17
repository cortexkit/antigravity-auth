# Antigravity Auth

Google Antigravity OAuth for coding agents. Authenticate with your Google
account and access **Gemini 3**, **Claude 4.6**, and **GPT-OSS 120B** models through
Antigravity's endpoints.

This is a monorepo publishing three packages:

| Package | Description |
| --- | --- |
| [`@cortexkit/opencode-antigravity-auth`](packages/opencode) | OpenCode plugin — intercepts `fetch()` and transforms requests to the Antigravity format. Multi-account rotation, quota handling, session recovery. |
| [`@cortexkit/pi-antigravity-auth`](packages/pi) | pi extension — registers a custom provider with OAuth login and a Gemini streaming implementation. |
| [`@cortexkit/antigravity-auth-core`](packages/core) | Harness-agnostic core: OAuth, raw HTTP/1.1 transport, device fingerprint, request transforms, model registry, managed-project resolution. Shared by both harnesses. |

> [!CAUTION]
> Using this software (and any proxy for Antigravity) violates Google's Terms of
> Service. Accounts may be suspended or banned. This is an unofficial tool not
> endorsed by Google; you assume all risks.

## Installation

**OpenCode** — add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth@latest"]
}
```

See the [OpenCode package README](packages/opencode/README.md) for model
configuration, login, and troubleshooting.

**pi** — install the extension package:

```bash
pi install npm:@cortexkit/pi-antigravity-auth
```

Then `/login google-antigravity`. See the [pi package README](packages/pi/README.md).

## Development

```bash
npm install         # install workspace dependencies
npm run build       # build core, then opencode + pi
npm run typecheck   # typecheck all packages
npm test            # run all package test suites
```

## Releasing

Releases are tag-driven. `scripts/release.sh <version>` runs checks, syncs all
package versions (`scripts/version-sync.mjs`), commits, tags `v<version>`, and
pushes. The `Release` workflow then publishes all three packages to npm via
trusted publishing.

```bash
./scripts/release.sh 1.0.0          # release
./scripts/release.sh 1.0.0 --dry    # preview
```

## License

MIT
