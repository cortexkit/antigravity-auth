/**
 * The `/antigravity` menu sections both OpenCode hosts build the same way
 * from a location's own collaborators: the Routing and Limits settings
 * source over the live operator-settings controller, and the Diagnostics
 * section (request dump switch and log level). The module imports no host
 * SDK and no process-wide state; every collaborator is passed in.
 */

import type {
  AntigravityMenuSettingsSource,
  CommonAuthCommandsModule,
} from '@cortexkit/antigravity-auth-core'

import type {
  OperatorSettings,
  OperatorSettingsController,
} from './operator-settings.ts'

type CommonAuthMenuOptions = Parameters<
  CommonAuthCommandsModule['createCommandMenu']
>[0]
type MenuPluginSection = NonNullable<CommonAuthMenuOptions['cache']>

/**
 * The location's operator settings as the shared menu's Routing and Limits
 * sections read and write them. Reads go to the live controller every
 * time; only the two update methods write.
 */
export function operatorMenuSettings(
  settings: Pick<OperatorSettingsController, 'get' | 'update'>,
): AntigravityMenuSettingsSource {
  return {
    read() {
      const current = settings.get()
      return {
        routing: {
          cliFirst: current.routing.cli_first,
          quotaStyleFallback: current.routing.quota_style_fallback,
        },
        killswitch: {
          enabled: current.killswitch.enabled,
          minimumRemainingPercent: current.killswitch.minimum_remaining_percent,
        },
      }
    },
    updateRouting: (next) =>
      settings.update((draft) => {
        draft.routing.cli_first = next.cliFirst
        draft.routing.quota_style_fallback = next.quotaStyleFallback
      }),
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
}): MenuPluginSection {
  return {
    title: 'Diagnostics',
    build() {
      const level = options.settings.get().log_level
      const dumping = options.dump.isEnabled()
      return {
        lines: [
          `Gemini request dump: ${dumping ? 'on' : 'off'}`,
          `Log level: ${level}`,
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
              await options.settings.update((draft) => {
                draft.log_level = next
              })
              options.applyLogLevel(next)
              return `Log level set to ${next}`
            },
          },
        ],
      }
    },
  }
}
