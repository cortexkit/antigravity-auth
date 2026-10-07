# OpenCode 2.0.22 released-host contract

This is a **source/API contract**, not an adapter acceptance report. The selected
transport is the stock Google HTTP driver, a request-hook rewrite to an owned
IPv4 loopback bridge, and the unchanged raw AGY sender behind that bridge.
Proxy users must explicitly exclude loopback. No custom AI SDK factory, host
patch, process-wide fetch override, or environment mutation is part of this
contract. Real-host loading, native amd64 measurements, TLS negatives,
compaction, cancellation and full TUI parity remain separate gates.

## Source identities and citation convention

The following immutable `git archive` snapshots are the source authorities.
`SOURCE_REF.txt` is an archive annotation, not a checkout; it was read, not
`rev-parse`d. Paths after each citation prefix are paths **inside that host's
source tree**, not paths in this adapter. Review archives are human provenance,
never runtime inputs to a clean checkout.

| Prefix | Exact source | Retained authority |
| --- | --- | --- |
| GA | OpenCode `v2.0.22`, `527f0b931d1f9b3ebd34e106c51b31ce5db5b075` | `opencode2-ga-2.0.22-source/SOURCE_REF.txt` |
| V1 | OpenCode `v1.17.13`, `10c894bdeef3618f5666fb506ef7f9491bb964d8` | `opencode1-1.17.13-source/SOURCE_REF.txt`, `manifest.json` |
| Loader | OpenCode 1.18.30 + ORW, `d199bbb1bb65e29242f2bb072d766b9294deda0c` | `opencode1-loader-d199bbb1bb/SOURCE_REF.txt`; corroborating loader evidence only, **not** the 1.17.13 floor |
| Life | Same GA commit | `ga-lifecycle-2.0.22/manifest.json`; its three source SHA-256s were compared to real files |
| Google | Same GA commit | `ga-stock-google-http-2.0.22/manifest.json`; all eleven source hashes compared |
| TUI | Same GA commit, published OpenTUI 0.5.14 scripts | `ga-tui-runtime-2.0.22/SOURCE_REF.txt`, `npm-pins.json` |

All 343 V1 manifest hashes, three Life hashes, eleven Google hashes and two
legacy-core corroborating hashes were compared before use (359 comparisons).
The GA `model-request.ts` and `title.ts` duplicated in Google are the same source
files as GA's snapshot. No source archive was overwritten. These source
identities do **not** establish that npm's executable was built from that commit.

## Executable pins and their limits

`packages/e2e-tests/docker/ga-binary-pin.json` is a strict, versioned input:
`schema`, `package`, `version`, `tarballURL`, `sri`, `binaryPath`,
`binarySha256`, `binaryBytes`, `elfMachine`, `platform`, `reportedVersion`,
`runtime: {name, version, revision}`, `source: {repository, tag, commit}` and
`provenance: {artifact, artifactRecordSha256, runtime, runtimeRecordSha256, limits}`.
Unknown or missing fields are refused by the runner.

- GA: official npm `@opencode/cli-linux-x64@2.0.22`,
  `https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.22.tgz`.
  SHA-512 SRI
  `sha512-DlV1qgEDDnVqpTWMPqv7tCHCcXodzZBFaMcxjsiYdY6E5gHH2Q68JfasVksyQ1nu6m1887WQKGhOsepE+oKyYw==`;
  member `package/bin/opencode`, 204482016 bytes; executable SHA-256
  `32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122`;
  ELF machine 62, Linux amd64. Expected report: `opencode v2.0.22`.
  Runtime report: Bun 1.4.2, revision
  `744846f844374847c902b5e7fd59b4342a51ef99`.
- Artifact authority: independently reviewed retained
  `ga-proxy-independent-r3/x64-registry-pin-independent.json` (record SHA-256
  `02e0668b11310d7f3965b92299f002ddc8ebe8f01dc2c2be9c7c768f834888b2`).
  Its actual record hash was compared here; **the GA tarball was not rehashed,
  downloaded, extracted or executed in this component**. The record reports
  a prior fresh public-registry SRI/member/digest/ELF comparison and no developer
  host execution. GitHub's release asset returned 404; it is not the artifact.
- Runtime authority: retained emulated x64
  `worker-amd64/cases/001-control-no-proxy/plugin.jsonl`, record SHA-256
  `964fa2e86331c4374f6bd35622c17ebf5d430e264b9b97ef11c4be5ed43957de`.
  Bun's revision is a runtime-reported git hash, not a separate runtime-binary
  digest. It does not prove binary-to-source equivalence or native execution.
- V1: `opencode1-binary-pins.json` is **byte-exactly** the verified retained
  `opencode1-1.17.13-artifacts/pin-verification.json`, SHA-256
  `75a8b919bca7a36dae5f55ff85f3e4edfbf9e808fb7a75b41bbdc37579047b9a`.
  Both retained tarballs were independently rehashed and their members read,
  never executed, while materializing this component:

