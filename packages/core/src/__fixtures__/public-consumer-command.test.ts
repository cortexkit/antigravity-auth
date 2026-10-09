import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createPublicCommandDiagnostic,
  PUBLIC_COMMAND_BOUNDS,
  runPublicConsumerCommand,
} from '../../../../scripts/prepare-common-auth-public-consumer.ts'
import {
  admitPublicConsumer,
  publicFixtureBytes,
  requirePublicConsumerRoot,
} from './common-auth-public-consumer.test.ts'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandIdentity,
  type PublicCommandInspector,
  type PublicCommandScope,
  signalPublicCommandMember,
} from './public-command-processes.test.ts'

const BOUNDS = {
  executionMs: 300,
  reapMs: 200,
  termGraceMs: 50,
  outputCapBytes: 4096,
}

function liveOwnedDescendant(
  pid: number,
  nonce: string,
  group: number,
): boolean {
  const probe = spawnSync(
    '/bin/ps',
    ['-p', String(pid), '-o', 'pid=,pgid=,stat=,args='],
    { encoding: 'utf8', timeout: 500, maxBuffer: 16 * 1024 },
  )
  if (probe.error) throw probe.error
  if (probe.status === 1 && !probe.stdout.trim()) return false
  if (probe.status !== 0)
    throw new Error(`owned descendant probe failed: ${probe.stderr}`)
  const match = probe.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/)
  if (!match || Number(match[1]) !== pid)
    throw new Error('owned descendant identity unavailable')
  if (match[3]?.startsWith('Z')) return false
  if (!match[4]?.includes(nonce) || Number(match[2]) !== group)
    throw new Error('owned descendant identity/group changed')
  return true
}

interface Receipt {
  nonce: string
  leader: number
  leaderStart: string
  descendant: number
  start: string
  group: number
  sid: number
  root: string
}

for (const [keepPipes, failInspection] of [
  [true, false],
  [false, false],
  [false, true],
] as const) {
  it(
    failInspection
      ? 'retains the fixture and primary failure when controlled live descendant cleanup cannot be confirmed'
      : `reaps controlled live descendants that outlive the leader with ${keepPipes ? 'retained' : 'closed'} pipes`,
    async () => {
      const paired =
        process.env.PUBLIC_COMMAND_OBSERVATION_DIAGNOSTIC === '1' &&
        !failInspection
      for (const periodic of paired
        ? [true, false, false, true]
        : [undefined]) {
        const diagnostic =
          periodic === undefined
            ? undefined
            : createPublicCommandDiagnostic(periodic)
        const witness = await realpath(
          await mkdtemp(
            join(await realpath(tmpdir()), 'agy-wrapper-descendant-'),
          ),
        )
        const nonce = randomUUID()
        const receiptPath = join(witness, 'receipt.json')
        const leader = join(witness, 'leader.mjs')
        await writeFile(
          leader,
          `
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      import { dirname } from 'node:path'
      import { createPublicCommandInspector } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'public-command-processes.test.ts')).href)}
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2500); setInterval(() => {}, 100)', '${nonce}'], {
        stdio: ${keepPipes ? "'inherit'" : "'ignore'"}, env: process.env,
      })
      descendant.unref()
      const inspector = await createPublicCommandInspector()
      const own = inspector.read(process.pid), member = inspector.read(descendant.pid)
      if (!own || !member) throw new Error('controlled live process identity unavailable')
      writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ nonce: '${nonce}', leader: own.pid, leaderStart: own.start.toString(), descendant: member.pid, start: member.start.toString(), group: own.pgid, sid: own.sid, root: dirname(process.env.HOME) }))
      inspector.close()
      process.exit(${failInspection ? 7 : 0})
    `,
        )
        let receipt: Receipt | undefined
        let result: number | undefined
        let failure: unknown
        let testFailure: unknown
        try {
          try {
            result = await runPublicConsumerCommand(
              [process.execPath, leader],
              BOUNDS,
              failInspection
                ? async () => {
                    const actual = await createPublicCommandInspector()
                    return {
                      read: actual.read,
                      session() {
                        throw new Error('injected owned inspection failure')
                      },
                      close: () => actual.close(),
                    }
                  }
                : createPublicCommandInspector,
              diagnostic,
            )
          } catch (error) {
            failure = error
          }
          receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
          if (!receipt || receipt.nonce !== nonce)
            throw new Error(
              'controlled live descendant receipt identity differs',
            )
          const alive = liveOwnedDescendant(
            receipt.descendant,
            nonce,
            receipt.group,
          )
          const rootExists = existsSync(receipt.root)
          console.log(
            JSON.stringify({
              cleanupProbe: failInspection
                ? 'unconfirmed'
                : keepPipes
                  ? 'retained-pipes'
                  : 'closed-pipes',
              ...receipt,
              alive,
              rootExists,
              result,
              error: String(failure ?? ''),
            }),
          )
          if (diagnostic)
            console.log(
              JSON.stringify({
                observationDiagnostic: true,
                witness: keepPipes ? 'retained-pipes' : 'closed-pipes',
                diagnostic,
              }),
            )
          if (failInspection) {
            expect(alive).toBe(true)
            expect(rootExists).toBe(true)
            expect(failure).toBeInstanceOf(AggregateError)
            if (!(failure instanceof AggregateError))
              throw new Error('cleanup aggregate absent')
            expect(failure.errors.map(String)).toEqual([
              'Error: test command exited with code 7',
              'Error: injected owned inspection failure',
            ])
          } else {
            expect(alive).toBe(false)
            expect(rootExists).toBe(false)
            expect(failure).toBeUndefined()
            expect(result).toBe(0)
          }
        } catch (error) {
          testFailure = error
        }
        try {
          if (
            receipt &&
            liveOwnedDescendant(receipt.descendant, nonce, receipt.group)
          ) {
            const actual = await createPublicCommandInspector()
            try {
              const own: PublicCommandIdentity = {
                pid: receipt.leader,
                ppid: process.pid,
                pgid: receipt.group,
                sid: receipt.sid,
                start: BigInt(receipt.leaderStart),
                zombie: false,
              }
              const member: PublicCommandIdentity = {
                pid: receipt.descendant,
                ppid: receipt.leader,
                pgid: receipt.group,
                sid: receipt.sid,
                start: BigInt(receipt.start),
                zombie: false,
              }
              signalPublicCommandMember(
                { leader: own, observed: new Map(), signals: [] },
                member,
                actual,
                'SIGKILL',
              )
              const deadline = performance.now() + 1000
              while (
                liveOwnedDescendant(receipt.descendant, nonce, receipt.group) &&
                performance.now() < deadline
              )
                await new Promise((resolve) => setTimeout(resolve, 10))
              if (liveOwnedDescendant(receipt.descendant, nonce, receipt.group))
                throw new Error(
                  'controlled live descendant cleanup unconfirmed',
                )
            } finally {
              actual.close()
            }
          }
          if (receipt && existsSync(receipt.root)) {
            requirePublicConsumerRoot(receipt.root)
            await admitPublicConsumer(receipt.root)
            const owner = JSON.parse(
              (
                await publicFixtureBytes(join(receipt.root, '.owner.json'))
              ).toString(),
            )
            if (
              owner.pid !== process.pid ||
              (await realpath(receipt.root)) !== receipt.root
            )
              throw new Error(
                'retained controlled live fixture ownership differs',
              )
            await rm(receipt.root, { recursive: true })
          }
          await rm(witness, { recursive: true })
        } catch (error) {
          throw new AggregateError(
            [...(testFailure === undefined ? [] : [testFailure]), error],
            'controlled live witness cleanup failed',
          )
        }
        if (testFailure) throw testFailure
      }
    },
  )
}

