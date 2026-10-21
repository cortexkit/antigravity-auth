import { expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandArgvObservation,
  type PublicCommandIdentity,
  type PublicCommandInspector,
  type PublicCommandScope,
  signalPublicCommandMember,
} from './__fixtures__/public-command-processes.test.ts'

const leader: PublicCommandIdentity = {
  pid: 101,
  ppid: 10,
  pgid: 101,
  sid: 101,
  start: 100n,
  zombie: false,
}
const parent: PublicCommandIdentity = {
  ...leader,
  pid: 102,
  ppid: 101,
  start: 110n,
}
const child: PublicCommandIdentity = {
  ...parent,
  pid: 103,
  ppid: 102,
  pgid: 103,
  start: 120n,
}
function scope(): PublicCommandScope {
  return { leader, observed: new Map([[leader.pid, leader]]), signals: [] }
}
function inspector(rows: PublicCommandIdentity[]): PublicCommandInspector {
  return {
    read: (pid) => rows.find((row) => row.pid === pid),
    session: (sid) => rows.filter((row) => row.sid === sid),
    close() {},
  }
}

type DiagnosticIdentity = Omit<PublicCommandIdentity, 'start'> & {
  start: string
}
type AncestryDiagnostic = {
  phase: 'revalidation'
  candidate: DiagnosticIdentity
  expected: DiagnosticIdentity
  current: DiagnosticIdentity | null
  chain: DiagnosticIdentity[]
  endpoint: DiagnosticIdentity
  leader: DiagnosticIdentity
  monitor: { pid: number; ppid: number }
  directChildDiscovery: {
    children: {
      pid: number
      start: string
      commandLine: PublicCommandArgvObservation
    }[]
    omitted: number
  }
}

const ancestryRefusalPrefix = 'PUBLIC_COMMAND_ANCESTRY_REFUSAL='

function serializeIdentity(
  identity: PublicCommandIdentity,
): DiagnosticIdentity {
  return { ...identity, start: identity.start.toString() }
}

function readAncestryDiagnostic(messages: string[]): AncestryDiagnostic {
  expect(messages).toHaveLength(1)
  const message = messages[0]!
  expect(message.startsWith(ancestryRefusalPrefix)).toBe(true)
  return JSON.parse(
    message.slice(ancestryRefusalPrefix.length),
  ) as AncestryDiagnostic
}

function captureDiagnostics(action: () => void): string[] {
  const messages: string[] = []
  const originalError = console.error
  console.error = (message?: unknown) => messages.push(String(message))
  try {
    action()
  } finally {
    console.error = originalError
  }
  return messages
}

function expectAncestryRefusal(action: () => unknown): void {
  let refusal: unknown
  try {
    action()
  } catch (error) {
    refusal = error
  }
  expect(refusal).toBeInstanceOf(Error)
  expect((refusal as Error).message).toBe(
    'owned process parent/birth ancestry unavailable',
  )
}

it('admits a separately grouped child only through fresh parent/birth ancestry', () => {
  const owned = scope()
  // Deliberately enumerate the child first, before its uncaptured parent.
  const native = inspector([child, parent, leader])
  expect(inspectPublicCommandScope(owned, native)).toHaveLength(3)
  expect(owned.observed.get(child.pid)).toEqual(child)
  const sent: number[] = []
  signalPublicCommandMember(owned, child, native, 'SIGTERM', (pid) =>
    sent.push(pid),
  )
  expect(sent).toEqual([child.pid])
})

it('refuses an unseen same-session orphan rather than retrospectively adopting it', () => {
  const owned = scope()
  expect(() =>
    inspectPublicCommandScope(
      owned,
      inspector([leader, { ...child, ppid: 1 }]),
    ),
  ).toThrow('parent/birth ancestry unavailable')
  expect(owned.observed.has(child.pid)).toBe(false)
  expect(owned.signals).toEqual([])
})

it('refuses a parent born after the candidate child', () => {
  const owned = scope()
  expect(() =>
    inspectPublicCommandScope(
      owned,
      inspector([child, { ...parent, start: 130n }, leader]),
    ),
  ).toThrow('parent/birth ancestry unavailable')
  expect(owned.observed.has(child.pid)).toBe(false)
})