| V1 package, from `opencode-ai@1.17.13` | SHA-512 SRI | Executable SHA-256 | ELF / platform |
| --- | --- | --- | --- |
| `opencode-linux-x64@1.17.13` | `sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw==` | `ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d` | 62 / linux/amd64 |
| `opencode-linux-arm64@1.17.13` | `sha512-NgBu9go6DTgi2OJ04Q54kgbQFWOmv70cdBUsGr74SdXWEpi/VNIWc/5e5eYJ123ogW25uB03H5jFQx5XKsKzUQ==` | `97cec34266f1fb21752755c1539a9accc1b5a1b8b3d1642046db9c15f424da54` | 183 / linux/arm64 |

The V1 JSON preserves the exact registry URLs and tarball SHA-256s. Its
`executed: false` is historical pin-materialization provenance, not an assertion
that a later runner should omit version checks. Every future host run must check
SRI **before** extraction, member digest and ELF **before** execution, then record
the reported version in network-disabled Docker with isolated DB and HOME/XDG.
Neither pin claims an independently attested binary-to-source link.

## Loading, public SDK and legacy context

| Field | Source-backed contract |
| --- | --- |
| GA name resolution | `Host.resolve({directory,name})` probes package `/server`, then root for server, independently `/tui` and `/rpc`. Missing-module/export errors advance the probe; other errors rethrow. GA `packages/plugin/src/host.ts:17-44`; Bun resolver GA `packages/util/src/runtime/import.bun.ts:1-10`. |
| GA directory resolution | Probes absolute `<dir>/server`, then `<dir>/index`; separately `<dir>/tui`, `<dir>/rpc`. It does not inspect the directory's export map. A root `server.js`/`tui.js` forwarder is therefore required to avoid a development `index.ts`. Same `host.ts:20-24,43`. |
| Are TUI/RPC entries required? | Server `default {id,setup}` suffices. TUI needs a separately resolvable `/tui`. Native `context.rpc` registration needs no `/rpc` plugin entry. GA `core/src/plugin/module.ts:60-73,94-121`; `plugin/src/promise/rpc.ts:25-31`. |
| GA server decode | Default `id` plus `effect` or `setup`; extra hybrid `server` is not a discriminator. Promise default is adapted by `fromPromise`. GA `core/src/plugin/module.ts:60-73,107-116`. |
| GA Promise SDK | Published `@opencode/plugin@2.0.22`, not `@opencode-ai/plugin`. Source exports root Promise API, `/effect`, `/host`, `/tui`: GA `packages/plugin/package.json:3-5,12-18`. Actual published type artifact authority is `ga-consumer-independent-r1/parent-artifact-verification.json` (`@opencode/plugin` SRI `sha512-EJyr+qA+I41rfJqE2zfyKL2qNez+wE8QkNwXf5TddEKIPmL8FUvYMVT5lLhbnXyOGTDxsEc0/8bX7ErQfX5/Rg==`, tarball SHA-256 `0406af7b34d63cb6c1397ac1394bc632c28622f88c44f3584d00a45e2ab7f593`). Published peer/type consumers were independently reviewed; current workspace GA resolution is a pending manifest/typeconfig handoff, not a passing check here. |
| Setup/context | `Plugin.Plugin` has `id` and `setup(Context): Cleanup | void | Promise<Cleanup | void>`; `Cleanup = () => void | Promise<void>`. Context contains `app`, `location`, `options`, `session`, `provider`, `model`, `command`, `integration`, `rpc`, etc. GA `plugin/src/promise/plugin.ts:26-61`. |
| V1 server-loader surface | `./server` export before `main`; a package directory remains the target. Recognized default hybrid `server` before named factory iteration. V1 `opencode/src/plugin/shared.ts:103-113,175-191,207-213,272-323`; `opencode/src/plugin/index.ts:107-168`. Loader corroboration at d199 has the same named fields; it is not runtime floor evidence. |
| V1 core/native surface | Separate from the server-loader: an absolute file is imported and default decoded, then Promise setup runs under `Effect.ignoreCause`. V1 `core/src/config/plugin/external.ts:73-87`. Legacy context has `options`, `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`, `reference`, `skill`, **no session or location**; V1 `core/src/plugin/promise.ts:45-90`. It discards setup's return there, unlike GA. |
| V1 package-name airgap | A bare name becomes `<name>@latest`, cache `${XDG_CACHE_HOME}/opencode/packages/<sanitize(spec)>`; existing `node_modules/<name>` returns immediately, no version comparison. Otherwise Arborist reify accesses registry. V1 `opencode/src/plugin/shared.ts:207-213`; `core/src/npm.ts:79-108,115-137`; `core/src/global.ts:17-37`. Preinstall the packed plugin and full dependency closure at `${XDG_CACHE_HOME}/opencode/packages/@cortexkit/opencode-antigravity-auth@latest/node_modules/@cortexkit/opencode-antigravity-auth`, independently verify manifest and bytes. This is source-verified, not a run or a version-match shortcut. |
| Engines and metadata | V1 npm server/TUI loader evaluates `engines.opencode` with semver, paths bypass that gate: V1 `opencode/src/plugin/shared.ts:194-204`; `loader.ts:123-130`. The proposed combined range `>=1.17.13 <3` contains both pinned versions; installer acceptance remains a real-host gate. GA Host and server module decode do not read `oc-plugin` or `engines.opencode`: GA `plugin/src/host.ts:17-44`, `core/src/plugin/module.ts:80-132`; npm installation is delegated to `@opencode/util/npm`, not reimplemented here. No legacy `oc-plugin` key is needed for GA entry discovery. This source observation does not claim a separate installer execution. |

