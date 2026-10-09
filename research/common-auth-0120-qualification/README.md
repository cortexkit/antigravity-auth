# Common-auth 0.12.0 adapter qualification

Candidate package commit for this replacement qualification: `db6bb2a980c7ab9fc3af1bd285360926b35abd8f`. Archive SHA-256: `aebd3e2edde43d154b3bb99e4d684720b686e20fec2f04a3c6b91c854c3ce49a` (235,567 bytes).

The isolated consumer resolves `@cortexkit/common-auth/store` and `/fs` through the candidate package's actual exports. Its local `node_modules/@cortexkit/common-auth` link points to the admitted unpacked package; it does not change the root installation, released 0.11.6 pin or embedded runtime. No operator credentials or OAuth exchange are used.

Run the focused cases with:

```sh
bun test --isolate research/common-auth-0120-qualification/replacement.test.ts
./node_modules/.bin/tsc --noEmit --strict --allowImportingTsExtensions --module ESNext --moduleResolution bundler --target ESNext --types node research/common-auth-0120-qualification/contract.ts
```

The nine cases cover disabled reserved preparation, native publication, requested metadata/order/settings and enabled state, pre/post-decision thrown failures, actual child exits before/after the native roster decision, a reserved credential written to state.json before its roster entry reaches config.json, overlapping secrets/identities, and native fingerprint refusal after an old secret changes. Assertions inspect both public serving readiness and actual config/state files. Three child cases exit with code 91 at genuine native write observers; the parent verifies that exit and reopens the repository. Only those children's synthetic leases use one-second TTLs, so recovery exercises expiry without deleting lock files or changing production deadlines. These are process-exit tests, not power-loss tests.

`contract.ts` assigns the actual candidate public modules to the repository and migration interfaces with strict declaration checking. It excludes Bun test ambient declarations because the installed Bun 1.3/Node 24 pair has unrelated declaration errors; it does not suppress candidate declaration checking. The full project checks run separately against the unchanged released dependency pin.

The store's durable publication receipt records the exact removal/finalization plan, each row's credential generation number (epoch), and the operation identifier reserving each prepared row. Replay does not roll back a committed roster. Ordinary adapter reads remain management-pending until the adapter journal is cleared. Non-empty replacement with the released 0.11.6 runtime remains unavailable without writing journal, transfer or account files.
