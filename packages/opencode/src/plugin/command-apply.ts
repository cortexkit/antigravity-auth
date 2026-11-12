/**
 * The `/antigravity` menu sections both OpenCode hosts build the same way
 * from a location's own collaborators: the Routing and Limits settings
 * source over the live operator-settings controller, and the Diagnostics
 * section (request dump switch and log level). The module imports no host
 * SDK and no process-wide state; every collaborator is passed in.
 */

import {
  type AccountRepository,
  AccountRepositoryError,
  type AntigravityAccountLimitSource,
  AntigravityMenuRefusal,
  type AntigravityMenuSettingsSource,
  type CommonAuthCommandsModule,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'

import {
  accountKeyForRefreshToken,
  type OperatorSettings,
  type OperatorSettingsController,
} from './operator-settings.ts'

type CommonAuthMenuOptions = Parameters<
  CommonAuthCommandsModule['createCommandMenu']
>[0]
type MenuPluginSection = NonNullable<CommonAuthMenuOptions['cache']>

/**
 * What the menu shows about the settings file: which file the user edits,
 * per-account floor notices for Limits, and status lines for Diagnostics.
 * `ProjectSettings` from `settings/runtime.ts` provides it.
 */
export interface MenuSettingsFile {
  configuredIn(): string
  limitsNotices(): readonly string[]
  diagnosticsNotices(): Promise<readonly string[]>
  readonly moveReport: {
    present(): Promise<boolean>
    dismiss(): Promise<void>
  }
}

/**
 * The location's operator settings as the shared menu's Routing and Limits
 * sections read and write them. Reads go to the live controller every
 * time; only the killswitch update method writes.
 */
export function operatorMenuSettings(
  settings: Pick<OperatorSettingsController, 'get' | 'update'>,
  selectionStrategy: () => 'sticky' | 'round-robin' | 'hybrid' | 'vault',
  file?: Pick<MenuSettingsFile, 'configuredIn' | 'limitsNotices'>,
): AntigravityMenuSettingsSource {
  return {
    read() {
      const current = settings.get()
      const notices = file?.limitsNotices() ?? []
      return {
        selectionStrategy: selectionStrategy(),
        killswitch: {
          enabled: current.killswitch.enabled,
          minimumRemainingPercent: current.killswitch.minimum_remaining_percent,
        },
        ...(file ? { configuredIn: file.configuredIn() } : {}),
        ...(notices.length > 0 ? { notices } : {}),
      }
    },
    updateKillswitch: (next) =>
      settings.update((draft) => {
        draft.killswitch.enabled = next.enabled
        draft.killswitch.minimum_remaining_percent =
          next.minimumRemainingPercent
      }),
  }
}

const LOG_LEVEL_CHOICES = ['error', 'warn', 'info', 'debug', 'trace'] as const

/**
 * The Diagnostics section: the Gemini request dump switch and the log
 * level. `applyLogLevel` applies a changed level to the running logger.
 */
export function diagnosticsMenuSection(options: {
  readonly settings: Pick<OperatorSettingsController, 'get' | 'update'>
  readonly dump: { isEnabled(): boolean; setEnabled(enabled: boolean): void }
  readonly applyLogLevel: (level: OperatorSettings['log_level']) => void
  /** Settings file status; read on every section build. */
  readonly settingsFile?: Pick<
    MenuSettingsFile,
    'diagnosticsNotices' | 'moveReport'
  >
}): MenuPluginSection {
  return {
    title: 'Diagnostics',
    async build() {
      const level = options.settings.get().log_level
      const dumping = options.dump.isEnabled()
      const notices = (await options.settingsFile?.diagnosticsNotices()) ?? []
      const moveReport = options.settingsFile?.moveReport
      const hasReport = (await moveReport?.present()) ?? false
      return {
        lines: [
          `Gemini request dump: ${dumping ? 'on' : 'off'}`,
          `Log level: ${level}`,
          ...notices,
        ],
        actions: [
          {
            id: 'dump',
            label: dumping ? 'Stop dumping requests' : 'Dump requests',
            run: async () => {
              options.dump.setEnabled(!dumping)
              return `Gemini request dump ${dumping ? 'off' : 'on'}`
            },
          },
          {
            id: 'logging',
            label: 'Change log level',
            knobs: [
              {
                kind: 'choice',
                id: 'level',
                label: 'Level',
                choices: LOG_LEVEL_CHOICES.map((value) => ({
                  value,
                  label: value,
                })),
                value: level,
              },
            ],
            run: async ({ values }) => {
              const next = LOG_LEVEL_CHOICES.find(
                (candidate) => candidate === values.level,
              )
              if (next === undefined)
                return {
                  ok: false,
                  text: 'Choose a log level',
                  code: 'invalid-input',
                }
              try {
                await options.settings.update((draft) => {
                  draft.log_level = next
                })
              } catch (error) {
                if (error instanceof AntigravityMenuRefusal)
                  return { ok: false, text: error.text, code: error.code }
                throw error
              }
              options.applyLogLevel(next)
              return `Log level set to ${next}`
            },
          },
          ...(hasReport && moveReport
            ? [
                {
                  id: 'dismiss-settings-move-report',
                  label: 'Dismiss the settings move report',
                  run: async () => {
                    await moveReport.dismiss()
                    return 'Settings move report dismissed'
                  },
                },
              ]
            : []),
        ],
      }
    },
  }
}

/** Repository failures meaning the captured credential is no longer current. */
const STALE_FAILURES = new Set(['attribution', 'unknown-row', 'id-removed'])

/**
 * Per-account quota floors for a location whose accounts are in its local
 * account store, kept where the killswitch already reads them: the operator
 * settings' `killswitch.accounts` map, keyed by `accountKeyForRefreshToken`
 * of the account's stored refresh token. The key is computed here, in
 * process, and never leaves this adapter.
 *
 * A write runs inside the repository's fenced metadata update for the exact
 * captured reference, which holds the row's lock and checks its credential
 * epoch and recorded identity before the callback runs: the key comes from
 * the locked row, and a replaced, re-identified or removed credential is
 * refused (`stale`) before any setting is written. The callback keeps the
 * row's metadata unchanged. A concurrent replacement of the row waits for
 * the row lock, so it lands after the floor was written for the credential
 * the floor belongs to.
 *
 * Limit: the store renews the row lease while the callback runs and asserts
 * it when a lock is taken or a change is committed, but not after a callback
 * that changes nothing. A lease lost during the settings write (its renewal
 * stalled past the lease lifetime) is therefore not detected here, and the
 * write is reported as applied. The floor still sits under the key of the
 * credential it was written for.
 */
export function createStoreAccountLimits(input: {
  readonly repository: Pick<AccountRepository, 'read' | 'updateMetadata'>
  readonly settings: Pick<
    OperatorSettingsController,
    'get' | 'update' | 'floorKeying'
  >
}): AntigravityAccountLimitSource {
  // The shared settings file keys a floor by the row id, which a menu
  // reference already carries; only antigravity.json needs the stored token.
  const stable = () => input.settings.floorKeying?.() === 'stable'
  return {
    async read(ref) {
      if (stable())
        return input.settings.get().killswitch.accounts?.[ref.id] ?? null
      const read = await input.repository.read()
      if (read.status !== 'ready') return null
      const row = read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
      const token = row?.credential?.refreshToken
      if (token === undefined) return null
      return (
        input.settings.get().killswitch.accounts?.[
          accountKeyForRefreshToken(token)
        ] ?? null
      )
    },
    async write(ref, minimumRemainingPercent) {
      try {
        await input.repository.updateMetadata(ref, async (_current, row) => {
          let key: string
          if (stable()) {
            // The metadata update has already refused a replaced, removed
            // or re-identified credential, so this row is the one the menu
            // showed and its id names the account the floor belongs to.
            key = row.ref.id
          } else {
            const token = row.credential?.refreshToken
            // A row without a stored credential has no floor key; nothing is
            // written and the menu reports the action as failed.
            if (token === undefined)
              throw new Error('The account holds no stored credential')
            key = accountKeyForRefreshToken(token)
          }
          await input.settings.update((draft) => {
            const accounts = { ...(draft.killswitch.accounts ?? {}) }
            if (minimumRemainingPercent === null) delete accounts[key]
            else accounts[key] = minimumRemainingPercent
            draft.killswitch.accounts = accounts
          })
          return { kind: 'keep' }
        })
      } catch (error) {
        if (
          error instanceof AccountRepositoryError &&
          STALE_FAILURES.has(error.failure.kind)
        )
          return 'stale'
        throw error
      }
      return 'applied'
    },
  }
}
