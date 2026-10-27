// One plugin process deciding its vault layout, for the runtime-layout tests.
//
// Modes (first argument):
// - `once`: run `prepareRuntimeLayout` with the inherited environment, print
//   one JSON line with the layout and the vault folder it resolved (or the
//   error that stopped it), and exit;
// - `hold`: the same, then stay alive until killed (a live process on that
//   layout);
// - `heartbeat`: never decide; start the real runtime heartbeat the way a
//   3.0.13 process does (its config folder on the legacy layout, with the
//   package's own version), print one JSON line and stay alive until killed.
//
// Environment:
// - RUNTIME_LAYOUT_TEST_VERSION: the version deciding (default 3.0.14);
// - RUNTIME_LAYOUT_TEST_KILL_AT: `afterManifest`, `afterCopy`, `afterMarker`
//   or `midCleanup` (after the first old file was removed): the process kills
//   itself with SIGKILL there, leaving its leases on disk;
// - RUNTIME_LAYOUT_TEST_BARRIER: a path; the process writes
//   `<path>.<pid>.ready` and waits for `<path>` to exist before it decides;
// - RUNTIME_LAYOUT_TEST_TRACE: a path; one line `manifest <pid>` is appended
//   each time this process has written `layout-moving.json`.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import {
  removeProcessHeartbeat,
  startRuntimeProcessHeartbeat,
} from '../process-heartbeat'
import { prepareRuntimeLayout } from '../runtime-layout'
import { getVaultDir } from '../runtime-paths'

const mode = process.argv[2] ?? 'once'
const killAt = process.env.RUNTIME_LAYOUT_TEST_KILL_AT
const barrier = process.env.RUNTIME_LAYOUT_TEST_BARRIER
const trace = process.env.RUNTIME_LAYOUT_TEST_TRACE
const quiet = { info() {}, warn() {} }

const kill = (step: string) => () => {
  if (killAt === step) process.kill(process.pid, 'SIGKILL')
}

let line: Record<string, unknown>
if (mode === 'heartbeat') {
  const handle = await startRuntimeProcessHeartbeat(quiet)
  line = { pid: process.pid, heartbeat: handle.path ?? null }
  // A process killed outright leaves its file; one asked to stop removes it.
  process.once('SIGTERM', () => {
    void removeProcessHeartbeat(quiet).finally(() => process.exit(0))
  })
} else {
  if (barrier) {
    writeFileSync(`${barrier}.${process.pid}.ready`, '')
    while (!existsSync(barrier)) await Bun.sleep(5)
  }
  let removals = 0
  try {
    const layout = await prepareRuntimeLayout({
      version: process.env.RUNTIME_LAYOUT_TEST_VERSION ?? '3.0.14',
      log: quiet,
      steps: {
        afterManifest: () => {
          if (trace) appendFileSync(trace, `manifest ${process.pid}\n`)
          kill('afterManifest')()
        },
        afterCopy: kill('afterCopy'),
        afterMarker: kill('afterMarker'),
        // The second removal comes after the first old file is gone.
        beforeRemove: () => {
          removals++
          if (removals === 2) kill('midCleanup')()
        },
      },
    })
    line = { layout, pid: process.pid, vaultDir: getVaultDir() }
  } catch (error) {
    line = { error: error instanceof Error ? error.message : String(error) }
  }
}
process.stdout.write(`${JSON.stringify(line)}\n`)
if (mode === 'hold' || mode === 'heartbeat') setInterval(() => {}, 60_000)
