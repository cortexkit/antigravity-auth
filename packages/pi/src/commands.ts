/**
 * Pi's `/antigravity` command: the core's shared Antigravity menu in its
 * host-sections mode, drawn with Pi's extension UI by the library's Pi
 * renderer. Pi has one account at a time and no account rows, so it supplies
 * all four account slots itself. The commands library loads on the first
 * invocation, and every invocation builds a fresh menu.
 */

import {
  ANTIGRAVITY_MENU_COMMAND,
  type AntigravityMenuSections,
  type CommonAuthCommandsModule,
  createAntigravityCommandMenu,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'
import type {
  ItemDefinition,
  PluginExtraSection,
} from '@cortexkit/antigravity-auth-core/common-auth/commands'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  opaqueItemId,
  type PiVaultAccountChoice,
  type PiVaultAccountsPort,
  type PiVaultSetup,
  type PiVaultSetupStatus,
  vaultAccountName,
} from './vault-setup.ts'

export interface PiAntigravityCommandOptions {
  sections: AntigravityMenuSections
  extras: readonly PluginExtraSection[]
  /** Loads the commands library; defaults to the core's lazy loader. */
  loadCommands?: () => Promise<CommonAuthCommandsModule>
}

export function registerPiAntigravityCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: PiAntigravityCommandOptions,
): void {
  const loadCommands = options.loadCommands ?? loadCommonAuthCommands
  pi.registerCommand(ANTIGRAVITY_MENU_COMMAND, {
    description:
      'Google Antigravity: the account Pi serves, and the Claustrum vault',
    handler: async (_args, ctx) => {
      const commands = await loadCommands()
      const menu = createAntigravityCommandMenu({
        commands,
        source: 'sections',
        sections: options.sections,
        extras: options.extras,
      })
      await commands.runPiCommandMenu(menu, ctx.ui, {
        sessionId: ctx.sessionManager.getSessionId(),
      })
    },
  })
}

// ---------------------------------------------------------------------------
// Pi's own Accounts, Quota, Routing and Limits sections
// ---------------------------------------------------------------------------

/**
 * The menu's four account slots, built from what Pi actually has: one
 * account at a time (its own login, or one vault account), no pool, no
 * rotation and no recorded quota. Nothing here pretends to be a pool row.
 */
export type PiAntigravityAccountSections = AntigravityMenuSections

export interface PiAntigravityAccountSectionsOptions {
  setup: () => Promise<PiVaultSetup>
  accounts: () => PiVaultAccountsPort
}

/** The vault account Pi sends with now, when custody can name one. */
function servingAccount(
  status: PiVaultSetupStatus,
  accounts: readonly PiVaultAccountChoice[],
): PiVaultAccountChoice | undefined {
  const available = accounts.filter((account) => !account.declined)
  if (status.selectedRouteId !== undefined)
    return available.find(
      (account) => account.routeId === status.selectedRouteId,
    )
  return available.length === 1 ? available[0] : undefined
}

async function custodyAccounts(
  status: PiVaultSetupStatus,
  options: PiAntigravityAccountSectionsOptions,
): Promise<{ list: readonly PiVaultAccountChoice[]; problem?: string }> {
  if (status.mode !== 'custody' || status.enrollment.state !== 'approved')
    return { list: [] }
  try {
    return { list: await options.accounts().list() }
  } catch (error) {
    return {
      list: [],
      problem: `Vault accounts unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function localLoginLine(status: PiVaultSetupStatus): string {
  switch (status.hostSlot) {
    case 'dormant':
      return 'The native Pi login is dormant while vault enrollment controls serving.'
    case 'login':
      return "Signed in with Pi's own login. Pi's /login replaces it and /logout removes it."
    case 'placeholder':
      return 'Pi holds the vault placeholder, not a login. Run /login, or serve from the vault in the Vault section.'
    case 'empty':
      return "Not signed in. Run Pi's /login to sign in."
  }
}

export function createPiAntigravityAccountSections(
  options: PiAntigravityAccountSectionsOptions,
): PiAntigravityAccountSections {
  return {
    accounts: {
      title: 'Accounts',
      build: async () => {
        const status = await (await options.setup()).status()
        if (status.mode === 'unreadable')
          return {
            lines: [
              `The vault mode file is unreadable (${status.modeProblem ?? 'unknown problem'}); Pi serves nothing until a mode is chosen in the Vault section.`,
            ],
          }
        if (status.mode === 'local')
          return {
            lines: [
              "Pi serves Antigravity from its own login, one account, kept in Pi's auth store.",
              localLoginLine(status),
            ],
          }
        const { list, problem } = await custodyAccounts(status, options)
        const serving = servingAccount(status, list)
        const items: ItemDefinition[] = list.map((account) => ({
          id: opaqueItemId(account.routeId),
          label: vaultAccountName(list, account),
          detail: account.declined
            ? 'declined on this host'
            : account === serving
              ? 'serving Pi'
              : 'available',
        }))
        return {
          lines: [
            'Pi serves Antigravity from the vault, one account at a time. Choose, decline or accept accounts in the Vault section.',
            ...(status.hostSlot === 'login'
              ? [
                  'Conflict: Pi also holds its own login. Requests are refused until /logout or a switch back to the local login.',
                ]
              : []),
            ...(problem ? [problem] : []),
          ],
          items,
        }
      },
    },
    quota: {
      title: 'Quota',
      build: () => ({
        lines: [
          "Pi does not record Antigravity quota. A request Google refuses for quota fails with Google's own error.",
        ],
      }),
    },
    routing: {
      title: 'Routing',
      build: async () => {
        const status = await (await options.setup()).status()
        if (status.mode === 'unreadable')
          return {
            lines: [
              'Vault enrollment authority is unreadable; requests are refused. Recover or Disconnect in the Vault section.',
            ],
          }
        if (status.mode !== 'custody')
          return {
            lines: [
              "Every request uses Pi's own login. There is no account rotation.",
            ],
          }
        const { list } = await custodyAccounts(status, options)
        const serving = servingAccount(status, list)
        return {
          lines: [
            serving
              ? `Every request uses ${vaultAccountName(list, serving)}, with a fresh token and project from the vault for each send. There is no account rotation.`
              : 'No single vault account is chosen, so requests are refused. Choose one in the Vault section. There is no account rotation.',
          ],
        }
      },
    },
    limits: {
      title: 'Limits',
      build: () => ({
        lines: [
          'Pi has no per-account limits for Antigravity: with one account there is nothing to fall back to.',
        ],
      }),
    },
  }
}