it.skipIf(process.platform !== 'linux')(
  'includes unmatched candidate proc diagnostics when refusing ancestry through init',
  () => {
    const capturedLeader = { ...leader, pid: process.pid + 1 }
    const owned: PublicCommandScope = {
      leader: capturedLeader,
      observed: new Map([[capturedLeader.pid, capturedLeader]]),
      signals: [],
    }
    const orphan = { ...child, pid: process.pid, ppid: 1 }
    const init = { ...leader, pid: 1, ppid: 0, pgid: 1, sid: 1, start: 1n }
    let message = ''
    try {
      inspectPublicCommandScope(
        owned,
        inspector([capturedLeader, orphan, init]),
      )
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('owned process left captured session/group scope')
    const diagnostic = JSON.parse(message.split('; unmatched ancestry: ')[1]!)
    expect(diagnostic.member.pid).toBe(process.pid)
    expect(diagnostic.member.start).toBe('120')
    expect(diagnostic.leader.start).toBe('100')
    expect(
      diagnostic.chain.map((member: { pid: number }) => member.pid),
    ).toEqual([process.pid])
    expect(diagnostic.proc.cmdline).toContain(process.argv0)
    expect(diagnostic.proc.cmdline).toContain('test')
    expect(diagnostic.proc.status).toContain(`Pid:\t${process.pid}\n`)
    expect([...owned.observed.keys()]).toEqual([capturedLeader.pid])
    expect(owned.signals).toEqual([])
  },
)

it('refuses a reused captured ancestor before admitting its candidate child', () => {
  const owned = scope()
  owned.observed.set(parent.pid, parent)
  const native = inspector([child, { ...parent, start: 111n }, leader])
  expect(() => inspectPublicCommandScope(owned, native)).toThrow(
    'PID birth identity changed',
  )
  expect(owned.observed.has(child.pid)).toBe(false)
})

it('retains captured descendants after parent and leader exit', () => {
  const owned = scope()
  inspectPublicCommandScope(owned, inspector([leader, parent, child]))
  const orphan = { ...child, ppid: 1 }
  const native = inspector([orphan])
  expect(inspectPublicCommandScope(owned, native)).toEqual([orphan])
  const sent: number[] = []
  signalPublicCommandMember(owned, child, native, 'SIGTERM', (pid) =>
    sent.push(pid),
  )
  expect(sent).toEqual([child.pid])
})

it('rechecks ancestry birth identities before recording a new descendant', () => {
  const owned = scope()
  const native = inspector([child, parent, leader])
  let parentReads = 0
  const racing = {
    ...native,
    read(pid: number) {
      if (pid === parent.pid && ++parentReads > 1)
        return { ...parent, start: 111n }
      return native.read(pid)
    },
  }
  expect(() => inspectPublicCommandScope(owned, racing)).toThrow(
    'PID birth identity changed',
  )
  expect(owned.observed.has(child.pid)).toBe(false)
})

it('drops a member that disappears during ancestry revalidation', () => {
  const owned = scope()
  const reads: number[] = []
  const native: PublicCommandInspector = {
    read(pid) {
      reads.push(pid)
      if (pid === child.pid) return undefined
      return [parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }
  const messages = captureDiagnostics(() => {
    expect(inspectPublicCommandScope(owned, native)).toEqual([])
  })

  expect(reads).toEqual([
    leader.pid,
    leader.pid,
    parent.pid,
    leader.pid,
    child.pid,
    parent.pid,
    leader.pid,
  ])
  expect(messages).toEqual([])
  expect(owned.observed.has(child.pid)).toBe(false)
  expect([...owned.observed.keys()]).toEqual([leader.pid])
  expect(owned.signals).toEqual([])
})

it('drops a member that becomes a zombie during ancestry revalidation', () => {
  const owned = scope()
  const zombie = { ...child, zombie: true }
  const reads: number[] = []
  const native: PublicCommandInspector = {
    read(pid) {
      reads.push(pid)
      if (pid === child.pid) return zombie
      return [parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }
  const messages = captureDiagnostics(() => {
    expect(inspectPublicCommandScope(owned, native)).toEqual([])
  })

  expect(reads.slice(-3)).toEqual([child.pid, parent.pid, leader.pid])
  expect(messages).toEqual([])
  expect(owned.observed.has(child.pid)).toBe(false)
  expect([...owned.observed.keys()]).toEqual([leader.pid])
  expect(owned.signals).toEqual([])
})

it('still refuses a zombie endpoint during ancestry revalidation', () => {
  const owned = scope()
  const zombieLeader = { ...leader, zombie: true }
  let endpointCheckPending = false
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === parent.pid) {
        endpointCheckPending = true
        return parent
      }
      if (pid === leader.pid && endpointCheckPending) return zombieLeader
      return [parent, leader].find((row) => row.pid === pid)
    },
    session: () => [parent],
    close() {},
  }
  const messages = captureDiagnostics(() =>
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native)),
  )

  const diagnostic = readAncestryDiagnostic(messages)
  expect(diagnostic.expected).toEqual(serializeIdentity(leader))
  expect(diagnostic.current).toEqual(serializeIdentity(zombieLeader))
  expect([...owned.observed.keys()]).toEqual([leader.pid])
  expect(owned.signals).toEqual([])
})

