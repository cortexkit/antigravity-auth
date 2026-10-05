# Immutable common-auth input and private compiler

The embedding script reads only the tracked
`tools/common-auth-build/inputs/cortexkit-common-auth-0.9.4.tgz`. It checks both
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
The package's files list must cover both generated trees. It removes both trees
and the requested map on failure. The returned/written map contains separate
raw/runtime source-output records and externals. No private walker exists here.

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
```

`publication.json` contains the independently frozen publication oracle (24
paths, byte lengths and hashes), not a projection of generated output.
`archive-fixtures.json` contains independently Python/USTAR-generated gzip
fixtures and whole compressed SHA256/SHA512 pins. They exercise archive guards
without changing the production pin. The mutation runner stages an owned
disposable copy, records original hashes and nonempty diffstats, requires the
intended-only named failure and six unaffected names, restores saved bytes,
checks original hashes and empty unstaged diff, and finishes with a fresh green
run. It never changes the live input, index or canonical tree.
