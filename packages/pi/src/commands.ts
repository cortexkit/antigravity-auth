import { AccountIdentityAmbiguityError } from '@cortexkit/antigravity-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import {
  type ExtensionAPI,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import type { PiAccountRuntime } from './runtime.ts'
import { isStrategy, readSettings, writeStrategy } from './settings.ts'

export function registerAccountCommands(
  pi: ExtensionAPI,
  runtime: PiAccountRuntime,
  login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
): void {
  const register = (
    name: string,
    description: string,
    handler: Parameters<ExtensionAPI['registerCommand']>[1]['handler'],
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, context) => {
        try {
          await handler(args, context)
        } catch (error) {
          if (error instanceof AccountIdentityAmbiguityError) {
            context.ui.notify(
              'Antigravity account identity is ambiguous; no accounts were merged. Re-authenticate or repair the token-only entries before retrying.',
              'error',
            )
            return
          }
          context.ui.notify(
            'Antigravity command failed. Check the account/ settings file, account number, or re-authenticate. Existing credentials were retained.',
            'error',
          )
        }
      },
    })
  }
  register(
    'agy-accounts',
    'List Antigravity accounts (no tokens)',
    async (_args, ctx) => {
      ctx.ui.notify(await runtime.describe(), 'info')
    },
  )
  register(
    'agy-quota',
    'Show cached quota; /agy-quota refresh fetches current quota',
    async (args, ctx) => {
      if (args.trim() === 'refresh') {
        const failures = await runtime.refreshQuota(true)
        if (failures)
          ctx.ui.notify(
            `Quota refresh failed for ${failures} account(s); cached values retained.`,
            'warning',
          )
      } else if (args.trim()) throw new Error('Use /agy-quota [refresh]')
      ctx.ui.notify(await runtime.describe(), 'info')
    },
  )
  register(
    'agy-strategy',
    'Show or set sticky, hybrid, round-robin',
    async (args, ctx) => {
      const value = args.trim()
      if (value) {
        if (!isStrategy(value)) {
          ctx.ui.notify(
            'Usage: /agy-strategy [sticky|hybrid|round-robin]',
            'warning',
          )
          return
        }
        await writeStrategy(runtime.settingsPath, value)
      }
      const config = await readSettings(runtime.settingsPath)
      ctx.ui.notify(
        `Strategy: ${config.account_selection_strategy}; PID offset: ${config.pid_offset_enabled}`,
        'info',
      )
    },
  )
  for (const enabled of [true, false]) {
    register(
      enabled ? 'agy-enable' : 'agy-disable',
      'Toggle an account: agy1 or 1',
      async (args, ctx) => {
        const match = args.trim().match(/^(?:agy)?([1-9]\d*)$/)
        if (!match) {
          ctx.ui.notify(
            `Usage: /agy-${enabled ? 'enable' : 'disable'} agy1`,
            'warning',
          )
          return
        }
        await runtime.setEnabled(Number(match[1]) - 1, enabled)
        ctx.ui.notify(await runtime.describe(), 'info')
      },
    )
  }
  register(
    'agy-add',
    'Add an account using the provider OAuth login',
    async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error('OAuth requires interactive Pi')
      if (readStoredCredential('google-antigravity')?.type !== 'oauth') {
        ctx.ui.notify(
          'Authenticate the provider first with /login google-antigravity, then use /agy-add for additional accounts.',
          'warning',
        )
        return
      }
      await login({
        onAuth: ({ url }) =>
          ctx.ui.notify(`Open this URL in your browser:\n${url}`, 'info'),
        onPrompt: async ({ message }) => {
          const value = await ctx.ui.input(message)
          if (!value) throw new Error('Login cancelled')
          return value
        },
        onDeviceCode: () => {
          throw new Error('Unexpected device-code flow')
        },
        onSelect: async ({ message, options }) => {
          const label = await ctx.ui.select(
            message,
            options.map((option) => option.label),
          )
          return options.find((option) => option.label === label)?.id
        },
      })
      ctx.ui.notify(await runtime.describe(), 'info')
    },
  )
}
