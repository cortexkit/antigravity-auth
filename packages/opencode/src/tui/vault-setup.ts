/**
 * The Vault section of the `/antigravity` menu: a credential-free view and
 * action model for setting up the Claustrum vault on OpenCode.
 *
 * The server owns everything with an effect (enrollment, switching the
 * account source, any credential the vault hands out). This module only
 * turns a non-secret status into the section's lines and decides which
 * actions are offered, and each action calls an injected server effect. It
 * imports nothing: no vault client, token, account store or OAuth code, so it
 * can sit next to the TUI without widening what the TUI can reach.
 *
 * The section's shape is the shared command menu's provider extra
 * (`PluginExtraSection` of `@cortexkit/common-auth/commands`), declared
 * structurally here so the server can pass it straight to
 * `createCommandMenu({ extras: [...] })`.
 */

/** The enrollment name this host registers with the vault. */
export const OPENCODE_VAULT_ENROLLMENT_NAME =
  'antigravity-auth-opencode' as const

/** Where requests take their Antigravity accounts from. */
export type VaultSourceMode = 'local' | 'custody'

/**
 * - `not-enrolled`: this host has never been enrolled.
 * - `pending`: an enrollment was started and waits for approval in the vault.
 * - `enrolled`: the vault knows this host.
 * - `revoked`: the vault withdrew this host's enrollment.
 * - `declined`: the vault refused the enrollment request.
 * - `unavailable`: the vault could not be reached when status was read.
 */
export type VaultEnrollmentState =
  | 'not-enrolled'
  | 'pending'
  | 'enrolled'
  | 'revoked'
  | 'declined'
  | 'unavailable'

/** Why vault custody cannot be used even though enrollment may exist. */
export type VaultIneligibleReason =
  | 'no-vault-configured'
  | 'host-login-present'
  | 'unsupported-host'

/** The non-secret facts the server reports about vault setup. */
export interface VaultSetupStatus {
  readonly mode: VaultSourceMode
  readonly enrollment: VaultEnrollmentState
  /** Present when custody cannot be selected; the reason is shown as-is. */
  readonly ineligible?: VaultIneligibleReason
  /** Accounts the vault currently serves to this host, when enrolled. */
  readonly accounts?: number
  /** When the status was read (ms since epoch). */
  readonly checkedAt: number
}

/** What a vault action reports; `text` is shown to the user. */
export interface VaultActionOutcome {
  readonly ok: boolean
  readonly text: string
  readonly code?: string
}

/**
 * The server effects behind the section's actions. Every one is owned by
 * the server; this model never performs an effect itself.
 */
export interface VaultSetupEffects {
  /** Reads the current, non-secret status. Called for every menu build. */
  status(): Promise<VaultSetupStatus>
  /** Starts enrollment under {@link OPENCODE_VAULT_ENROLLMENT_NAME}. */
  enroll(): Promise<VaultActionOutcome>
  /** Routes requests through vault custody. */
  useCustody(): Promise<VaultActionOutcome>
  /** Routes requests through the local accounts again. */
  useLocal(): Promise<VaultActionOutcome>
  /** Withdraws this host's enrollment. */
  disconnect(): Promise<VaultActionOutcome>
}

// Structural copies of the shared command menu's section types, limited to
// what this section uses.
export interface VaultSectionAction {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly irreversible?: boolean
  readonly confirm?: string
  run(input: unknown): Promise<VaultActionOutcome>
}

export interface VaultSectionContent {
  readonly lines: string[]
  readonly actions: VaultSectionAction[]
  readonly facts: Record<string, string | number>
}

export interface VaultExtraSection {
  readonly id: 'vault'
  readonly title: string
  build(invocation: unknown): Promise<VaultSectionContent>
}

const ENROLLMENT_TEXT: Record<VaultEnrollmentState, string> = {
  'not-enrolled': 'Not enrolled',
  pending: 'Enrollment waiting for approval in the vault',
  enrolled: 'Enrolled',
  revoked: 'Enrollment revoked by the vault',
  declined: 'Enrollment declined by the vault',
  unavailable: 'Vault unreachable; status unknown',
}

const INELIGIBLE_TEXT: Record<VaultIneligibleReason, string> = {
  'no-vault-configured': 'No vault is configured for this machine.',
  'host-login-present':
    'An OpenCode login for this provider is present; remove it before using vault custody.',
  'unsupported-host': 'This OpenCode version cannot use vault custody.',
}

const MODES: readonly VaultSourceMode[] = ['local', 'custody']
const STATES = Object.keys(ENROLLMENT_TEXT) as VaultEnrollmentState[]
const REASONS = Object.keys(INELIGIBLE_TEXT) as VaultIneligibleReason[]
const STATUS_KEYS = [
  'mode',
  'enrollment',
  'ineligible',
  'accounts',
  'checkedAt',
]

/**
 * Checks a status from the server field by field. A status with any other
 * field (a token, an email, a receipt) is refused rather than shown, so a
 * server change that starts passing secrets cannot reach the menu.
 */
