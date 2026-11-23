// Maintainer tool, run after merging a slice that fixes parity rows:
//   bun test --preload ./test/setup.ts ./packages/e2e-tests/src/host-parity/refresh-known.ts
// (run through bun test so the root preload's isolated HOME and test root
// apply; the file name keeps it out of the root suite's discovery)
// It runs the shared parity gate and rewrites the shared known-failure list
// from the gate's own messages. Removes entries that pass now or
// didn't run, and records the observed digest for every still-failing field.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import { requestCases } from './cases.ts'
import { checkCorpus } from './gate.ts'
import { caseLedger } from './gate-data.ts'
import { responseScenarios } from './scenarios.ts'

test('refresh the shared known-failure list', async () => {
  const path = join(import.meta.dir, 'known-failures.json')
  const list: [string, string, string?][] = JSON.parse(readFileSync(path, 'utf8'))
  const known = new Map(list.map((e) => [e[0], e]))
  let message = ''
  // Review every ADDED line before committing: an added entry is a new
  // difference, which is only acceptable when the merged slice explains it.
  try { await checkCorpus(); console.log('GATE_GREEN') } catch (e) { message = String((e as Error).message)
    console.log('GATE_ERROR', message.split('\n')[0]?.slice(0, 400))
    if (!message.startsWith('Host parity found')) throw e }
  const ledgerOf = (name: string) => {
    const id = JSON.parse(name)[0]
    const c = requestCases.find((x) => x.id === id)
    if (c) return caseLedger(c)
    return responseScenarios.find((s) => s.input.id === id)?.ledger
  }
  let removed = 0, updated = 0, added = 0, other: string[] = []
  for (const line of message.split('\n').slice(1)) {
    let m = line.match(/^(\[.*?\]) passes now: remove the known failure$/) ?? line.match(/^(\[.*?\]): known failure did not run$/)
    if (m) { if (known.delete(m[1]!)) removed++; continue }
    m = line.match(/^(\[.*?\]): expected .*\[([0-9a-f]{64})\]$/)
    if (m) {
      const ledger = ledgerOf(m[1]!)
      const entry: [string, string, string?] = ledger ? [m[1]!, m[2]!, ledger] : [m[1]!, m[2]!]
      if (known.has(m[1]!)) updated++; else { added++; console.log('ADDED', m[1]) }
      known.set(m[1]!, entry); continue
    }
    if (line.trim()) other.push(line)
  }
  writeFileSync(path, `${JSON.stringify([...known.values()], null, 2)}\n`)
  console.log(`REFRESH removed=${removed} updated=${updated} added=${added} total=${known.size} other=${other.length}`)
  for (const l of other.slice(0, 30)) console.log('OTHER', l.slice(0, 300))
  for (const l of message.split('\n').slice(1)) if (/"wire\.contents"|"wire\.body"/.test(l) && !/passes now|did not run/.test(l)) console.log('WIRE', l.slice(0, 200))
}, 1_200_000)