GA acquisition is important: Life `packages/core/src/plugin/promise.ts:1-3`
re-exports the public adapter; Life `packages/plugin/src/promise/adapter.ts:604-607`
uses `Effect.acquireRelease` to capture and invoke the returned Cleanup.
Life `packages/core/src/plugin.ts:48,64-77` owns the activation scope and closes
failed activation; `:208-220,238-248` closes disabled/location scopes. It does
**not** discard the returned cleanup. Registrations are Promise registrations
with `dispose(): Promise<void>` (GA `plugin/src/promise/registration.ts:1-19`).
A setup must await registrations in a block, return only its own Cleanup, roll
back plugin-owned partial resources on failure, and make Cleanup idempotent.
The legacy structural no-op checks only absent `session` and `location` before
any effects; actual loader outcomes belong in the later no-op outcomes report.

## Google hooks, error observation and session semantics

| Field | Contract and source |
| --- | --- |
| Request hook | `context.session.hook('http.request', callback, {providerID:'google'})`. Callback mutates `event.request`, does not return a Response. Event has immutable `sessionID`, `agent`, `model: Model.Ref`, `kind`, mutable `request`. GA `plugin/src/promise/session.ts:61-87,138-151`; `registration.ts:15-19`. |
| Model filter/kinds | `primary | compaction | title | generate`, not inferred from agent name. Stock Google hooks cover off-catalog titles as well as registered primaries. Provider scoping is host-supported, not a plugin guess. GA `session.ts:57-78`; `core/src/session/model-request.ts:237,333-342,420-424`. |
| Rewrite point | Only HTTP request replacement. Changing `model.request.baseURL` changes route provenance and can die once history has compaction parts. GA `core/src/session/model-request.ts:300-331`. Its HTTP wrapper converts the replacement Request/body back to host HTTP transport at `:333-360`. |
| Hook stop/rejections | Throw/reject from HTTP callback before replacement to stop dispatch; no catch-and-public-fallthrough. The Promise hook uses `Effect.promise` (Life `plugin/src/promise/adapter.ts:576-580`); request preparation records rejections as a cause rather than promising a typed callback error channel. Google `core/src/session/runner/model.ts` and retained same-commit post-header `source/step.ts:263-270`/`source/hooks.ts:21-29,88-95` expose the downstream cause channel. Retained proxy control `004-control-hook-throw/stdout.jsonl:1` records native `error.type='unknown'` and the original exception message, zero bridge/provider requests. This is a prior research control, not this component's run. |
| Response observation | `http.response` gets immutable replaced Request and mutable Response before driver status classification. It sees upstream `response.status`, `headers.get('content-type')`, clone-readable body bytes. GA `plugin/src/promise/session.ts:80-87`; `core/src/session/model-request.ts:350-360`; `ai/src/route/executor.ts:241-254`. This is the overflow verbatim-byte assertion point. |
| Late-error channel | Replace only the exact owned job's response body with a reader that errors with the captured genuine Error. Host response read errors retain HTTP status 200 and yield `provider.transport`, prefix `Connection lost while reading the response: `. Destroying the loopback socket alone loses the genuine cause. GA `ai/src/route/executor.ts:162-223`; accepted `refs/alfonso/accepted/bg_03056afad04772b3` (`c46182d`), `ga-post-header-independent-r2/raw-inputs.json` and `review-summary.json`. This research is not adapter coverage. |
| JSON session error | `opencode run --standalone --format json ...`: top-level `type:'error'`, `sessionID`, nested `error.type`, `error.message`, optional `error.status`; not an assistant text part. Hook rejection control is `unknown`; captured late read failure is `provider.transport`, status 200. Retained control stdout above and GA executor `:169-205`; post-header `source/to-session-error.ts:28-52,85-95` maps transport errors to the session discriminator. |
| Session/parent metadata | Before replacement read `x-opencode-session-id`, `x-opencode-session`, `x-session-affinity`, `X-Session-Id`, `x-opencode-parent-session-id`, `x-parent-session-id`. Affinity is distinct from session id. Parent is conditional on `session.parentID`, not hardcoded null. GA `core/src/session/model-request.ts:274-287`. Child requests keep their own session key and record the supplied parent as metadata; none of these headers goes to AGY. |
| Titles | Selection uses configured title agent or small primary-provider model, then may fall back to differing primary. GA `core/src/session/context.ts:95-118`, `core/src/model.ts:266-277`; title requests go through prepared title hooks, not SessionRetry (`title.ts:66-98,127-134`). Failed title leaves title unchanged, without primary session-error/assistant synthesis. Title wire mapping remains `gemini-3.5-flash-low` → resolver → `gemini-3.5-flash-extra-low`; off-catalog titles must still route. |
| Retry | Event has model and attempt, no kind; mutable `{retry:false}` or `{retry:true,delay}`. GA `plugin/src/promise/session.ts:127-136`; default ten retries, exponential 2/4/8 then 10 seconds with jitter, timeout cap three, `core/src/session/runner/retry.ts:34-90`. Accepted research observed 11 dispatches/10 retry-hook calls on reset. Native provider classification covers rate-limit/internal and transport retry cases; failures such as 429/5xx and read reset need the production registered-model-only retry-disable hook. Titles have their own path above, never globally disable unrelated models. |
| OAuth | `integration.transform(editor => editor.method.update(...))`; OAuth registration has `integrationID`, `method`, `authorize(answer)` and optional `refresh(credential)` returning OAuth credentials. Authorize returns URL/instructions and `mode:'auto',callback:Promise<OAuth>` or `mode:'code',callback:(code)=>Promise<OAuth>`. GA `plugin/src/promise/integration.ts:41-61,73-87`. No legacy `client.auth.set` is required. |
| Model registration | `provider.transform`, `editor.models.set('google', Model.Info[])`, then reload. No separate catalog/provider identity. GA `plugin/src/promise/provider.ts:15-33`; Life `plugin/src/promise/adapter.ts:342-352`. Register the shared public catalog keys and enabled variants, not title wire aliases. |
| Command API | `context.command.transform(editor => editor.add(definition))`, definition's `execute(input)` is awaited with rejection recorded; `context.command.list/reload`, session command dispatch. Life `plugin/src/promise/adapter.ts:307-323,589`; GA `plugin/src/promise/session.ts:153-171`. No v1 `session.prompt` synthetic command text is implied by this API. |
| Scripted compaction | Await native `context.session.compact` between a prompt and subsequent prompt on the same session; exact input is the published client's API type, not a fabricated hook event. GA `plugin/src/promise/session.ts:153-164`; Life `plugin/src/promise/adapter.ts:587-590`; primary/compaction preparation GA `core/src/session/model-request.ts:420-424`. A fake compaction hook alone does not prove history/route compatibility. |
| Logger | GA public Context has no legacy `client.app.log` or logger domain (`plugin/src/promise/plugin.ts:26-54`); use stderr when no native public sink is available. Host activation preserves Effect logger context, not a plugin-supplied global sink: Life `core/src/plugin.ts:69-73`. V1 server input's client surface remains distinct; no shared module-scope logger may capture the first location. |