it('still refuses a zombie middle ancestor during ancestry revalidation', () => {
  const owned = scope()
  const zombieParent = { ...parent, zombie: true }
  let parentReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === parent.pid && ++parentReads === 2) return zombieParent
      return [child, parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }
  const messages = captureDiagnostics(() =>
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native)),
  )

  const diagnostic = readAncestryDiagnostic(messages)
  expect(diagnostic.expected).toEqual(serializeIdentity(parent))
  expect(diagnostic.current).toEqual(serializeIdentity(zombieParent))
  expect(owned.observed.has(child.pid)).toBe(false)
  expect(owned.signals).toEqual([])
})

it('still refuses a candidate whose PID birth identity changed during revalidation', () => {
  const owned = scope()
  let childReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === child.pid && ++childReads === 1)
        return { ...child, start: child.start + 1n }
      return [child, parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }

  expect(() => inspectPublicCommandScope(owned, native)).toThrow(
    'owned process PID birth identity changed',
  )
  expect(owned.observed.has(child.pid)).toBe(false)
  expect(owned.signals).toEqual([])
})

it('still refuses a candidate whose parent changed during ancestry revalidation', () => {
  const owned = scope()
  let childReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === child.pid && ++childReads === 1)
        return { ...child, ppid: leader.pid }
      return [child, parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }

  expect(() => inspectPublicCommandScope(owned, native)).toThrow(
    'owned process parent/birth ancestry changed',
  )
  expect(owned.observed.has(child.pid)).toBe(false)
  expect(owned.signals).toEqual([])
})

it('retains discovery argv and birth when the endpoint disappears at revalidation', () => {
  const owned = scope()
  const events: string[] = []
  const argv = ['inert-child', '--discovery-marker']
  let leaderReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      events.push(`read:${pid}`)
      if (pid === parent.pid) {
        argv[1] = '--late-lookup-would-be-wrong'
        return parent
      }
      if (pid === leader.pid) return ++leaderReads === 4 ? undefined : leader
      return undefined
    },
    session: () => [parent],
    observeArgv(identity) {
      events.push(`argv:${identity.pid}:${identity.start}`)
      return { status: 'available', argv }
    },
    close() {},
  }
  const messages = captureDiagnostics(() =>
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native)),
  )
  const diagnostic = readAncestryDiagnostic(messages)
  expect(diagnostic.current).toBeNull()
  expect(diagnostic.expected).toEqual(serializeIdentity(leader))
  expect(diagnostic.directChildDiscovery).toEqual({
    children: [
      {
        pid: parent.pid,
        start: parent.start.toString(),
        commandLine: {
          status: 'available',
          argv: ['inert-child', '--discovery-marker'],
        },
      },
    ],
    omitted: 0,
  })
  expect(events).toEqual([
    `read:${leader.pid}`,
    `read:${leader.pid}`,
    `argv:${parent.pid}:${parent.start}`,
    `read:${leader.pid}`,
    `read:${parent.pid}`,
    `read:${leader.pid}`,
  ])
  const sent: number[] = []
  expect(() =>
    signalPublicCommandMember(owned, parent, native, 'SIGTERM', (pid) =>
      sent.push(pid),
    ),
  ).toThrow('not captured before signal')
  expect([...owned.observed.values()]).toEqual([leader])
  expect(owned.signals).toEqual([])
  expect(sent).toEqual([])
})

