# common-auth 0.14.2 embedding adoption

The input is the independently qualified published archive recorded in
`PUBLICATION-VERIFICATION.json`. It is not reacquired or requalified here:
251,088 compressed bytes, SHA256
`bf0f0828d155183dec1c29e5277ededd6cbd46e6b839ca696434e477f081216b`.
`CANDIDATE-INTAKE.json` retains the qualification receipt for the byte-identical
decompressed tar. The predecessor archives and the two 0.14.1 reference receipts
are preserved.

The continuation's frozen `archive-closure.json`, active producer
`publication.json`, and `closure.json` were restored only after verifying their
supplied hashes. Counts and file identities come from archive bytes, not from
regenerated embeddings. The selected closure has 156 files / 822,249 bytes;
core's isolated public roots reach 129 files / 696,000 bytes. The additional
reachable runtime payload is `util/any-signal.js`, through Claustrum's consumer.
The slim RPC/TUI runtime closure remains four files and does not include the
OpenCode 2 SDK or Pi slot runtime.

The existing canonical emitter regenerated both fixed profiles. No payload
transformations or authored edits were made inside those generated profiles.
The private toolchain at `tools/common-auth-build` invokes the published
`@cortexkit/common-auth/tui-build` entry; its accepted file dependency, SRI, lock
hash prerequisite and generated-map version admission were retargeted. Existing
0.14.1 maps remain replaceable during upgrades.

## Recorded gates

`evidence/*.json` stores each command's raw stdout, stderr and inner exit status.
Those records were copied from this worker's own tool captures; they are outside
regenerable build output. The Linux runner uses Bun 1.4.2, TypeScript 6.0.3 and
Node v24.21.0. `capture-gates.py` reproduces the command selections and can emit
losslessly compressed records for transporting large diagnostics.

- `narrow.json`: both embedding checks, source and declaration TypeScript
  checks, 77 strict declaration roots (NodeNext/Bundler), and 17/17 producer and
  public-consumer admission tests passed (1,343 assertions).
- `strict.json`: root build and root typecheck passed. Build copied 129 core
  files, emitted 25-file OpenCode 1 and 12-file GA raw/runtime TUI trees, audited
  two bundles and finalized 146 declaration files.
- `strict-initial-map-refusal.json`: initial strict build exposed the missing
  current compiler marker in existing-map admission; that scoped pin omission
  was fixed before the green strict run.
- `fixtures.json`: all 22 legacy embedding/producer fixtures were attempted;
  19 passed. `embed.clean_input` is unavailable because the isolated Linux job
  has no Docker executable. `build.repo_hygiene` and `build.private_toolchain`
  cannot install from that job's absent offline Bun cache. These three are not
  passes and require the parent CI/cache join. The local prepared-cache install
  of the single accepted private file dependency passed with lifecycle scripts
  disabled (`install.json`, `install.stdout`, `install.stderr`).
- `fixtures-initial-count-mismatch.json`: initial fixture run also exposed the
  stale 187-member assertion. It was retargeted to the independently recorded
  189 regular archive members, after which `embed.integrity` passed.
- `boundary-initial.json`: the additional TUI build-suite attempt had 15/21
  passes: two compiler-marker assertions still expected 0.14.1 outside this
  component's authorized file fence; four further failures lacked core build
  artifacts in that isolated Linux job. This original red receipt is retained.
- `boundary.json`: after inheriting updates to exactly the two generated-map
  compiler-version assertions (`build.map_admission_valid_generated` and
  `graph.ga_roots`) from 0.14.1 to published 0.14.2, core build and the boundary
  suite ran in the same isolated Linux job. The final source TypeScript check
  and all 21 boundary tests passed (344 assertions), including runtime/GA graph
  isolation, generated-map admission and pack paths.

Root archive filter/ignore policies were inherited by fast-forwarding the
parent-owned prerequisite commit `2c10862a`; they are not authored component
changes. The two exact compiler assertions in the TUI build suite were inherited
from parent-owned commit `7fe42565` rather than weakened or edited by this
component. No core barrel, Pi stream, V1 lifecycle or auth-loader source changed.
This lane ran no behavior-removal controls. Docker context clean-input and
isolated private-toolchain offline-cache fixture installs still await integrated
CI; retained historical receipts are not current passes.
