import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  accountWriteLines,
  emitUpgradeReceipt,
  isAccountPath,
  runUnmigratedUpgrade,
  UPGRADE_REFUSAL,
  type UpgradeReceipt,
} from './v1-unmigrated-upgrade-harness.ts'

const EVIDENCE = resolve(
  import.meta.dir,
  '../../../research/v1-unmigrated-upgrade',
)

// The recorded 2.2.1-to-3.0.0 native upgrade served requests and rewrote its pool.
// These detectors must report its physical sends and legacy-file mutations.
describe('upgrade evidence controls', () => {
  test('upgrade write fence detects the preserved native pool lock and replacement', () => {
    const baseline = JSON.parse(
      readFileSync(
        `${EVIDENCE}/decoded/bash-908b0af4c4425b60/receipt.json`,
        'utf8',
      ),
    )
    const writes = accountWriteLines(baseline.traces.server)
    expect(
      writes.some(
        (line: string) =>
          line.includes('.accounts.lock') && line.includes('O_EXCL'),
      ),
    ).toBe(true)
    expect(writes.some((line: string) => line.includes('rename('))).toBe(true)
    expect(writes.some((line: string) => line.includes('chmod('))).toBe(true)
    expect(
      accountWriteLines(
        'write(2<pipe:[123]>, "credential and antigravity-accounts diagnostic", 20) = 20',
      ),
    ).toEqual([])
    expect(
      accountWriteLines(
        'write(20</tmp/owned/antigravity-accounts.json>, "changed", 7) = 7',
      ),
    ).toHaveLength(1)
    expect(
      accountWriteLines(
        'openat(AT_FDCWD, "/tmp/owned/auth.json", O_WRONLY|O_TRUNC) = 20',
      ),
    ).toHaveLength(1)
    expect(
      accountWriteLines(
        'openat(AT_FDCWD, "/tmp/owned/auth.json", O_RDONLY) = 20',
      ),
    ).toEqual([])
  })
  test('upgrade send and native error controls distinguish the preserved serving baseline', () => {
    const baseline = JSON.parse(
      readFileSync(
        `${EVIDENCE}/decoded/bash-908b0af4c4425b60/receipt.json`,
        'utf8',
      ),
    )
    expect(baseline.tlsRequests).toHaveLength(2)
    for (const request of baseline.requests) {
      const response = JSON.parse(request.body)
      expect(response.info.error).toBeUndefined()
      expect(request.body).toContain('GA_OK_92030db9b50646b1fec6f038159d5ead')
      expect(request.body).not.toContain(UPGRADE_REFUSAL)
    }
  })
})

