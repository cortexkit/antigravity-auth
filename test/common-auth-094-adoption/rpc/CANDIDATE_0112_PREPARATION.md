# Private 0.11.2 candidate comparison — initial preparation record

This initial `.owned/candidate-0112-prep-p0YnCd/` setup is separate from the
corrected four-role preparation. Review found invalid SBPL literal-IP grammar,
shared state roots and empty startup loopback proxy exclusions. Only those setup
inputs were corrected for the technical comparison. `CANDIDATE_0112_ACCEPTANCE.md`
records its results and corrected preparation; this historical invocation must
not be executed.

This is a separate candidate-only comparison. It does not update the production
0.9.4 embedding or replace the original failure receipts: the 0.9.4 stop sequence
left the unfinished-header peer open at the 500 ms close-event guard. The
preserved `1d85fda63ba6faadaf9e797ec30acf016b428a27` diagnostic still records that failure.

## Admission and provenance

Before reading `.cortexkit/parent-inputs/rpc-0112-stop-order-prep-r1/packet-final.json`,
which lists exact input paths/sizes/hashes, its out-of-band SHA256 was checked:
`dfa2b5c0489adc9cfca1e5ea70a884dfaf4b387a49940ad0c3e3aff803d1ad42`.
The preparer then verified all 191 payloads / 1146442 bytes inside
`.cortexkit/parent-inputs/rpc-0112-stop-order-prep-r1/` against that inventory.
The candidate archive SHA256 is
`19331d5b8935d3309e769dec04591d5649dbc3cdafe47f1a0c0b7f12ae393146`;
it was rechecked before reading the already-admitted extracted package, without
parsing or evaluating the archive. All 175 regular package payloads / 805706 bytes
were matched against the independent admission file, with exact path inventory.

The exact server is `candidate/package/dist/rpc/rpc-server.js` within this
packet, not a repository `dist/rpc/rpc-server.js`. The admitted delta is against
the superseded **private 0.11.2** archive
`99323ae4f4ab402d4579c59b32f6f73e8f4561a343887f5cf5f3d7a04369f2b9`:
174 payloads are identical, and only its RPC server stop-order block changes.
This is not a claim that 0.11.2 otherwise equals production 0.9.4. For example,
the packed candidate contains earlier declared-oversize response handling that
is not present in the production server. Git/source association remains the
peer-reported association recorded in admission.json, not an independently
verified source-build claim.

## Public roots and exact fixture glue

The preparation directory is
`test/common-auth-094-adoption/rpc/.owned/candidate-0112-prep-p0YnCd/`.
Its `preparation.receipt` distinguishes package payload hashes from source hashes
of the seventeen behavioral test callbacks and from executable path/hash/version
pins for Node 20.0.0, Node 24.16.0, Bun 1.3.14 and Bun 1.4.2. It also records each interpreter's
environment, argv and bounds; callback hashes do not establish binary provenance.

The package's declared public exports start collection of reachable runtime/declaration files:

| Public export | Packed import target | Synthetic binding |
| --- | --- | --- |
| `@cortexkit/common-auth/rpc` | `dist/rpc/index.js` | `common-auth-embedded/rpc/index.js` |
| `@cortexkit/common-auth/rpc/client` | `dist/rpc/client.js` | `common-auth-embedded/rpc/client.js` |

Static AST traversal from those exports found exactly seven runtime files:
client, index, notifications, port-file, rpc-client, rpc-server and server-registry.
Their only external imports are `node:crypto`, `node:fs/promises`, `node:http`,
`node:net` and `node:path`. The separate public declaration traversal found the
seven corresponding declarations. All fourteen files were copied unchanged
from the admitted package, preserving their relative paths and bytes. No
private-leaf substitution, bare consumer dependency installation, compatibility
facade or host-plugin import is used.

**The candidate archive supplies the public RPC module files copied under the
synthetic `common-auth-embedded/rpc` paths**, not the real production tree.
The original private adapters are transpiled from
immutable `e0426393cfda2e03674ec25cfd1b53256ee9944b` without changing their import
specifiers or executable bodies. Both public namespace reads and adapter imports
therefore resolve to the same synthetic module URLs, preserving class/factory
identity. The source-inspection identity assertion sees the actual unchanged
adapter file, not a proxy inspection view.

`runtime.mjs` is byte-identical to `test/common-auth-094-adoption/rpc/runtime.mjs`
at commit `e0426393cfda2e03674ec25cfd1b53256ee9944b`. Its seventeen callback bodies test RPC
validation, exact-PID discovery, stage ownership, shutdown, timing, notification
shape, module identity, proxy bypass and socket teardown. The copy preserves their
admission/observation order and the 500 ms actual peer-close guard. No loader or
callback rewrite is needed: its existing root-relative public paths resolve to
the candidate public roots in the synthetic tree. The existing two explicit test
variants remain identical in purpose and settings: nonzero idle 1500 ms and apply
deadline 150 ms, while the unchanged base adapter retains 2000/120000/0.

## Four runtime inputs

`runtimes/runtime-admission-final.json` supplies the exact four executable
paths, versions and independently expected hashes. Earlier incomplete
availability paths are historical records, not fallback runtimes. Each executable was only read
and matched to its independently supplied expected hash. No `--version` or other
runtime invocation occurred during preparation.

