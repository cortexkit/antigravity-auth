import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPublicCommandDiagnostic,
  runPublicConsumerCommand,
} from '../../scripts/prepare-common-auth-public-consumer.ts'
import {
  createPublicCommandInspector,
  type PublicCommandIdentity,
} from '../../packages/core/src/__fixtures__/public-command-processes.test.ts'

const mode = process.argv[2] ?? 'normal'
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
const diagnostic = createPublicCommandDiagnostic(true)
const first = new Map<number, PublicCommandIdentity>()
const verified = new Map<number, PublicCommandIdentity>()
const changes: unknown[] = []
let leader: PublicCommandIdentity | undefined
let error: unknown
let result: number | undefined
try {
  result = await runPublicConsumerCommand(
    mode === 'canonical'
      ? [process.execPath, 'test', '--isolate', 'test/common-auth-094-adoption/embed-build']
      : ['python3', join(import.meta.dir, 'owned-group-witness.py'), mode, randomUUID()],
    { executionMs: 60_000, reapMs: 5_000, termGraceMs: 1_000, outputCapBytes: 1024 * 1024 },
    async () => {
      const native = await createPublicCommandInspector()
      function record(row: PublicCommandIdentity, rows: PublicCommandIdentity[] = []): void {
        if (!leader) {
          if (row.ppid !== process.pid || row.sid !== row.pid || row.pgid !== row.pid) return
          leader = row
          verified.set(row.pid, row)
        }
        const previous = first.get(row.pid)
        if (!previous) {
          first.set(row.pid, row)
          console.log(json({ event: 'first-native-observation', mode, row }))
        } else if (previous.start !== row.start || previous.pgid !== row.pgid || previous.sid !== row.sid) {
          changes.push({ previous, row })
          console.log(json({ event: 'identity-transition', mode, previous, row }))
        }
        const chain = [row]
        const seen = new Set([row.pid])
        let cursor = row
        while (!verified.has(cursor.pid)) {
          const parent = rows.find((candidate) => candidate.pid === cursor.ppid) ?? native.read(cursor.ppid)
          if (!parent || parent.sid !== leader.sid || cursor.start < parent.start || seen.has(parent.pid)) return
          chain.push(parent)
          seen.add(parent.pid)
          cursor = parent
        }
        const captured = verified.get(cursor.pid)!
        if (captured.start !== cursor.start || captured.sid !== cursor.sid || captured.pgid !== cursor.pgid) return
        const fresh = native.read(row.pid)
        if (!fresh || fresh.start !== row.start || fresh.sid !== row.sid || fresh.pgid !== row.pgid || fresh.zombie) return
        if (!verified.has(row.pid)) {
          const executable = readlinkSync(`/proc/${row.pid}/exe`)
          const argv = readFileSync(`/proc/${row.pid}/cmdline`).toString().split('\0').filter(Boolean)
          console.log(json({ event: 'owned-ancestry', mode, chain, executable, argv }))
        }
        verified.set(row.pid, row)
      }
      return {
        read(pid) {
          const row = native.read(pid)
          if (row) record(row)
          return row
        },
        session(sid) {
          const rows = native.session(sid)
          for (const row of rows) record(row, rows)
          return rows
        },
        close: () => native.close(),
        get counts() { return native.counts },
      }
    },
    diagnostic,
  )
} catch (caught) {
  error = caught
  console.error(caught)
}
console.log(json({ event: 'trace-completion', mode, result: result ?? null,
  error: error ? String(error) : null, errors: error instanceof AggregateError ? error.errors.map(String) : [],
  transitions: changes, first: [...first.values()], diagnostic }))
process.exitCode = error ? 1 : (result ?? 1)