it.each([
  'unavailable',
  'throws',
  'absent',
] as const)('labels discovery argv %s without changing the endpoint refusal', (mode) => {
  const owned = scope()
  let leaderReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === leader.pid) return ++leaderReads === 4 ? undefined : leader
      return pid === parent.pid ? parent : undefined
    },
    session: () => [parent],
    close() {},
  }
  if (mode !== 'absent')
    native.observeArgv = () => {
      if (mode === 'throws') throw new Error('observer failure')
      return {
        status: 'unavailable',
        reason: 'child already exited at discovery',
      }
    }
  const messages = captureDiagnostics(() =>
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native)),
  )
  const diagnostic = readAncestryDiagnostic(messages)
  expect(diagnostic.expected).toEqual(serializeIdentity(leader))
  expect(diagnostic.directChildDiscovery.children).toEqual([
    {
      pid: parent.pid,
      start: parent.start.toString(),
      commandLine: {
        status: 'unavailable',
        reason:
          mode === 'unavailable'
            ? 'child already exited at discovery'
            : mode === 'throws'
              ? 'discovery argv observer failed'
              : 'discovery argv observer unavailable',
      },
    },
  ])
  expect([...owned.observed.values()]).toEqual([leader])
  expect(owned.signals).toEqual([])
})

it('bounds direct-child discovery storage and explicitly counts omitted observations', () => {
  const owned = scope()
  const children = Array.from({ length: 35 }, (_, index) => ({
    ...parent,
    pid: 200 + index,
  }))
  let observations = 0
  let leaderReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === leader.pid) return ++leaderReads === 4 ? undefined : leader
      return children.find((row) => row.pid === pid)
    },
    session: () => children,
    observeArgv() {
      observations++
      return { status: 'unavailable', reason: 'not readable' }
    },
    close() {},
  }
  const messages = captureDiagnostics(() =>
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native)),
  )
  const discovery = readAncestryDiagnostic(messages).directChildDiscovery
  expect(discovery.children).toHaveLength(32)
  expect(discovery.omitted).toBe(3)
  expect(observations).toBe(32)
  expect([...owned.observed.values()]).toEqual([leader])
  expect(owned.signals).toEqual([])
})

it.skipIf(process.platform !== 'linux')(
  'observes bounded Linux argv only for the sampled birth of an owned inert child',
  async () => {
    const native = await createPublicCommandInspector()
    const marker = 'owned-discovery-marker'
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '-e',
        'setTimeout(() => {}, 1000)',
        marker,
        'x'.repeat(8192),
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    )
    const exitWithin = (milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        subprocess.exited.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds)
        }),
      ]).finally(() => clearTimeout(timer))
    }
    // Supervise runtime startup and exit independently of the child's own timer.
    const supervisedExit = exitWithin(2000)
    try {
      const identity = native.read(subprocess.pid)
      expect(identity).toBeDefined()
      if (!identity || !native.observeArgv)
        throw new Error('Linux observer unavailable')
      const observation = native.observeArgv(identity)
      expect(observation.status).toBe('truncated')
      if (observation.status === 'unavailable')
        throw new Error(observation.reason)
      expect(observation.argv).toContain(marker)
      expect(
        Buffer.byteLength(observation.argv.join('\0')),
      ).toBeLessThanOrEqual(4096)
      expect(
        native.observeArgv({ ...identity, start: identity.start + 1n }),
      ).toEqual({
        status: 'unavailable',
        reason: 'birth unavailable before argv read',
      })
      expect(await supervisedExit).toBe(true)
    } finally {
      try {
        if (subprocess.exitCode === null && subprocess.signalCode === null)
          subprocess.kill('SIGKILL')
        expect(await exitWithin(1000)).toBe(true)
      } finally {
        native.close()
      }
    }
  },
)

