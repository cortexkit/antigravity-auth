# Released 0.14.2 canonical producer

The preparation was retargeted in place; directory names retain the original
source fence. Earlier receipts and failed setup records remain historical.

These acceptance sources cover the byte-verified released 0.14.2 producer.
They do not authorize vault access, enrollment or network acquisition. Historical
source-only and failed startup records remain in research; current executable
results are recorded separately rather than relabeling those records as passes.

`publication.json` freezes the selected genuine publication's public roots and 156
payload identities (822,249 bytes). `closure.json` records every static import
and re-export specifier of those payloads, including nonlocal imports. Omitted
files in its `imports` object have no such edges. Relative references from
declarations resolve to `.d.ts`, not to runtime `.js` counterparts. Routing and
quota runtime/declaration roots are selected for shared request/manager adapters.
Public commands and auth-menu are selected for server/Pi single-menu composition.
The Pi credential-slot helper is selected for server-side composition only.
Its five reachable files remain selected. The 0.14.2 archive additionally reaches
`util/any-signal.js` through Claustrum's consumer, and updates that consumer and
the login runtime/declaration. All other selected payloads retain their 0.14.1
bytes. The internal declaration `pi-slot/lock.d.ts` is not reachable from a
selected public entry, so it is omitted from the embedded closure.
No SDK declaration substitutes are copied.

`closure.test.ts` reads archive payloads as data rather than importing them.
It checks genuine manifest roots, independently recorded edges, exact graph
reachability, the original 24 payload comparison, byte-for-byte owned generation,
map provenance, and symlink refusal. Its boundary check watches the generator's
source, not a subprocess trace; it cannot certify absence of OS-level host or
network access. That check and the slim-runtime guard need named mutation
controls after execution is admitted. Nothing here claims a mutation pass.

The build-only multi-output contract also emits the same archive's exact 129-file
core subset (696,000 bytes). See `research/common-auth-0113-producer-preparation/EMITTER-CONTRACT.md`.
Public commands runtime eagerly reaches credential/store modules and logger fs;
TUI uses erased public menu types and a nonsecret serialized model only. Pi may
call the genuine `runPiCommandMenu(menu, ui)` from server-side composition.

The slim **runtime** closure is `rpc/client.js`, `rpc/port-file.js`,
`rpc/rpc-client.js`, and `tui/index.js`. The unchanged publisher declarations
contain a type-only cycle from `rpc/port-file.d.ts` to `rpc/index.d.ts`, which
reaches server declarations. This is explicitly witnessed, not hidden by a
count-only assertion or a modified payload. The TUI selector dynamically probes
the encoded OpenTUI Solid runtime module and loads caller-supplied entries;
those entry graphs require the separately admitted private build.

The public `./claustrum` root statically imports and re-exports
`@cortexkit/claustrum-client`. Its genuine manifest peer floor is `>=0.6.2`
(optional for unrelated roots, required when this root is evaluated). The parent
owns that intake and its transitive closure. These tests do not evaluate any
vault, account-store, filesystem API, SDK or provider module. A declaration check
requires genuine client types; it must not be unblocked with a shim.

After separately admitted input materialization, the first package-contained
gates proposed for review are:

```
node_modules/.bin/tsc --version
node_modules/.bin/tsc -p test/common-auth-0113-producer/tsconfig.source.json
bun --version
bun test --config=test/common-auth-0113-producer/bunfig.toml --isolate test/common-auth-0113-producer/closure.test.ts
```

Their cwd, environment, prerequisites, writable bounds and time limits are in
`research/common-auth-0113-producer-preparation/UPGRADE-PLAN.json`.
The explicit empty test preload avoids the root OpenTUI preload and provider
setup; its behavior must be admitted separately rather than inferred from a
source file.
The legacy acceptance directory remains active for existing archive guards, exclusive path
admission and compiler cleanup. Its historical oracle and mutation classification
predicates are retained, while its active producer identity expectations move
to the current released producer. Docker/hygiene and mutation results must be
recorded from real provisioned runs; historical records do not establish a pass.