| Role / required version | Exact executable | Expected SHA256 |
| --- | --- | --- |
| Node20 / v20.0.0 | `.cortexkit/parent-runtimes/node20.0.0/node` inside this checkout | `ddd82d5e23efa1ac08ecae9c6abd7b4459da903d1946b9c9a2568df010a9f534` |
| Node24 / v24.16.0 | `/Users/ufukaltinok/.local/share/mise/installs/node/24.16.0/bin/node` | `1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8` |
| Bun13 / 1.3.14 | `/Users/ufukaltinok/.local/share/mise/installs/bun/1.3.14/bin/bun` | `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233` |
| Bun14 / 1.4.2 | `/Users/ufukaltinok/.bun/bin/bun` | `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5` |

The four role labels select Node 20.0.0, Node 24.16.0, Bun 1.3.14 and Bun 1.4.2
as separate interpreters of the same complete behavioral test script, not different
callback implementations.

Missing executables, missing executable mode or hash mismatch fail setup, with
no fallback. Node 20.0.0 was restored from its official archive and matched to
the binary hash recorded in `runtimes/runtime-admission-final.json` and the table
above. Verification used the HTTPS publisher checksum table, archive and binary,
not publisher signatures. This preparer acquired
nothing and did not mutate global installs, caches or profiles.

## Exact planned argv, isolation and bounds

For each role, the future version-admission argv is `[exactExecutable, '--version']`.
Before a child could run, execution approval and verification of the exact archive,
all copied inputs, the executable hashes and the expected `--version` output were
required. The initial planned child argv was:

```text
/usr/bin/sandbox-exec -p <literal contents of loopback.sb>
  <exactExecutable> <absolute preparation root>/runtime.mjs
  <absolute preparation root>
```

The receipt contains the complete literal policy and four absolute argv arrays;
`-p` takes the policy text, not the filename. The policy denies network operations
except IPv4 loopback bind/inbound/outbound and denies filesystem writes except
inside this diagnostic fixture's `.owned/candidate-0112-prep-p0YnCd/` directory
and `/dev/null`. The initial policy's syntax/enforcement had **not yet been
executed** when this receipt was written; it proved invalid during invocation
admission and was not used for accepted candidate execution. The corrected policy
and inert enforcement records are described separately in the acceptance report;
the corrected source preparer has executed neither. No unsandboxed fallback is allowed.

Every runtime has a separate private HOME, XDG config/cache/data/state, APPDATA
and temp directory. Environment inheritance is not used. Initial upper/lower
HTTP/HTTPS/ALL proxies point only to loopback. The unchanged `rpc.no_proxy` test
removes both loopback exclusions and directs upper/lower proxies at a separate
live recorder to prove the raw client still bypasses them. PATH is system-only. No live config
or credentials are supplied.

Children are sequential, with a 60000 ms external process budget per replay.
The unchanged 15000 ms timer rejects a behavioral test callback that has not
finished; stop completion is bounded by 1000 ms and
actual peer close events by 500 ms. Existing lifetime controls retain their
2500 ms child cap. Cleanup may terminate only children created by this future
fixture, never an existing process. Successful results require fresh output,
all seventeen named cases in order, the unchanged result validator accepting
the complete case records, and a matching child exit. A partial list or truthy substitute is not accepted.

The replay remains uninstrumented. In its unchanged shutdown callback, the four
actual close-event promises must resolve after stop and before the test's finally
client destroys. A successful row therefore requires natural server-driven
closure of the pre-header and partial-body peers plus requests whose application
apply handler and asynchronous notification drain have actually started.
Fixture client destruction cannot satisfy this server-driven close requirement. No new observer, sleep, widened guard
or cancellation mechanism is added to these acceptance runs.

## Old-order negative control and restoration plan

After explicit execution approval for the four-runtime positive replay, use a separate owned
synthetic copy for exactly one Bun1.3.14 control. Reverse only the candidate's two
public stop calls back to close-before-closeAllConnections; keep tracked destroys,
all other producer code, callbacks, budgets and strict result boundaries intact.
The planned order-only mutant hash is computed in memory and recorded in the
receipt; **no mutant producer bytes have been written or evaluated**.

Stage that disposable target with its admitted bytes, confirm an empty unstaged
diff, save its bytes and independently admitted hash, apply the order reversal
with `NON-VACUITY BREAK`, and capture a nonempty diffstat. Run the same full
seventeen-contract child on the pinned Bun13 input. Require exactly
`rpc.shutdown_ownership` red, all sixteen other names green, and consistent exit 1.
Bun1.4.2 is **not** expected to kill this specific order mutant; no such control is
planned on that runtime.

In a finally block, restore the saved bytes without checkout/touch/stash, verify
the independent original admission hash and empty unstaged diff, and remove only
the disposable index entry. Preserve every earlier failed-run receipt and the original
diagnostic separately. No control retry, semantic fix, production pin bump,
integration, publication, commit or full RPC acceptance is authorized by this
preparation record. Parent review and explicit execution authorization are still
required.