### Native RPC and location lifetime

`context.rpc.register(definition, handlers)` returns a Promise registration with
`dispose` and `events.emit`; handler context has `signal` and schema error
factory. GA `packages/plugin/src/promise/rpc.ts:7-31`.
Registration is scope-acquired, removes exactly its own entry, and emits events
with the location directory/workspace ref: GA `packages/core/src/rpc.ts:69-103`.
Latest live definition wins for its id (`:108-112`). Native client calls through
this context cannot supply foreign `location`/headers (`promise/rpc.ts:25-26`).
Teardown closes the activation scope and invokes Cleanup, which must stop
producers, abort streams/jobs, close owned loopback sockets, drain writes and
then dispose consumers. Two locations in one process each get an activation
scope (Life `core/src/plugin.ts:48,238-248`) and Context.location; this establishes
the ownership API, not a passing two-location resource test.

## TUI loader, UI APIs and runtime module identities

GA TUI default is separate `Plugin.Definition {id,setup(context)}` with optional
Cleanup: GA `packages/plugin/src/tui/plugin.ts:5-14`. TUI resolution calls
`Host.resolve(target).tui`, then accepts only an object with non-empty id and
function setup; additional hybrid `tui` is not rejected. GA
`packages/tui/src/plugin/context.tsx:652-696,741-749`. Loader setup runs inside
owned UI context; on setup rejection it disposes already-owned registrations
and rethrows (`:639-644`), records setup failure (`:159-195`) and serializes
reconciles/deactivation (`:242-261`). A function with a `setup` property is not
a replacement for the required object shape.

- Context: `options`, `location`, `app`, `renderer`, `client`, `data`, `attention`,
  `theme`, `themeMode`, `markdown`, `keymap`, `storage`, `ui` (GA
  `plugin/src/tui/context.ts:516-532`). Rebind location on navigation; module
  caching is not location ownership.
- Dialog: `ui.dialog.show(render,onClose?)`, `set({size,centered?})`, `clear`,
  `alert`, `confirm`, `prompt`, `select`; dismiss is undefined where specified
  (`context.ts:327-381`). No private host DialogSelect/Prompt imports.
