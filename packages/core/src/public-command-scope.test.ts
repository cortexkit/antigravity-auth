import { expect, it } from 'bun:test'
import {
  inspectPublicCommandScope,
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