describe('running native unmigrated upgrade', () => {
  let receipt: UpgradeReceipt
  beforeAll(async () => {
    receipt = await runUnmigratedUpgrade()
    emitUpgradeReceipt(receipt)
  }, 120000)

  test('upgrade native setup, default producers and owned shutdown are measured', () => {
    expect(receipt.error).toBeUndefined()
    expect(receipt.pluginSettings).toBe(
      'No antigravity.json overrides; production defaults remain enabled',
    )
    expect(receipt.requests).toHaveLength(2)
    for (const process of receipt.processes) {
      expect(process.reaped).toBe(true)
      expect(process.timedOut).toBe(false)
      expect(process.signalFailures).toEqual([])
    }
  })

  for (const index of [1, 2]) {
    test(`upgrade request ${index} terminates with the exact nonretryable native 412 message`, () => {
      const request = receipt.requests[index - 1]!
      expect(request).toBeDefined()
      const response = JSON.parse(request.body)
      expect(response.info.error.name).toBe('APIError')
      expect(response.info.error.data.statusCode).toBe(412)
      expect(response.info.error.data.isRetryable).toBe(false)
      expect(response.info.error.data.message).toBe(UPGRADE_REFUSAL)
      expect(
        response.parts.some(
          (part: { type: string; text?: string }) =>
            part.type === 'text' && Boolean(part.text),
        ),
      ).toBe(false)
      expect(request.body).not.toContain('GA_OK_')
    })
  }

  test('upgrade same running native PID and birth remain alive across both refusals without retry', () => {
    const startup = receipt.startupLiveness as { pid: number; start: string }
    for (const request of receipt.requests) {
      const live = request.liveness as {
        pid: number
        start: string
        zombie: boolean
        leaderExit: null
      }
      expect(live.pid).toBe(startup.pid)
      expect(live.start).toBe(startup.start)
      expect(live.zombie).toBe(false)
      expect(live.leaderExit).toBeNull()
    }
    const server = receipt.processes.find(
      (process) => process.name === 'running-server',
    )!
    expect(server.stderr).not.toMatch(/message="?retry\b|type[=:]"?retry\b/)
    expect(
      server.stderr.match(/level=INFO .*message=process session\.id=/g) ?? [],
    ).toHaveLength(2)
  })

  for (const kind of ['generation', 'oauth', 'project', 'quota', 'unknown']) {
    test(`upgrade physical ${kind} boundary counter stays zero before migration`, () => {
      const calls = receipt.negativeCalls as { kind: string }[]
      expect(calls).toBeDefined()
      expect(calls.filter((call) => call.kind === kind)).toEqual([])
    })
  }
  test('upgrade negative TLS and OAuth DNS attempts stay zero', () => {
    expect(receipt.negativeTlsEvents).toEqual([])
    const queries = receipt.negativeDnsQueries as { name: string }[]
    expect(
      queries.filter((query) => query.name === 'oauth2.googleapis.com'),
    ).toEqual([])
    expect(receipt.traces.negative).not.toMatch(/connect\(.*htons\(443\)/)
  })

  for (const name of [
    'before-new-host-startup',
    'after-request-1',
    'after-request-2',
    'after-negative-host-cleanup',
  ]) {
    test(`upgrade original pool and credential bytes and metadata remain identical ${name}`, () => {
      const before = receipt.snapshots.find(
        (snapshot) => snapshot.name === 'before-old-writer-shutdown',
      )!
      const after = receipt.snapshots.find(
        (snapshot) => snapshot.name === name,
      )!
      expect(after).toBeDefined()
      expect(after.accountBytes).toBe(before.accountBytes)
      const accounts = (files: typeof before.files) =>
        Object.fromEntries(
          Object.entries(files).filter(([path]) => isAccountPath(path)),
        )
      expect(accounts(after.files)).toEqual(accounts(before.files))
    })
  }
  test('upgrade account write fence observes zero pool, credential, statefile and sidecar mutations', () => {
    expect(accountWriteLines(receipt.traces.negative!)).toEqual([])
  })

  test('upgrade native approved vault serves dormant auth while explicit activation refuses the occupied Google slot', () => {
    const vault = receipt.vault as {
      status: number
      body: string
      nonce: string
      calls: { kind: string; body: string; headers: string[] }[]
      activation: { stdout: string; stderr: string; timedOut: boolean }
      authBefore: string
      authAfter: string
      poolBefore: string
      poolAfter: string
    }
    expect(vault).toBeDefined()
    expect(vault.status).toBe(200)
    expect(JSON.parse(vault.body).info.error).toBeUndefined()
    expect(vault.body).toContain(`GA_OK_${vault.nonce}`)
    expect(vault.authAfter).toBe(vault.authBefore)
    expect(vault.poolAfter).toBe(vault.poolBefore)
    expect(vault.activation.timedOut).toBe(false)
    expect(vault.activation.stdout + vault.activation.stderr).toMatch(/failed/i)
    const sends = vault.calls.filter((call) => call.kind === 'generation')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.headers).toContain(
      'Bearer synthetic-native-v1-vault-access',
    )
    expect(JSON.parse(sends[0]!.body).project).toBe(
      'synthetic-native-v1-project',
    )
    expect(vault.calls.filter((call) => call.kind !== 'generation')).toEqual([])
  })

  test('upgrade genuine packed offline CLI migration and stopped-host restart serve through real refreshed TLS', () => {
    const migration = receipt.migration as { exitCode: number; stdout: string }
    expect(migration.exitCode).toBe(0)
    expect(migration.stdout).toContain('Migration completed')
    const positive = receipt.positive as {
      status: number
      body: string
      nonce: string
      calls: { kind: string; body: string; headers: string[] }[]
    }
    expect(positive.status).toBe(200)
    const response = JSON.parse(positive.body)
    expect(response.info.error).toBeUndefined()
    expect(
      response.parts.some(
        (part: { text?: string }) => part.text === `GA_OK_${positive.nonce}`,
      ),
    ).toBe(true)
    const refresh = positive.calls.filter((call) => call.kind === 'oauth')
    expect(refresh).toHaveLength(1)
    const form = new URLSearchParams(refresh[0]!.body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('synthetic-upgrade-refresh')
    const generations = positive.calls.filter(
      (call) => call.kind === 'generation',
    )
    expect(generations).toHaveLength(1)
    expect(generations[0]!.headers).toContain('Bearer synthetic-renewed-access')
    expect(JSON.parse(generations[0]!.body).project).toBe(
      'synthetic-upgrade-project',
    )
    expect(generations[0]!.body).toContain(positive.nonce)
    const migrated = receipt.migratedRows as {
      status: string
      rows: {
        ref: unknown
        credential: { accessToken?: string; refreshToken: string }
      }[]
    }
    const refreshed = receipt.refreshedRows as typeof migrated
    expect(migrated.status).toBe('ready')
    expect(migrated.rows).toHaveLength(1)
    expect(migrated.rows[0]!.credential.accessToken).toBeUndefined()
    expect(refreshed.rows[0]!.ref).toEqual(migrated.rows[0]!.ref)
    expect(refreshed.rows[0]!.credential.accessToken).toBe(
      'synthetic-renewed-access',
    )
    expect(refreshed.rows[0]!.credential.refreshToken).toBe(
      'synthetic-upgrade-refresh',
    )
  })
})