- Toast exists at `ui.toast`; slot `ui.slot(claim)` returns an unclaim callback,
  sidebar claims render with session metadata (`context.ts:462-514`; SlotClaim
  and SlotMap in the same source tree). Keymap `layer(() => layer)` is owned by
  the calling Solid component, plus `dispatch`, shortcut and command APIs
  (`:384-459`). Use append/prepend sidebar claims, not replacement of others.
- Runtime module ids are registered by TUI
  `packages/tui/src/plugin/runtime-plugin-support.bun.ts:1-8`:
  `@opencode/plugin/tui` binds `Plugin`, `PluginContextProvider`, `usePlugin`;
  OpenTUI's integrity-verified `package/scripts/runtime-plugin-support-configure.js`
  and `package/runtime-plugin.js` register framework bindings. Loading resolvable
  ids does not prove ABI interchangeability or a second-instance-free mount.
- GA runtime is `@opentui/core`/`@opentui/solid` **0.5.14**, `solid-js` **1.9.15**;
  V1 adapter runtime remains **0.4.5** (`@opentui/core`, `@opentui/solid`,
  `@opentui/keymap`) and **solid-js 1.9.12** in this base's installed/locked
  development closure (`packages/opencode/node_modules/solid-js/package.json:1-4`);
  that package-local observation is not a claim that the upstream host binary
  embeds the same Solid bytes.
  GA TUI source lists catalog dependencies (`TUI packages/tui/package.json:90-99`);
  actual version authority is the retained runtime/published npm evidence above,
  not the word `catalog`. Installed raw TSX is not a GA fallback: the published
  0.5.14 transform skips node_modules. The two compiled roots and real mounts
  remain required, separate from type consumers.

## Canned overflow inputs

The two shipped fixtures are byte-exact copies of the retained canned mock
responses, not live backend captures. They contain status 400,
`application/json`, body string/base64, byte length, SHA-256 and provenance.

| Fixture | Body bytes | Body SHA-256 |
| --- | --- | --- |
| `overflow-gemini.json` | 148 | `8f7c248c6ea08caa5db181b1e4f27290a5cc508e259ef00bc2281035c42e982a` |
| `overflow-claude.json` | 113 | `773dfc1934b7d6b429f728b5842f5338ef69451b5513f4bf6b1ac48edbbec01f` |

Gemini uses parenthesized token counts. Claude wording is inside Google's
`INVALID_ARGUMENT` envelope, not an Anthropic-native envelope. Provenance is
the 75/75 `mc-fixed-cda6851` mock run, host 2.0.20, Magic Context revision
`cda6851df61b3d53b900174e285cedcfecedb213`; the accepted probe ref is not a
Magic Context revision. Original summary hashes were compared as well as
base64/body/length/hash equality. Neither that run nor the older 73/75 `ffff1f3`
run tests the migrated adapter. These inputs prove forwarding/classification
only; production must classify changed Gemini counts and preserve status,
content-type and body bytes at HTTP response observation without rotation.

## Frozen measurement dispatch and fail-closed runner

`ga-loopback-request-contract.ts` is the shared comparison oracle for **only**
dispatch fields: `http.request`, scoped Google, exact content pathname
`^/[^?#]*/models/[^/:]+:(generateContent|streamGenerateContent)$`, method POST,
`http://127.0.0.1:<port>/agy/<job>`, no original headers copied, all originals
dropped, only `content-type: application/json` replaced, body exactly `{}`.
Origin-only matching, extra suffixes, copied credentials/session headers,
wrong body or method fail. Job id and port normalization affect this dispatch
contract only, not binary digests or primary/title attribution.

The measurement plugin reads only its explicit log and fixed mock-port inputs,
imports the real released `Plugin.Plugin` **type**, and never reads proxy
variables, the retained matrix, or Antigravity implementation. It logs the
original nonce/body hash/session/kind and fresh job id before replacing the
Request, with inherited AbortSignal. It registers only the request hook and a
scoped one-attempt retry policy; the host performs actual dispatch.

The runner is complete for future native admission, not executed here:

```sh
# Run from a clean git archive/checkout with repository Bun dependencies installed.
# Image admission supplies a local immutable Linux-amd64/glibc image containing
# bun, git and uname. No image pull or image build happens in this runner.
bun run packages/e2e-tests/docker/measure-ga-proxy-matrix.ts \
  --image "${GA_NATIVE_IMAGE_ID:?local sha256 image id required}" \
  --tarball "${GA_VERIFIED_ARCHIVE_PATH:?fresh official GA archive required}" \
  --out "${GA_FRESH_OUTPUT_ROOT:?must not already exist}"
```

