# Immutable common-auth input and private compiler

The embedding script reads only the tracked
`tools/common-auth-build/inputs/cortexkit-common-auth-0.11.4.tgz`. It checks both
compressed-archive pins before decoding headers, checks publication identity,
exports, license, inventory and selected-file hashes in memory, then replaces
the canonical output. `--check` refuses missing, stale or extra output instead
of writing. No acquisition or producer-byte transformation is performed.

```sh
bun packages/opencode/scripts/embed-common-auth.ts
bun packages/opencode/scripts/embed-common-auth.ts --check
```

Private compiler dependencies must be provisioned separately. The tool package
is not a workspace and requires Bun 1.4.2:

```sh
bun install --cwd tools/common-auth-build --offline --frozen-lockfile
```

`build.mjs` accepts absolute `--package-root`, `--entry`, `--raw-dir`,
`--runtime-dir` and optional `--map` paths. It calls the published `buildTui`
twice with `inline: []`, calls public `loadSolidTransform` for the runtime tree,
and checks both actual npm publish inventories with `assertEmittedPublishList`.
The package's files list must cover both generated trees. Before loading the
compiler, the helper resolves the admitted package root and source entry and
checks existing output ancestors. A symlink package root is supported; links
below that root are not admitted as output ownership. Map hardlinks, nonregular
targets and files without the generated-map format are refused; a repeated build
may replace its prior generated map. Admission refusals do not write or clean up anything. Once paths are
admitted, compiler failures remove only the prevalidated physical destinations.
These are static alias checks, not protection against concurrent filesystem
changes. The returned/written map contains separate raw/runtime source-output
records and externals. The public compiler API owns import-graph traversal; the wrapper does not duplicate it.

Run the acceptance cases with a provisioned dependency cache and a local Docker
daemon. The Docker witness builds a scratch image without pulls or network,
copies its context contents out of a never-started container, then removes both.
The test preload isolates HOME; `COMMON_AUTH_BUN_CACHE` can name the provisioned
Bun cache. With a conventional Bun installation its default is the cache next
to Bun's installation, not the isolated test HOME.

```sh
bun test --isolate test/common-auth-094-adoption/embed-build/
node_modules/.bin/tsc -p test/common-auth-094-adoption/embed-build/tsconfig.declarations.json
bun test/common-auth-094-adoption/embed-build/mutation-proof.mjs
bun test/common-auth-094-adoption/embed-build/path-mutation-proof.mjs
bun test/common-auth-094-adoption/embed-build/record-mutation-proof.mjs
```

`publication.json` retains the historical 0.9.4 publication oracle (24 paths).
The active acceptance sources use the independently frozen
`test/common-auth-0113-producer/publication.json` (134 paths, byte lengths and
hashes), not a projection of generated output. Five RPC files change
among the original 24 paths; four are new client/port-file changes in 0.11.4,
and the server stop-order fix is retained from 0.11.3. Historical mutation records remain historical;
none are evidence for an unexecuted producer upgrade.
`archive-fixtures.json` contains independently Python/USTAR-generated gzip
fixtures and whole compressed SHA256/SHA512 pins. They exercise archive guards
without changing the production pin. The mutation runner stages an owned
disposable copy, records original hashes and nonempty diffstats, requires the
intended-only named failure and passes for the other six tests in the seven-case embedding suite, restores saved bytes,
checks original hashes and empty unstaged diff, and finishes with a fresh green
run. It never changes the live input, index or canonical tree.
The alias runner independently installs the private compiler in an owned copy
and witnesses source/foreign sentinel changes when admission is neutralized.
The record-parser runner uses only pure-data controls. Both runners require
actual line-anchored Bun records and the exact distinct unaffected-name
complement; diagnostic snippets, incomplete/foreign/duplicate records and
process or reporter errors cannot be classified as a reached named red.

The initial source proposal did not materialize outputs or execute these commands.
The subsequent finish release admits exact input/output materialization, private
offline installation and targeted gates. Retained historical records are not
rewritten as current passes. See
`research/common-auth-0113-producer-preparation/UPGRADE-PLAN.json` for the held
gate boundaries. The declaration check additionally needs the genuine
`@cortexkit/claustrum-client >=0.6.2` intake; no local declaration substitute is
provided.
