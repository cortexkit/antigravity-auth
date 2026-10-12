import { describe, expect, it } from 'bun:test'
import {
  type EnrollmentAuthority,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import type { SidebarMachineState } from '../../sidebar-state'
import { createSourceSidebarPublisher } from './source-sidebar'

describe('source-aware sidebar publisher', () => {
  it('checks authority before invoking a local account reader', async () => {
    let authority: EnrollmentAuthority = 'vault'
    let localReads = 0
    let vaultReads = 0
    const writes: SidebarMachineState[] = []
    const publisher = createSourceSidebarPublisher({
      readAuthority: async () => authority,
      local: async () => {
        localReads += 1
        return { checkedAt: 1, accounts: [] }
      },
      vault: async () => {
        vaultReads += 1
        return { checkedAt: 2, accounts: [] }
      },
      write: async (state) => {
        writes.push(state)
      },
      now: () => 3,
    })
    await publisher.publish()
    expect(localReads).toBe(0)
    expect(vaultReads).toBe(1)
    authority = 'unreadable'
    await publisher.publish()
    expect(localReads).toBe(0)
    expect(vaultReads).toBe(1)
    expect(writes[1]).toEqual({
      checkedAt: 3,
      accounts: [],
      lastError: VAULT_ACCOUNT_REMEDY,
    })
    authority = 'local'
    await publisher.publish()
    expect(localReads).toBe(1)
    await publisher.dispose()
  })

  it('writes an empty remedy projection on vault failure and joins pending publications before stopping', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const publisher = createSourceSidebarPublisher({
      readAuthority: async () => 'vault',
      local: async () => {
        throw new Error('local fallback is forbidden')
      },
      vault: async () => {
        await gate
        throw new Error('synthetic vault unavailable')
      },
      write: async (state, ids) => {
        expect(state).toEqual({
          checkedAt: 7,
          accounts: [],
          lastError: VAULT_ACCOUNT_REMEDY,
        })
        expect(ids).toEqual([])
        writes += 1
      },
      now: () => 7,
    })
    const publishing = publisher.publish()
    let stopped = false
    const stopping = publisher.dispose().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await publishing
    await stopping
    expect(stopped).toBe(true)
    expect(writes).toBe(1)
    await publisher.publish()
    expect(writes).toBe(1)
  })
})