The controller must itself run on the independently admitted native x86_64
measuring host/daemon. It records host `uname -m` and Docker daemon
`docker info --format '{{.Architecture}}'` **outside** the container. Arm64
controllers/daemons fail `not native x86_64`, never skip. A platform flag and
container uname cannot rule out emulation. The daemon image id/OS/architecture
is independently inspected; launch uses `--pull=never --network none
--platform linux/amd64 --init --read-only`, no capabilities, no-new-privileges
and isolated executable `/tmp`. Only fresh input/output roots are mounted.
The runner executes its retained dependency-free TypeScript directly; no SDK
or runtime package installation is required inside the container for the
measurement plugin.

Fresh SRI is checked before archive parsing; the sole binary member's length,
SHA-256 and ELF marker are checked before any execution, again inside Docker.
Version execution itself has an explicit isolated DB and HOME/XDG. Every row
has its own explicit DB, HOME and four XDG paths, fake Google API key and
case-unique primary nonce. Nonces are deterministic per inventory id so fresh
matrix comparison need not erase them; ordinal directories avoid case-folding
collisions between uppercase/lowercase names. Every artifact is written once
except the explicitly diagnostic partial aggregate. No caller's proxy or
credential environment is inherited by host processes. Presence of any
`NODE_TLS_REJECT_UNAUTHORIZED` value refuses launch.

- Inventory has 253 unique entries: positive control, six single variables,
  37 exclusion/conflict cases per variable, all fifteen pairwise proxy conflicts,
  raw-empty upper/lower controls and seven literal quoted rows. Each basic
  exclusion and its ordinary comma-list variant is explicit, including exact
  port, wrong port, localhost, IPv6, CIDR, wildcard, empty token, whitespace and
  case controls; suffix forms are observations, not guard permission.
- Per-variable exclusions run only after that variable's single case proves
  proxied. An unhonoured single records each excluded derived case and its
  prerequisite; it is not silently omitted. Unknown/duplicate/empty selectors
  fail; focused selection explicitly includes positive control and prerequisites,
  fails if all requested cases are excluded and can never be promoted as full.
- Fixed mock 38191, wrong-port control 38192, recorder A/B 38193/38194, provider
  stand-in 38195. No port retry discards a model case. Collisions fail.
- Direct requires one original-nonce-matched **primary** rewrite and exactly one
  tied mock request with zero tied recorder traffic. Proxied requires a recorder
  HTTP request tied to that primary job; CONNECT requires the observed inner
  HTTP request on the same connection. Untied CONNECT is an anomaly; a
  title-only tunnel cannot prove primary proxied. Public-provider fallthrough,
  duplicate primary jobs/requests, missing setup, wrong runtime and malformed
  records fail. Native CLI must emit actual mock text and terminal completion.
- The plugin log, raw recorder traffic, stdout/stderr, argv/environment,
  exit/signal/timeout/descendants, per-row verdicts, sources and inventory are
  retained. Request/tunnel, host, prerequisite and aggregate deadlines are
  finite. Processes that outlive CLI or keep pipes open are killed and fail,
  not reclassified as proxy results. Server cleanup closes tracked sockets,
  including CONNECT sockets, before the next fixed-port row.
- Final `matrix.json` requires strict complete schema/inventory, the verbatim
  pin digest, live source fingerprints and native fields. `partial.json` is
  diagnostic only. Normalization templates only the known ports and absolute
  paths; primary nonce, source/binary digests and decisions remain verbatim.
  `--compare <retained-file>` invokes strict full-run conformance and fails on
  absent/malformed retained input or any normalized difference.
- This runner **never writes the promoted matrix/provenance files**. A separate
  owner reviews native raw results and performs the named one-time promotion,
  recording source root, step and digests. Pending native measurements mean
  there is no certified retained matrix from this component.

`documentedLoopbackExclusion`: **candidate `NO_PROXY=127.0.0.1`**, row id
`exclusion-HTTP_PROXY-literal`. It is a research-supported candidate, **not a
native-amd64-certified value** until that row and the full matrix pass. The
conservative guard's admitted grammar is `*`, `127.0.0.1`, or the exact actual
bridge port; observed host suffix matches do not broaden guard permission.
Non-empty raw lowercase wins before literal quote stripping; the seven quoted
and raw-empty cases measure that distinction. Accepted 71-case native ARM
research and 65 completed emulated x64 cases (six pre-setup timeouts, failed
aggregate) certify no native amd64 or long-lived-server behavior.

### Actual raw-sender AbortSignal: original instrumentation gap

This source finding predates the additive diagnostic ruling below. It remains
retained evidence of the original missing seam, not an assertion that the later
correction has already been implemented or exercised.

The measurement plugin's `event.request.signal` is the **host Web Request's
signal**. Supplying it to the replacement Request establishes that Request's
following signal; it neither observes nor proves the identity or abort
transition of the signal passed to the raw AGY sender. The source/API contract
and proxy-measurement component are independent of this separate runtime
observation prerequisite.

At this adapter's baseline `53684d66af97ea4cd44b6dc18d0e039f2526a978`, the actual
unchanged sender is `packages/core/src/agy-transport.ts`:

