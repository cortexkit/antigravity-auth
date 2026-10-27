import {
  type EnrollmentAuthority,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import type { SidebarMachineState } from '../../sidebar-state'

export interface SourceSidebarOptions {
  readonly readAuthority: () => Promise<EnrollmentAuthority>
  readonly local: () => Promise<SidebarMachineState>
  readonly vault: () => Promise<SidebarMachineState>
  readonly write: (
    state: SidebarMachineState,
    accountIds: readonly string[],
  ) => Promise<void>
  readonly now?: () => number
  /**
   * The sidebar's error while no account source may serve; defaults to the
   * vault remedy. An entry point whose vault folder is unsettled passes the
   * refusal's own message instead.
   */
  readonly unavailableMessage?: string
}

/** Choose local or vault sidebar rows before reading accounts; finish queued snapshot writes on shutdown. */
export function createSourceSidebarPublisher(options: SourceSidebarOptions) {
  let tail: Promise<void> = Promise.resolve()
  let disposed = false
  const unavailable = (): SidebarMachineState => ({
    checkedAt: (options.now ?? Date.now)(),
    accounts: [],
    lastError: options.unavailableMessage ?? VAULT_ACCOUNT_REMEDY,
  })
  return {
    publish(): Promise<void> {
      if (disposed) return Promise.resolve()
      const next = tail.then(async () => {
        const authority = await options.readAuthority()
        let projection: SidebarMachineState
        if (authority === 'local') projection = await options.local()
        else if (authority === 'vault') {
          try {
            projection = await options.vault()
          } catch {
            projection = unavailable()
          }
        } else projection = unavailable()
        await options.write(
          projection,
          projection.accounts.map((account) => account.id),
        )
      })
      tail = next.catch(() => {})
      return next
    },
    async dispose(): Promise<void> {
      disposed = true
      await tail
    },
  }
}
