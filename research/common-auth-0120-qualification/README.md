# Common-auth 0.12.0 adapter qualification

The qualified candidate was package commit `db6bb2a980c7ab9fc3af1bd285360926b35abd8f`, archive SHA-256 `aebd3e2edde43d154b3bb99e4d684720b686e20fec2f04a3c6b91c854c3ce49a` (235,567 bytes). The published npm archive is SHA-256 `35ce4c601c94e8aba94762fade7895047b3038b70c0d93753aa4d955bb04e951` (235,492 bytes). Their decompressed tar contents are byte-identical, SHA-256 `0b8d052de1f7058177dbc4f339fbcc60e678580a9c349b1268024b9f23c262b8`.

Initial qualification used an isolated candidate consumer without changing the released pin. The nine cases now run as permanent core tests through the standard public-package consumer, using the published archive and its genuine `./store` and `./fs` exports. No operator credentials or OAuth exchange are used.

```sh
bun scripts/prepare-common-auth-public-consumer.ts bun test --isolate packages/core/src/account-repository-publication.test.ts
```

The cases cover disabled reserved preparation, publication, requested metadata/order/settings and enabled state, thrown failures before/after the account-list write, actual process exits before/after the account-list write, a credential written to state.json before its roster entry reaches config.json, overlapping secrets/identities, and publication refusal after an old secret changes, leaving config.json and state.json byte-identical to their pre-publication snapshot. Assertions inspect serving readiness and actual config/state files. Three child cases exit with code 91 at genuine write observers; the parent observes that exit and reopens the repository. Only the crash-fixture processes use one-second lock expirations. Recovery waits for expiry without deleting lock files or changing production deadlines. These are process-exit tests, not power-loss tests.

The durable publication receipt records the exact removal/finalization plan, each row's credential generation number, and the operation reserving each prepared row. Replay does not roll back a committed account list. Adapter reads remain management-pending until its journal is cleared. Without the store's publication capability, non-empty replacement still refuses without writing journal, transfer or account files.

The permanent test loader checks the public-package receipt and all payloads before importing the real exports. Its types come from the same published declaration bytes, and the production and test declarations remain part of the strict project typecheck.
