# Private 0.11.2 RPC comparison — independently recorded technical acceptance

The same seventeen private-RPC checks passed on Node 20, Node 24, Bun 1.3.14
and Bun 1.4.2. They cover authentication, PID isolation, file security, notifications,
deadlines, shutdown and proxy bypass. Those results and the precise stop-order
failure control below establish technical acceptance of the common-auth 0.11.2
archive with SHA256
`19331d5b8935d3309e769dec04591d5649dbc3cdafe47f1a0c0b7f12ae393146`.
This is **technical comparison acceptance**, not a production pin update,
public-publication verification, embedding regeneration, integration, or live
activation. The production 0.9.4 payloads and pins remain unchanged.

## Independent evidence boundary

The read-only execution handoff is
`.cortexkit/parent-inputs/rpc-0112-accepted-matrix-r1/`. Its manifest SHA256
`af4c2f874fc8c3a9f086b4f48d4eefe5c21c4f05ce624f47acb56107306f64e3`
was checked before parsing. All 31 regular payloads / 85122 bytes were then
verified against their independent sizes and hashes. The final result SHA256 is
`3ace1f7b4b6cd5192cacfd54bcec6d9d0c140c0408932481ea5a05b850bd6d6c`.
Bounded sandbox launchers ran unchanged `runtime.mjs`. The table names raw results;
corresponding `.receipt.json` files record argv, process identity and exit.
Only records were checked here; neither the package nor order control was rerun
after `FINAL-ACCEPTANCE.json`.

All seventeen unchanged `e0426393cfda2e03674ec25cfd1b53256ee9944b` contract
callbacks passed on each required exact runtime: **68 positive contracts, zero
failures**, empty stderr, no timeout, and all owned process groups absent.

The shutdown check observes entry into the apply-command and notification-drain
callbacks, then all four test connections closing without client cleanup.
Concurrent stop calls return the same Promise, verifying coalesced shutdown.

| Runtime | Accepted raw result | Exit | Contracts | Shutdown witness |
| --- | --- | --- | --- | --- |
| Node20.0.0 | `node20-matrix.stdout` | 0 | 17 | apply/drain entered; four natural peer closes; shared stop Promise |
| Node24.16.0 | `node24-matrix-r2.stdout` | 0 | 17 | apply/drain entered; four natural peer closes; shared stop Promise |
| Bun1.3.14 | `bun1314-matrix-r3.stdout` | 0 | 17 | apply/drain entered; four natural peer closes; shared stop Promise |
| Bun1.4.2 | `bun142-matrix-r3.stdout` | 0 | 17 | apply/drain entered; four natural peer closes; shared stop Promise |

The single Bun1.3.14 order-only control reversed the two stop calls in a newly
owned candidate copy. The expected failure pattern was one failed
`rpc.shutdown_ownership` result with exact `tracked peers still open`, sixteen
successful results and exit 1; that exact pattern was recorded with no
timeout. All 24 copied files were restored to independent original hashes,
with an empty disposable index and unstaged diff. The original server-file hash,
verified against the supplied inventory, is
`d431feb3556e684ae0539e8818391dcf64028f3e4b12fe7a1d2b391a430d843d`;
the order-only mutant hash is
`7d935b28b724e7446011be80aa4b78e0046804cf404951d395aaa7d77b0800c4`.
Bun1.4.2 was not expected to detect this specific order-only change and was not used for that
negative control. Commands document the completed approved runs, not permission
for another run; future regressions require separate execution approval.

## Preserved setup failures and bounded corrections

The corrections below affect fixture setup only. They preserve producer code,
callback bodies, required result fields and bytes, HTTP payload limits,
the 500 ms peer-close assertion and all request deadlines.

1. **Policy grammar.** The proposed SBPL `ip "127.0.0.1:*"` literal syntax was
   invalid. The execution-review launcher used measured `remote tcp "localhost:*"` and
   `local tcp "localhost:*"` rules under `deny network*`, plus `deny file-write*`
   except the exact private root and `/dev/null`. Inert Node24 controls established
   allowed 127.0.0.1 TCP, denied 127.0.0.2 TCP/TESTNET UDP, and allowed private but
   denied outside writes without candidate imports. The corrected source emits
   that same measured policy grammar, varying only its owned root.
2. **Fresh roots.** `rpc.stage_security` intentionally leaves `port-<pid>.json`
   as a directory after testing a failed file publication onto a directory. A
   shared root left both Node20 and Node24 PID directories in this test; the first
   shared-root Node24 run therefore failed its exact inventory. The valid Node20
   run was retained, and the later Node24 run used fresh state. The
   corrected source copies only the immutable 23 fixture inputs into four separate
   role-owned execution roots, adding a private policy as each root's 24th input.
   The original failure is preserved in `node24-matrix.stdout` and its exit
   receipt; `shared-state-cause.json` records both directory entries and the
   source mechanism. No contract
   assertion was changed or retained directory deleted to make a later run green.
3. **Startup helper routing.** Bun1.3.14's canonical `node:http` helper followed
   startup proxies pointing at 127.0.0.1:9. An inert owned recorder directly
   observed helper POST/GET requests reaching the proxy with empty exclusions and
   reaching the target with exclusions `127.0.0.1`. The corrected source sets only
   initial `NO_PROXY`/`no_proxy` loopback exclusions. The unchanged `rpc.no_proxy`
   callback still explicitly clears both exclusions and replaces upper/lower
   proxies with its own recorder before checking the raw private client. Its
   bypass control remains non-vacuous; it was not protected by the startup fix.

The corrected preparer does not execute anything, modify the first preparation
receipt, copy its mutable state, import host plugins, install peers, or mutate
existing cache/profile state. Each role receives private HOME/XDG/temp paths,
the same compiled adapter bytes and candidate public-root files, and an exact
canonical `runtime.mjs` copy. The positive and negative execution records
provided with the handoff, including both failed setup runs, are the evidence for
these observations.

A later checker wrongly expected policy-file `-f` arguments instead of the
prepared/accepted inline `-p` text. That verifier defect and failed check were
retained, then corrected; candidate, callback and preparation source were not
defective, and neither preparation nor accepted execution was repeated.

## Held joins

Commit `1d85fda63ba6faadaf9e797ec30acf016b428a27` contains the original Bun 1.3.14
server-shutdown diagnostic. Its receipts record the 0.9.4 stop sequence leaving the
unfinished-header peer open until fixture cleanup; those failing observations
remain unchanged. `SHUTDOWN_DIAGNOSTIC.md` received the twelve initial bounded
reader clarifications and subsequent wording-only source-review clarifications;
its source/callback hashes, timeline and failing
result were not rewritten as candidate successes.

The public 0.11.2 archive is independently verified as byte-identical to the
accepted candidate. The record is
`.cortexkit/alfonso/evidence/common-auth-0112-published-parent-r1/verification.json`.
Production still embeds 0.9.4; this comparison neither changes those bytes nor
fixes that version's shutdown behavior. Adoption requires coordinated version,
generator, build and metadata changes, source review, the normal hook, final
adapter/package checks and main integration. The 0.11.3 candidate comparison
changes only store/version files. Matching its RPC files would establish byte
association, not another runtime pass or acceptance of store behavior.
Publishing this plugin or activating its updated RPC in a host remains unauthorized. These wording
changes are uncommitted; no additional full gate, matrix, runtime, failure control
or sandbox probe was executed.