const LEADER: PublicCommandIdentity = {
  pid: 101,
  ppid: 10,
  pgid: 101,
  sid: 101,
  start: 100n,
  zombie: false,
}
const MEMBER: PublicCommandIdentity = {
  pid: 102,
  ppid: 101,
  pgid: 101,
  sid: 101,
  start: 110n,
  zombie: false,
}

function scope(): PublicCommandScope {
  return {
    leader: LEADER,
    observed: new Map([[MEMBER.pid, MEMBER]]),
    signals: [],
  }
}
function controlInspector(
  leader = LEADER,
  member = MEMBER,
): PublicCommandInspector {
  return {
    read: (pid) => (pid === LEADER.pid ? leader : member),
    session: () => [member],
    close() {},
  }
}

it('rejects PID birth-identity mismatch before dispatching any signal', () => {
  const sent: number[] = []
  expect(() =>
    signalPublicCommandMember(
      scope(),
      MEMBER,
      controlInspector(LEADER, { ...MEMBER, start: 111n }),
      'SIGTERM',
      (pid) => {
        sent.push(pid)
      },
    ),
  ).toThrow('PID birth identity changed')
  expect(sent).toEqual([])
})
it('rejects a reused leader or group identity before dispatching any signal', () => {
  const sent: number[] = []
  expect(() =>
    signalPublicCommandMember(
      scope(),
      MEMBER,
      controlInspector({ ...LEADER, start: 200n }),
      'SIGTERM',
      (pid) => {
        sent.push(pid)
      },
    ),
  ).toThrow('PID birth identity changed')
  expect(sent).toEqual([])
})
it('reports observed descendants outside the captured group or session as unresolved', () => {
  for (const changed of [
    { ...MEMBER, pgid: 102 },
    { ...MEMBER, sid: 102 },
  ])
    expect(() =>
      inspectPublicCommandScope(scope(), controlInspector(LEADER, changed)),
    ).toThrow('left captured session/group scope')
})
it('permits fresh exact identity controls but not larger production deadlines', async () => {
  const sent: number[] = []
  signalPublicCommandMember(
    scope(),
    MEMBER,
    controlInspector(),
    'SIGTERM',
    (pid) => {
      sent.push(pid)
    },
  )
  expect(sent).toEqual([MEMBER.pid])
  await expect(
    runPublicConsumerCommand(['bun'], {
      ...BOUNDS,
      executionMs: PUBLIC_COMMAND_BOUNDS.executionMs + 1,
    }),
  ).rejects.toThrow('must not exceed production')
})
