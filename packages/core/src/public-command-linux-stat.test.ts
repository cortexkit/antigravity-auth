import { expect, it, mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { linuxIdentity } from './__fixtures__/public-command-processes.test.ts'

// do_task_stat() leaves ppid=0, pgid=-1 and sid=-1 when lock_task_sighand()
// fails during teardown, but still emits the process start time (field 22).
// https://github.com/torvalds/linux/blob/v6.19/fs/proc/array.c#L473-L605
const teardownStat =
  '1234 (x) R 0 -1 -1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 123456\n'
const validStat =
  '1234 (x) S 12 1234 1234 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 123456\n'
const expectedIdentity = {
  pid: 1234,
  ppid: 12,
  pgid: 1234,
  sid: 1234,
  start: 123456n,
  zombie: false,
}

function refusal(text: string): string {
  try {
    linuxIdentity(1234, () => text)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected stat inspection to refuse')
}

it('reopens a Linux teardown stat before concluding the PID disappeared', () => {
  const readStat = mock(
    (_pid: number): string | undefined => undefined,
  ).mockReturnValueOnce(teardownStat)
  expect(linuxIdentity(1234, readStat)).toBeUndefined()
  expect(readStat.mock.calls).toEqual([[1234], [1234]])
})

it('uses a fresh valid identity after the Linux teardown sentinel', () => {
  const readStat = mock((_pid: number) => validStat).mockReturnValueOnce(
    teardownStat,
  )
  expect(linuxIdentity(1234, readStat)).toEqual(expectedIdentity)
  expect(readStat.mock.calls).toEqual([[1234], [1234]])
})

it('refuses a persistent Linux teardown sentinel after exactly one reopen', () => {
  const readStat = mock((_pid: number) => teardownStat)
  expect(() => linuxIdentity(1234, readStat)).toThrow(
    'process stat scope missing: pid=1234, stat="1234 (x) R 0 -1 -1',
  )
  expect(readStat.mock.calls).toEqual([[1234], [1234]])
})

it('does not hide an unreadable PID after the Linux teardown sentinel', () => {
  const denied = Object.assign(new Error('stat access denied'), {
    code: 'EACCES',
  })
  const readStat = mock((_pid: number): string => {
    throw denied
  }).mockReturnValueOnce(teardownStat)
  expect(() => linuxIdentity(1234, readStat)).toThrow(denied)
  expect(readStat.mock.calls).toEqual([[1234], [1234]])
})

it('refuses malformed scope on the fresh lookup rather than accepting it', () => {
  const readStat = mock((_pid: number) =>
    validStat.replace('S 12 1234 1234', 'S 12 -1 1234'),
  ).mockReturnValueOnce(teardownStat)
  expect(() => linuxIdentity(1234, readStat)).toThrow(
    'process stat scope missing',
  )
  expect(readStat.mock.calls).toEqual([[1234], [1234]])
})

it.each([
  '-1 -1 -1',
  '0 -2 -1',
  '0 -1 1234',
  '12 1234 -1',
  '12 nope 1234',
  '12 9007199254740992 1234',
])('refuses unsupported scope %s without retrying', (scope) => {
  const readStat = mock((_pid: number) =>
    validStat.replace('S 12 1234 1234', `S ${scope}`),
  )
  expect(() => linuxIdentity(1234, readStat)).toThrow(
    'process stat scope missing',
  )
  expect(readStat.mock.calls).toEqual([[1234]])
})

it.each([
  ') R 1 ',
  'a b',
  'a)\nb c\t)',
])('parses Linux comm %j without shifting scope or start time', (comm) => {
  const readStat = mock((_pid: number) => validStat.replace('(x)', `(${comm})`))
  expect(linuxIdentity(1234, readStat)).toEqual(expectedIdentity)
  expect(readStat.mock.calls).toEqual([[1234]])
})

it.each(['Z', 'X'])('preserves Linux zombie state %s', (state) => {
  expect(
    linuxIdentity(1234, () => validStat.replace(') S ', `) ${state} `)),
  ).toEqual({ ...expectedIdentity, zombie: true })
})

it.each([
  ['PID differs', validStat.replace('1234 (', '7 (')],
  ['identity missing', validStat.replace('123456\n', 'not-a-start\n')],
  ['identity missing', '1234 (x) S 12 1234 1234\n'],
  ['scope missing', validStat.replace('S 12 1234 1234', 'S 12 -2 1234')],
])('includes PID and the stat line when refusing %s', (reason, text) => {
  const message = refusal(text)
  expect(message).toContain(`process stat ${reason}: pid=1234, stat="`)
  expect(message).toContain(text.trim())
  expect(message).toContain('\\x0a"')
})

it('escapes control characters, quotes, backslashes and non-ASCII stat bytes', () => {
  const message = refusal(
    teardownStat.replace('(x)', '("\\\n\r\t\u001b\u007f\u0085é)'),
  )
  expect(message).toContain(
    '(\\"\\\\\\x0a\\x0d\\x09\\x1b\\x7f\\xc2\\x85\\xc3\\xa9)',
  )
  expect([...message].every((char) => char.charCodeAt(0) >= 0x20)).toBe(true)
  expect([...message].every((char) => char.charCodeAt(0) < 0x7f)).toBe(true)
})

it.each([
  'x',
  '\n',
  'é',
])('bounds the escaped stat preview to 256 bytes for repeated %j', (comm) => {
  const message = refusal(
    teardownStat.replace('(x)', `(${comm.repeat(300)}DO_NOT_INCLUDE)`),
  )
  const preview = message.split('stat=')[1] ?? ''
  expect(preview.startsWith('"1234 (')).toBe(true)
  expect(preview.endsWith('..."')).toBe(true)
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(256)
  expect(message).not.toContain('DO_NOT_INCLUDE')
})

it.skipIf(process.platform !== 'linux')(
  'reads real Linux stat records with delimiter-like comm names',
  () => {
    const originalComm = readFileSync('/proc/self/comm')
    const originalIdentity = linuxIdentity(process.pid)
    expect(originalIdentity).toBeDefined()
    try {
      for (const comm of [') R 1 ', 'a b', 'a)\nb c\t)']) {
        writeFileSync('/proc/self/comm', comm)
        expect(readFileSync('/proc/self/stat', 'utf8')).toContain(`(${comm}) `)
        expect(linuxIdentity(process.pid)).toEqual(originalIdentity)
      }
    } finally {
      writeFileSync('/proc/self/comm', originalComm)
    }
  },
)
