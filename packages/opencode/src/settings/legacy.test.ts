import { describe, expect, it } from 'bun:test'

import { accountKeyForRefreshToken } from '../plugin/killswitch'
import {
  floorKeyTableFromRows,
  hasTokenKeyedFloors,
  mapLegacySettings,
  readLegacyProjectSettings,
  readLegacySettingsFile,
} from './legacy'

const read = (value: unknown) => readLegacySettingsFile(JSON.stringify(value))
const noRows = new Map<string, readonly string[]>()

describe('legacy antigravity.json mapping', () => {
  it('maps each written key to the value the old loader used, and keeps absence', () => {
    const mapped = mapLegacySettings(
      read({
        $schema: 'https://example.invalid/schema.json',
        quiet_mode: true,
        account_selection_strategy: 'sticky',
        max_account_switches: 3,
      }),
      noRows,
    )
    expect(mapped.values).toEqual({
      quiet_mode: true,
      account_selection_strategy: 'sticky',
      max_account_switches: 3,
    })
    expect(mapped.unmapped).toEqual([])
  })

  it('fills a partial object from its declared fields, as the old loader did', () => {
    const mapped = mapLegacySettings(
      read({ signature_cache: { enabled: false } }),
      noRows,
    )
    expect(mapped.values).toEqual({
      signature_cache: {
        enabled: false,
        memory_ttl_seconds: 3600,
        disk_ttl_seconds: 172800,
        write_interval_seconds: 60,
      },
    })
  })

  it('ignores a top level the old loader rejected while the operator block still applies', () => {
    const mapped = mapLegacySettings(
      read({
        quiet_mode: true,
        max_account_switches: 9999,
        operator: { log_level: 'debug', killswitch: { enabled: true } },
      }),
      noRows,
    )
    expect(mapped.values).toEqual({
      log_level: 'debug',
      killswitch: { enabled: true },
    })
    expect(mapped.unmapped).toEqual([
      { key: 'quiet_mode', reason: 'ignored-by-runtime' },
      { key: 'max_account_switches', reason: 'ignored-by-runtime' },
    ])
  })

  it('reports unknown and retired keys by name and never maps them', () => {
    const mapped = mapLegacySettings(
      read({
        made_up: 1,
        tool_id_recovery: false,
        max_backoff_seconds: 30,
        debug: true,
      }),
      noRows,
    )
    expect(mapped.values).toEqual({ debug: true })
    expect(mapped.unmapped).toEqual([
      { key: 'made_up', reason: 'unknown-key' },
      { key: 'tool_id_recovery', reason: 'retired' },
      { key: 'max_backoff_seconds', reason: 'retired' },
    ])
  })

  it('splits the soft quota cache lifetime into its two settings', () => {
    expect(
      mapLegacySettings(read({ soft_quota_cache_ttl_minutes: 'auto' }), noRows)
        .values,
    ).toEqual({ soft_quota_cache_ttl: 'auto' })
    expect(
      mapLegacySettings(read({ soft_quota_cache_ttl_minutes: 15 }), noRows)
        .values,
    ).toEqual({
      soft_quota_cache_ttl: 'minutes',
      soft_quota_cache_ttl_minutes: 15,
    })
  })

  it('reports an unparseable file without throwing', () => {
    expect(readLegacySettingsFile('{ not json')).toEqual({
      kind: 'unparseable',
    })
    expect(
      mapLegacySettings(readLegacySettingsFile('[1]'), noRows).unmapped,
    ).toEqual([{ key: '', reason: 'unparseable' }])
  })
})

describe('per-account floor re-keying', () => {
  const rows = [
    { ref: { id: 'row-a' }, credential: { refreshToken: 'token-a' } },
    { ref: { id: 'row-b' }, credential: { refreshToken: 'token-b' } },
    { ref: { id: 'row-b2' }, credential: { refreshToken: 'token-b' } },
    { ref: { id: 'row-c' } },
  ]
  const table = floorKeyTableFromRows(rows)
  const keyA = accountKeyForRefreshToken('token-a')
  const keyB = accountKeyForRefreshToken('token-b')
  const keyGone = accountKeyForRefreshToken('token-removed')

  it('moves a floor from the token hash to the row id', () => {
    const file = read({
      operator: { killswitch: { accounts: { [keyA]: 40 } } },
    })
    expect(hasTokenKeyedFloors(file)).toBe(true)
    const mapped = mapLegacySettings(file, table)
    expect(mapped.values).toEqual({ killswitch: { accounts: { 'row-a': 40 } } })
    expect(mapped.unmapped).toEqual([])
  })

  it('reports a missing row, an ambiguous hash and a position key, never mapping them', () => {
    const mapped = mapLegacySettings(
      read({
        operator: {
          killswitch: {
            minimum_remaining_percent: 10,
            accounts: { [keyGone]: 20, [keyB]: 30, 'idx-2': 50, [keyA]: 60 },
          },
        },
      }),
      table,
    )
    expect(mapped.values).toEqual({
      killswitch: { minimum_remaining_percent: 10, accounts: { 'row-a': 60 } },
    })
    expect(mapped.unmapped).toEqual([
      { key: 'killswitch.accounts.entry-1', reason: 'account-not-found' },
      { key: 'killswitch.accounts.entry-2', reason: 'account-ambiguous' },
      { key: 'killswitch.accounts.idx-2', reason: 'position-key' },
    ])
    // The report never carries the token-derived key.
    expect(JSON.stringify(mapped.unmapped)).not.toContain(keyGone)
    expect(JSON.stringify(mapped.unmapped)).not.toContain(keyB)
  })

  it('needs no account rows when only position keys are present', () => {
    expect(
      hasTokenKeyedFloors(
        read({ operator: { killswitch: { accounts: { 'idx-0': 5 } } } }),
      ),
    ).toBe(false)
  })
})

describe('old project files', () => {
  it('returns every value under its new name, with retired keys named', () => {
    expect(
      readLegacyProjectSettings(
        JSON.stringify({
          quiet_mode: true,
          background_quota_refresh: false,
          tool_id_recovery: true,
          operator: { killswitch: { accounts: { 'idx-0': 5 } } },
        }),
      ),
    ).toEqual({
      quiet_mode: true,
      background_quota_refresh: false,
      tool_id_recovery: true,
      killswitch: { accounts: { 'idx-0': 5 } },
    })
  })
})