export function parseVaultSetupStatus(
  value: unknown,
): VaultSetupStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !STATUS_KEYS.includes(key))) {
    return undefined
  }
  if (!MODES.includes(record.mode as VaultSourceMode)) return undefined
  if (!STATES.includes(record.enrollment as VaultEnrollmentState)) {
    return undefined
  }
  if (
    record.ineligible !== undefined &&
    !REASONS.includes(record.ineligible as VaultIneligibleReason)
  ) {
    return undefined
  }
  if (
    record.accounts !== undefined &&
    !(Number.isSafeInteger(record.accounts) && (record.accounts as number) >= 0)
  ) {
    return undefined
  }
  if (!Number.isFinite(record.checkedAt)) return undefined
  return {
    mode: record.mode as VaultSourceMode,
    enrollment: record.enrollment as VaultEnrollmentState,
    ...(record.ineligible === undefined
      ? {}
      : { ineligible: record.ineligible as VaultIneligibleReason }),
    ...(record.accounts === undefined
      ? {}
      : { accounts: record.accounts as number }),
    checkedAt: record.checkedAt as number,
  }
}

export interface VaultSetupView {
  readonly lines: string[]
  /** Ids of the actions offered for this status, in display order. */
  readonly actions: Array<'enroll' | 'use-custody' | 'use-local' | 'disconnect'>
}

/** The lines and the offered actions for one status. */
export function vaultSetupView(
  status: VaultSetupStatus | undefined,
): VaultSetupView {
  if (!status) {
    return {
      lines: ['Vault status could not be read; no vault action is offered.'],
      actions: [],
    }
  }
  const lines = [
    `Accounts come from: ${status.mode === 'custody' ? 'vault custody' : 'local accounts'}`,
    `Host enrollment (${OPENCODE_VAULT_ENROLLMENT_NAME}): ${ENROLLMENT_TEXT[status.enrollment]}`,
  ]
  if (status.enrollment === 'enrolled' && status.accounts !== undefined) {
    lines.push(`Vault accounts for this host: ${status.accounts}`)
  }
  if (status.ineligible) lines.push(INELIGIBLE_TEXT[status.ineligible])

  const actions: VaultSetupView['actions'] = []
  if (status.enrollment === 'unavailable') {
    // Nothing can be decided while the vault cannot be reached; only the
    // way back to local accounts stays open.
    if (status.mode === 'custody') actions.push('use-local')
    return { lines, actions }
  }
  if (
    !status.ineligible &&
    (status.enrollment === 'not-enrolled' ||
      status.enrollment === 'revoked' ||
      status.enrollment === 'declined')
  ) {
    actions.push('enroll')
  }
  if (
    status.enrollment === 'enrolled' &&
    status.mode === 'local' &&
    !status.ineligible
  ) {
    actions.push('use-custody')
  }
  if (status.mode === 'custody') actions.push('use-local')
  if (status.enrollment === 'enrolled' || status.enrollment === 'pending') {
    actions.push('disconnect')
  }
  return { lines, actions }
}

const UNREADABLE: VaultActionOutcome = {
  ok: false,
  text: 'The vault action did not complete.',
  code: 'vault-failed',
}

async function guarded(
  run: () => Promise<VaultActionOutcome>,
): Promise<VaultActionOutcome> {
  try {
    const outcome = await run()
    return typeof outcome?.text === 'string' && typeof outcome.ok === 'boolean'
      ? {
          ok: outcome.ok,
          text: outcome.text,
          ...(outcome.code ? { code: outcome.code } : {}),
        }
      : UNREADABLE
  } catch {
    // The effect's own error text may quote a request or a credential, so it
    // is never shown; the server logs it on its side.
    return UNREADABLE
  }
}

/** The Vault provider extra for the server's `/antigravity` menu. */
export function createVaultSection(
  effects: VaultSetupEffects,
): VaultExtraSection {
  return {
    id: 'vault',
    title: 'Vault',
    async build() {
      let status: VaultSetupStatus | undefined
      try {
        status = parseVaultSetupStatus(await effects.status())
      } catch {
        status = undefined
      }
      const view = vaultSetupView(status)
      const definitions: Record<
        VaultSetupView['actions'][number],
        VaultSectionAction
      > = {
        enroll: {
          id: 'enroll',
          label: 'Set up vault for this host',
          description: `Request enrollment as ${OPENCODE_VAULT_ENROLLMENT_NAME}; approve it in the vault.`,
          run: () => guarded(() => effects.enroll()),
        },
        'use-custody': {
          id: 'use-custody',
          label: 'Use vault accounts',
          description:
            'Send requests with accounts the vault serves to this host.',
          confirm:
            'Switch this host to vault custody? Local accounts stay on disk but are not used.',
          run: () => guarded(() => effects.useCustody()),
        },
        'use-local': {
          id: 'use-local',
          label: 'Use local accounts',
          description:
            'Send requests with the accounts stored on this machine.',
          run: () => guarded(() => effects.useLocal()),
        },
        disconnect: {
          id: 'disconnect',
          label: 'Disconnect vault',
          description: 'Withdraw this host from the vault.',
          irreversible: true,
          confirm:
            'Withdraw this host from the vault? Setting it up again needs a new approval.',
          run: () => guarded(() => effects.disconnect()),
        },
      }
      return {
        lines: view.lines,
        actions: view.actions.map((action) => definitions[action]),
        facts: {},
      }
    },
  }
}