- `AgyTransportOptions.signal` is the sender's signal input (`:18-32`). The
  sender checks `options.signal.aborted` before work (`:576-578`), passes that
  signal to connection setup (`:587-591`), installs its abort listener before
  dispatch (`:594-600`) and passes it into response-body handling (`:615-621`).
- Direct TLS uses that signal in `tls.connect` (`:281-293`); proxy TCP and TLS
  use it at `:189-200,252-257`. Body handling independently observes the same
  signal's abort state/listener (`:541-551`). Those are source facts, not a
  measured abort transition or proof that the future packed bridge passes the
  right object.
- Existing `onDebug` exposes only message strings (`:18-32,584-585,601-613`),
  not the actual signal object or its abort transition. Neither the sealed
  override list nor these diagnostics provides an actual-signal observer API.

**Original hard prerequisite, before the additive correction:** an explicitly
admitted observation mechanism for the actual sender's `options.signal` was
missing. The supplied C-CANCEL/C-HOSTS and A4 requirements retain all their force: `send`
is omitted, the raw sender is unchanged, and each connecting/pre-header/
post-header case must separately record that signal's transition **and** the
peer's natural TCP/TLS close within 2000 ms with no further bytes. Peer close
alone, a host Request signal, an injected/wrapped `send`, transport monkeypatching,
or forced teardown cannot certify cancellation. At that point no observer API
or approved addendum was asserted. Parent owned the sealed-body/wiring
reconciliation and explicit design correction plus cross-owner handoff, now
recorded below. The original missing-seam finding did not pause preparation or
source/pin completion of unrelated GA components; no cancellation gate was run
or certified in this component.

### Additive diagnostic correction: implementation and host proofs pending

The parent approved the narrow correction in the read-only
`ga-cancellation-observation-ruling.md`, SHA-256
`57a6e4b3a149b8746a09177263e2e7bec96e72044e90b48b346f9280960bbfc5`.
The prior ruling body with hash
`ff2677453da42f0fd9e57069c92a8625a954091c26195839853c0706fa1e8afd`
remains retained by the parent; the final body clarifies public factory exposure.
It addresses the original design gap without changing the source findings above.
The correction adds exactly this **direct optional property** to the existing
SDK-free `GaPluginOverrides` accepted by `createGaAntigravityPlugin(overrides)`:

```ts
observeRawSenderSignal?: (signal: AbortSignal) => undefined
```

The existing named `createGaAntigravityPlugin` factory remains reachable through
the packed `@cortexkit/opencode-antigravity-auth/server` entry and its public
declarations. The real-host wrapper calls that factory with this property and
`send` omitted. No nested diagnostics bag, environment switch, new factory,
global hook or private dist-leaf import is admitted. If `send` is supplied,
the observer is not invoked because the production sender is not exercised.

`ga-loopback-request-contract.ts` exposes the exact callback type as
`ObserveRawSenderSignal` for the measurement-declaration fixture; it does not
invent a replacement or partial `GaPluginOverrides` declaration. The return
type is **undefined**, not void: an async observer returning
`Promise<undefined>` cannot satisfy it. There is no additional credential,
headers, body, project or account argument, no new configuration surface and
no core/common-auth transport API change. The runtime owner incorporates this
one direct property into the actual existing factory/declaration closure.

The **GA runtime owner** implements the following exact default-sender binding:
construct one transport-options object, synchronously observe the `signal`
property of that **same object**, then hand the identical object to the original
production `agyTransport`. Observing a separate controller variable and then
constructing different dispatch options is not admitted. Call the original
sender directly, only in the default sender branch; do not wrap it or supply a
`send` override. The observer is absent on normal calls, non-awaited, introduces
no microtask boundary and cannot alter dispatch when it throws synchronously.
Diagnostic implementations manage their own work and may not return a Promise.
The measurement plugin performs no AGY send and therefore does not invoke this
observer or claim that its host Request signal is the observed sender signal.

The **real-host harness owner** supplies the observer with `send` omitted,
records the actual signal object and its abort transition, and removes its own
listeners during test teardown. It separately observes the upstream peer's
natural close; absent/incomplete signal observation or peer-close evidence
refuses certification. Original connecting/pre-header/post-header cancellation
budgets and startup-trust requirements are unchanged. Socket/DNS monkeypatches,
transport replacement, sender-byte changes, altered timeouts, host Request
signals and fixture teardown remain forbidden substitutes.

Required binding control: **`ga.raw-cancel.detached-dispatch-signal`** replaces
only the production dispatch-options signal with a fresh never-aborted
controller's signal, while the observer still reads that same options object.
Run at the **pre-header cancellation barrier**, with the mock withholding
response headers, not after headers where reader cancellation could obscure the
signal binding. Collect both named failure records **before** deliberate
fixture teardown:

- `ga.raw-cancel.sender-signal-aborted` must fail for the missing actual-signal
  abort transition.
- `ga.raw-cancel.peer-closed-before-teardown` must fail for the missing natural
  peer close within the original budget.
