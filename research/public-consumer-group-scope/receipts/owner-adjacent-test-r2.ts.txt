import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
} from '../../core/src/__fixtures__/public-command-processes.test.ts'
import {
  finite,
  runNativeActivation,
  SYNTHETIC_PROJECT,
  SYNTHETIC_TOKEN,
  signalOwnedChildren,
  startChild,
  TERMINAL_TEXT,
} from './v1-vault-activation-harness.ts'

it('official 1.17.13 absent-auth first request activates and serves the approved vault', async () => {
  const receipt = await runNativeActivation()
  console.log(
    `NATIVE_V1_RECEIPT_GZIP_BASE64 ${gzipSync(JSON.stringify(receipt)).toString('base64')}`,
  )
  expect(receipt.error).toBeUndefined()
  expect(receipt.binary.version).toBe('1.17.13')
  expect(receipt.authAbsentBefore).toBe(true)
  expect(receipt.localArtifactsAbsentBefore).toBe(true)
  expect(receipt.marker).toEqual({
    google: {
      type: 'oauth',
      access: '',
      refresh: 'claustrum-tombstone:v1:google',
      expires: 0,
    },
  })
  const login = receipt.processes.find((child) => child.name === 'login')!
  const run = receipt.processes.find((child) => child.name === 'first-request')!
  expect(login.exitCode).toBe(0)
  expect(run.exitCode).toBe(0)
  const events = run.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { type: string; part?: { text?: string } },
    )
  expect(
    events.some(
      (event) => event.type === 'text' && event.part?.text === TERMINAL_TEXT,
    ),
  ).toBe(true)
  expect(events.some((event) => event.type === 'step_finish')).toBe(true)
  expect(receipt.requests).toHaveLength(1)
  const first = receipt.requests[0]!
  expect(first.path).toBe('/v1internal:streamGenerateContent')
  expect(first.authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
  expect(first.body).toMatchObject({
    project: SYNTHETIC_PROJECT,
    model: 'gemini-3.8-flash-high',
  })
  const gets = receipt.vaultCalls.filter(
    (call) => call.method === 'credential.get_scoped',
  )
  expect(gets.length).toBeGreaterThan(0)
  for (const get of gets)
    expect(get).toEqual({
      method: 'credential.get_scoped',
      params: {
        credential_id: 'synthetic-credential',
        enrollment_token: 'ab'.repeat(32),
        min_ttl_ms: 300000,
      },
    })
  expect(
    receipt.vaultCalls.some((call) => call.protocolError || call.socketError),
  ).toBe(false)
  expect(
    receipt.observations.some(
      (event) =>
        event.kind === 'native-loader-result' && event.hasFetch === true,
    ),
  ).toBe(true)
  const methods = receipt.observations.filter(
    (event) => event.kind === 'methods',
  )
  expect(methods.length).toBeGreaterThan(0)
  expect(
    methods.every(
      (event) =>
        JSON.stringify(event.labels) ===
        JSON.stringify(['Activate approved Antigravity vault']),
    ),
  ).toBe(true)
  expect(
    receipt.observations.filter(
      (event) =>
        event.kind === 'forbidden-network' || event.kind === 'forbidden-oauth',
    ),
  ).toEqual([])
  expect(receipt.localFileSyscalls).toEqual([])
  expect(
    receipt.processes.every((child) => !child.timedOut && child.reaped),
  ).toBe(true)
}, 150000)

it('owned signaling rejects reused birth identities and tolerates a signal-exit ESRCH race', async () => {
  const root = mkdtempSync('/tmp/native-v1-identity-')
  const inspector = await createPublicCommandInspector()
  const child = startChild(
    'identity-control',
    ['/usr/bin/sleep', '30'],
    root,
    { PATH: process.env.PATH },
    30000,
    inspector,
  )
  let dispatched = 0
  const dispatch = () => {
    dispatched++
  }
  try {
    expect(() =>
      signalOwnedChildren(
        {
          ...child.scope,
          leader: {
            ...child.scope.leader,
            start: child.scope.leader.start + 1n,
          },
        },
        inspector,
        'SIGTERM',
        dispatch,
      ),
    ).toThrow('birth identity changed')
    expect(() =>
      signalOwnedChildren(
        {
          ...child.scope,
          observed: new Map([
            [
              child.scope.leader.pid,
              { ...child.scope.leader, start: child.scope.leader.start + 1n },
            ],
          ]),
        },
        inspector,
        'SIGTERM',
        dispatch,
      ),
    ).toThrow('birth identity changed')
    expect(dispatched).toBe(0)
    expect(() =>
      signalOwnedChildren(child.scope, inspector, 'SIGTERM', () => {
        dispatched++
        throw Object.assign(
          new Error('process exited between validation and signal'),
          { code: 'ESRCH' },
        )
      }),
    ).not.toThrow()
    expect(dispatched).toBe(1)
    expect(child.scope.signals).toEqual([])
  } finally {
    await child.stop()
    inspector.close()
    rmSync(root, { recursive: true })
  }
  expect(child.receipt.reaped).toBe(true)
}, 10000)

it('owned cleanup kills a surviving descendant after its session leader exits', async () => {
  const root = mkdtempSync('/tmp/native-v1-descendant-')
  const inspector = await createPublicCommandInspector()
  const captured = join(root, 'ancestry-captured')
  const child = startChild(
    'descendant-control',
    [
      '/usr/bin/python3',
      '-c',
      [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid==0:',
        '  time.sleep(30)',
        'else:',
        '  print(pid,flush=True)',
        '  deadline=time.monotonic()+5',
        '  while not os.path.exists(sys.argv[1]):',
        '    if time.monotonic()>=deadline: sys.exit(2)',
        '    time.sleep(0.01)',
      ].join('\n'),
      captured,
    ],
    root,
    { PATH: process.env.PATH },
    30000,
    inspector,
  )
  try {
    const captureDeadline = performance.now() + 1000
    while (!child.receipt.stdout.trim()) {
      if (performance.now() >= captureDeadline)
        throw new Error('Session leader did not report its descendant')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    const descendant = Number(child.receipt.stdout.trim())
    expect(descendant).toBeGreaterThan(0)
    // Capture the child while its parent can prove ancestry. Cleanup must
    // retain that identity after the parent exits, not adopt an unseen orphan.
    expect(
      inspectPublicCommandScope(child.scope, inspector).some(
        (member) => member.pid === descendant,
      ),
    ).toBe(true)
    writeFileSync(captured, 'captured', { flag: 'wx', mode: 0o600 })
    await finite(child.exited, 5000, 'Session leader did not exit')
    expect(
      inspectPublicCommandScope(child.scope, inspector).some(
        (member) => member.pid === descendant,
      ),
    ).toBe(true)
    await child.stop()
    expect(child.receipt.exitCode).toBe(0)
    expect(child.receipt.reaped).toBe(true)
    expect(inspectPublicCommandScope(child.scope, inspector)).toEqual([])
    expect(
      child.scope.signals.some((signal) => signal.pid === descendant),
    ).toBe(true)
  } finally {
    await child.stop()
    inspector.close()
    rmSync(root, { recursive: true })
  }
}, 10000)