it('keeps successful ancestry inspection calls unchanged and emits no diagnostic', () => {
  const owned = scope()
  const reads: number[] = []
  const sessions: number[] = []
  const native: PublicCommandInspector = {
    read(pid) {
      reads.push(pid)
      return [child, parent, leader].find((row) => row.pid === pid)
    },
    session(sid) {
      sessions.push(sid)
      return [child]
    },
    close() {},
  }
  const messages = captureDiagnostics(() => {
    expect(inspectPublicCommandScope(owned, native)).toEqual([child])
  })

  expect(reads).toEqual([
    leader.pid,
    leader.pid,
    parent.pid,
    leader.pid,
    child.pid,
    parent.pid,
    leader.pid,
  ])
  expect(sessions).toEqual([leader.sid])
  expect(messages).toEqual([])
  expect(owned.observed.get(child.pid)).toEqual(child)
})

it('emits no diagnostic or file output for successful direct-child discovery', () => {
  const owned = scope()
  const native = inspector([parent, leader])
  let observations = 0
  native.observeArgv = () => {
    observations++
    return { status: 'available', argv: ['inert-child'] }
  }
  const writes = [
    spyOn(fs, 'writeSync'),
    spyOn(fs, 'writeFileSync'),
    spyOn(fs, 'appendFileSync'),
    spyOn(Bun, 'write'),
  ]
  const logs = [spyOn(console, 'log'), spyOn(console, 'warn')]
  try {
    const messages = captureDiagnostics(() => {
      expect(inspectPublicCommandScope(owned, native)).toEqual([parent, leader])
    })
    expect(observations).toBe(1)
    expect(messages).toEqual([])
    for (const output of [...writes, ...logs])
      expect(output).not.toHaveBeenCalled()
    expect(owned.observed.get(parent.pid)).toEqual(parent)
    expect(owned.signals).toEqual([])
  } finally {
    for (const output of [...writes, ...logs]) output.mockRestore()
  }
})

it('preserves ancestry refusal when the diagnostic sink throws', () => {
  const owned = scope()
  let leaderReads = 0
  const native: PublicCommandInspector = {
    read(pid) {
      if (pid === leader.pid) return ++leaderReads === 4 ? undefined : leader
      if (pid === child.pid) return child
      return [parent, leader].find((row) => row.pid === pid)
    },
    session: () => [child],
    close() {},
  }
  const originalError = console.error
  let sinkCalls = 0
  console.error = () => {
    sinkCalls += 1
    throw new Error('diagnostic sink failed')
  }
  try {
    expectAncestryRefusal(() => inspectPublicCommandScope(owned, native))
  } finally {
    console.error = originalError
  }

  const sent: number[] = []
  expect(() =>
    signalPublicCommandMember(owned, child, native, 'SIGTERM', (pid) =>
      sent.push(pid),
    ),
  ).toThrow('not captured before signal')
  expect(sinkCalls).toBe(1)
  expect(owned.observed.has(child.pid)).toBe(false)
  expect(owned.signals).toEqual([])
  expect(sent).toEqual([])
})

it('refuses changed recorded PGID or SID before dispatching a signal', () => {
  const owned = scope()
  inspectPublicCommandScope(owned, inspector([leader, parent, child]))
  for (const changed of [
    { ...child, pgid: leader.pgid },
    { ...child, sid: 104 },
  ]) {
    const sent: number[] = []
    expect(() =>
      signalPublicCommandMember(
        owned,
        child,
        inspector([changed]),
        'SIGTERM',
        (pid) => sent.push(pid),
      ),
    ).toThrow('left captured session/group scope')
    expect(sent).toEqual([])
  }
})

it('requires capture before signaling and treats an owned ESRCH as benign', () => {
  const owned = scope()
  const native = inspector([leader, parent, child])
  expect(() =>
    signalPublicCommandMember(owned, child, native, 'SIGTERM', () => {
      throw new Error('unexpected dispatch')
    }),
  ).toThrow('not captured before signal')
  inspectPublicCommandScope(owned, native)
  expect(() =>
    signalPublicCommandMember(owned, child, native, 'SIGTERM', () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }),
  ).not.toThrow()
  expect(owned.signals).toEqual([])
})