- `ga.raw-cancel.uncancelled-request-completes` must remain unaffected.

An unrelated timeout/error, missing case or supervisor kill is not this
mutation's accepted failure. Those runtime assertions and mutation are not run
by this component.

The pure strict negative fixture **`ga.raw-cancel.async-observer-rejected`**
assigns an async callback directly to this component's actual exported
`ObserveRawSenderSignal` declaration for that property. It requires exactly one
TS2322 diagnostic (`Promise<undefined>` is not assignable to `undefined`); the
corresponding synchronous callback compiles with zero diagnostics. Both
programs read the real declaration and source closure; only the fixture source
is virtual, with no stubs or suppressions. This is an actual measurement-declaration
type check, **not** a future packed `GaPluginOverrides` declaration, runtime
implementation or host/sender execution pass. The future packed-declaration
fixture must assign directly to
`NonNullable<GaPluginOverrides['observeRawSenderSignal']>` from the public server
entry; it cannot count this measurement signature check in its place. Runtime
and harness owners must repeat their actual declaration/binding/abort gates
once the correction is integrated; source/pin completion and preparation of
other GA gates need not pause.

## Pre-deletion beta boundary oracle: pending parent admission

Source inspection at the frozen base sees beta identity's hardcoded
`parentId: null` (`packages/opencode-v2/src/plugin.ts:726`) and replacement
`{}` request (`:1277-1281`); inspection is **not** an oracle run. No beta workspace
was changed or removed here. The oracle must run in a separate worktree at
`b3d0c5d54d9f` before deletion, with the dependencies/build for that base and
isolated DB, HOME/XDG/config/account file. Existing title tests do not assert
verbatim primary overflow or parent identity and cannot substitute.

Parent admission argv for the additional frozen-base assertion suite is:

```sh
HOME="$ORACLE_ROOT/home" XDG_CONFIG_HOME="$ORACLE_ROOT/config" \
XDG_CACHE_HOME="$ORACLE_ROOT/cache" XDG_DATA_HOME="$ORACLE_ROOT/data" \
XDG_STATE_HOME="$ORACLE_ROOT/state" OPENCODE_DB="$ORACLE_ROOT/db/opencode.db" \
OPENCODE_CONFIG_DIR="$ORACLE_ROOT/config/opencode" \
bun test --isolate "$ORACLE_ROOT/beta-boundary-oracle.test.ts"
```

The separately authored oracle must import that base's
`createOpenCodeV2AntigravityPlugin`, not GA or this runner; inject only fake
refresh/project/send seams; register/capture its real HTTP hook using the
existing beta fake-context pattern (`packages/opencode-v2/test/plugin.test.ts:165-230`);
use one fake v4 account, each byte-exact overflow body above and a request with
`x-opencode-parent-session-id: ses_fake_parent`. Invoke the rewritten loopback
request, not the sender directly. It must independently assert at the response
point status/content-type/body bytes, attempt count one, and the selected
request identity's **non-null** parent via an AccountManager observer. Retain
all independent assertion results so early overflow failure cannot prevent
parent/attempt assertions; cleanup in finally. Network fetch beyond that
loopback is refused. It must redden the verbatim and parent assertions, not an
import or setup prerequisite; attempt count may pass. The suite's actual bytes,
SHA and assertion output still require parent admission and archival. There is
no claim that an absent test file or this source description ran successfully.

## Verification handoffs

Pure input/parser tests cover pins, fixture bytes/provenance, exact pathname
and dispatch fields, inventory/selection, quoted values, nonce/job/tunnel
attribution, isolation, SRI/digest order, native provenance and strict result
conformance. They run no OpenCode binary, Docker, provider, SSH or native
measurement. The ordinary base typecheck does not include these Docker files.

The manifest/typeconfig owner must pin `@opencode/plugin@2.0.22` in e2e, include
this plugin and runner in the root e2e TypeScript program and add the Docker
glob to Biome. **No SDK shims, casts or suppression substitute for that gate.**
SDK-free runner/contract/tests receive a separate strict TypeScript check now;
measurement plugin's actual GA SDK check and planted-error control remain
pending that handoff. Focused lint explicitly feeds the four file bytes to the
pinned Biome using existing src virtual paths until the Docker glob lands.

Pending runtime gates: full verified native-amd64 matrix/promotion/conformance;
pre-deletion beta oracle; real V1 1.17.13 name/directory/direct-file and PTY
loading/no-op outcomes; GA packed consumers/loading, stock Google compaction,
raw-sender startup trust and hostname negatives, three cancellation phases,
native error/overflow fidelity, returned Cleanup, two locations and full TUI
mount/parity. Implementation of the additive actual raw-sender observer and its
binding control above remains a distinct hard prerequisite for the three
cancellation gates, not an inferred host-signal pass. The signature-only strict
fixture does not certify that runtime binding.
No source reading, synthetic matrix, ARM result, emulated result
or pending provenance is counted as one of those passes.
