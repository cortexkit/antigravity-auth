/**
 * Setup for serving Pi's Antigravity provider from the Claustrum vault
 * ("custody") instead of Pi's own login ("local"). The two never serve
 * together. Enrollment as `antigravity-auth-pi` runs only from the Vault
 * menu section, never from a model request; the enrollment token stays in
 * the vault library's owner-only file and Pi's auth slot is only read.
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { CommonAuthClaustrumModule } from '@cortexkit/antigravity-auth-core'
import {
  ANTIGRAVITY_PROVIDER_ID,
  type EmptyVaultRosterCause,
  emptyVaultRosterCause,
  enrollmentAuthority,
  sharedVaultTokenFolder,
  sharedVaultTokenFolderOutcome,
  sharedVaultTokenFolderText,
  UNSUPPORTED_VAULT_CODE,
  VAULT_RECLASSIFY_COMMAND,
  VAULT_STATUS_COMMAND,
  type VaultGrantReach,
} from '@cortexkit/antigravity-auth-core'
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core/atomic-write'
import type {
  ClaustrumEnrollmentConnection,
  ClaustrumEnrollmentPaths,
  ClaustrumEnrollmentStatus,
  HostSlotContent,
} from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import type {
  ActionDefinition,
  ActionOutcome,
  ItemDefinition,
  PluginExtraSection,
} from '@cortexkit/antigravity-auth-core/common-auth/commands'

/** Pi's provider id; also the key of its auth slot in Pi's auth.json. */
export const PI_ANTIGRAVITY_PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID
/** The host name this extension enrolls under, one enrollment per host. */
export const PI_ANTIGRAVITY_VAULT_HOST = 'pi'
/** The enrollment name the operator sees and approves for Pi. */
export const PI_ANTIGRAVITY_ENROLLMENT_NAME = 'antigravity-auth-pi'

// ---------------------------------------------------------------------------
// Mode file
// ---------------------------------------------------------------------------

export type PiAntigravityMode = 'local' | 'custody'

/**
 * What Pi serves Antigravity from. `routeId` names the vault account the
 * user picked; it is a roster route id, never credential material.
 */
export interface PiVaultModeRecord {
  readonly version: 1
  readonly mode: PiAntigravityMode
  readonly routeId?: string
}

export type PiVaultModeRead =
  | { readonly ok: true; readonly record: PiVaultModeRecord }
  | { readonly ok: false; readonly reason: string }

const LOCAL_MODE: PiVaultModeRecord = Object.freeze({
  version: 1,
  mode: 'local',
})

function parseModeRecord(raw: unknown): PiVaultModeRecord | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record))
    if (key !== 'version' && key !== 'mode' && key !== 'routeId')
      return undefined
  if (record.version !== 1) return undefined
  if (record.mode !== 'local' && record.mode !== 'custody') return undefined
  if (record.routeId === undefined)
    return Object.freeze({ version: 1, mode: record.mode })
  if (typeof record.routeId !== 'string' || record.routeId.trim() === '')
    return undefined
  return Object.freeze({
    version: 1,
    mode: record.mode,
    routeId: record.routeId,
  })
}

/**
 * Read the mode file. A missing file is local mode, so an extension that
 * was never set up keeps serving its single login. A file that exists but
 * cannot be understood is reported, not guessed: the caller refuses to serve
 * rather than pick a mode the user may not have chosen.
 */
export function readPiVaultMode(path: string): PiVaultModeRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
      return { ok: true, record: LOCAL_MODE }
    return { ok: false, reason: 'its vault settings file could not be read' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'its vault settings file is damaged' }
  }
  const record = parseModeRecord(raw)
  return record
    ? { ok: true, record }
    : {
        ok: false,
        reason: 'its vault settings file holds settings it does not understand',
      }
}

export async function writePiVaultMode(
  path: string,
  record: PiVaultModeRecord,
): Promise<void> {
  const value: PiVaultModeRecord =
    record.routeId === undefined
      ? { version: 1, mode: record.mode }
      : { version: 1, mode: record.mode, routeId: record.routeId }
  await writeJsonAtomic(path, value)
}

// ---------------------------------------------------------------------------
// Vault accounts as setup sees them
// ---------------------------------------------------------------------------

/** An account shown in the vault menu; declined accounts are excluded from request selection. */
export interface PiVaultAccountChoice {
  readonly routeId: string
  /** Display label from the vault roster; may hold the account's email. */
  readonly label: string
  readonly email?: string
  readonly declined: boolean
}

/**
 * Vault account discovery and selection used by the setup menu.
 * These operations become available after the operator approves access.
 */
export interface PiVaultAccountsPort {
  /** Reload and save the list of permitted vault accounts, then return it to the menu. */
  list(): Promise<readonly PiVaultAccountChoice[]>
  /**
   * Pi's grants as the vault reported them when `list` last loaded the
   * accounts. They explain why that list is empty. Undefined means unknown,
   * never zero grants.
   */
  grantReach(): VaultGrantReach | undefined
  decline(routeId: string): Promise<void>
  accept(routeId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Setup controller
// ---------------------------------------------------------------------------

export interface PiVaultSetupStatus {
  readonly mode: PiAntigravityMode | 'unreadable'
  readonly modeProblem?: string
  readonly selectedRouteId?: string
  readonly enrollment: ClaustrumEnrollmentStatus
  readonly hostSlot: HostSlotContent | 'dormant'
}

export interface PiVaultSetupOptions {
  claustrum: CommonAuthClaustrumModule
  /** Pi's vault directory (see `getPiAntigravityVaultDir`). */
  stateDir: string
  /** Pi's vault mode file (see `getPiAntigravityVaultModeFile`). */
  modeFile: string
  /** Read Pi's own Google credential record, only when local accounts are selected. */
  readHostSlot: () => unknown
  /** Opens the setup-only enrollment connection to the vault. */
  connectEnrollment: () => Promise<ClaustrumEnrollmentConnection>
  /** Re-register the Google provider after its selected account source changes. */
  onModeChanged?: (record: PiVaultModeRecord) => void | Promise<void>
  now?: () => number
}

/** A setup action refused before anything changed, with a message for the user. */
export class PiVaultSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiVaultSetupError'
  }
}

export class PiVaultSetup {
  readonly #options: PiVaultSetupOptions
  readonly paths: ClaustrumEnrollmentPaths

  constructor(options: PiVaultSetupOptions) {
    this.#options = options
    this.paths = options.claustrum.hostEnrollmentPaths({
      stateDir: options.stateDir,
      host: PI_ANTIGRAVITY_VAULT_HOST,
    })
  }

  #hostSlot(): HostSlotContent {
    return this.#options.claustrum.classifyHostSlot(
      this.#options.readHostSlot(),
      PI_ANTIGRAVITY_PROVIDER_ID,
    )
  }

  /** Read vault approval and local/vault settings without opening Pi's Google credentials. */
  async sourceStatus(): Promise<Omit<PiVaultSetupStatus, 'hostSlot'>> {
    const mode = readPiVaultMode(this.#options.modeFile)
    const enrollment = await this.#options.claustrum
      .readClaustrumEnrollmentStatus(this.paths, PI_ANTIGRAVITY_ENROLLMENT_NAME)
      .catch(
        (): ClaustrumEnrollmentStatus => ({
          state: 'blocked',
          proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
          code: 'unreadable-state',
        }),
      )
    const authority = await enrollmentAuthority(
      this.paths,
      PI_ANTIGRAVITY_ENROLLMENT_NAME,
      this.#options.claustrum,
    )
    return {
      ...(authority !== 'local'
        ? {
            mode:
              authority === 'vault'
                ? ('custody' as const)
                : ('unreadable' as const),
            ...(mode.ok &&
              mode.record.routeId !== undefined && {
                selectedRouteId: mode.record.routeId,
              }),
          }
        : mode.ok
          ? {
              mode: mode.record.mode,
              ...(mode.record.routeId !== undefined && {
                selectedRouteId: mode.record.routeId,
              }),
            }
          : { mode: 'unreadable' as const, modeProblem: mode.reason }),
      enrollment,
    }
  }

  /** Inspect the native login only when local accounts are selected. */
  async status(): Promise<PiVaultSetupStatus> {
    const source = await this.sourceStatus()
    return {
      ...source,
      hostSlot: source.mode === 'local' ? this.#hostSlot() : 'dormant',
    }
  }

  /**
   * Propose Pi to the vault or poll its recorded proposal. Clear a denied or
   * blocked request before starting again. Only setup actions call this method.
   */
  async connectStep(): Promise<ClaustrumEnrollmentStatus> {
    const client = await this.#options.connectEnrollment()
    try {
      const manager = new this.#options.claustrum.ClaustrumEnrollmentManager({
        client,
        paths: this.paths,
        proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
        ...(this.#options.now && { now: this.#options.now }),
      })
      const current = await manager.status()
      if (current.state === 'denied' || current.state === 'blocked')
        await manager.resetTerminal()
      const reconciled = await manager.reconcile()
      if (reconciled.state === 'approved') {
        const saved = readPiVaultMode(this.#options.modeFile)
        await this.useVault(
          saved.ok && saved.record.mode === 'custody'
            ? saved.record.routeId
            : undefined,
        )
      }
      return reconciled
    } finally {
      client.close()
    }
  }

  /**
   * Select the vault account used for requests after the operator approves
   * enrollment. Await the host's Google credential-slot transition before
   * returning, so provider registration cannot race it.
   */
  async useVault(routeId?: string): Promise<PiVaultModeRecord> {
    const enrollment =
      await this.#options.claustrum.readClaustrumEnrollmentStatus(
        this.paths,
        PI_ANTIGRAVITY_ENROLLMENT_NAME,
      )
    if (enrollment.state !== 'approved')
      throw new PiVaultSetupError(
        "Pi doesn't have vault access yet. Choose Request vault access and wait for the vault operator to approve it.",
      )
    if (routeId !== undefined && routeId.trim() === '')
      throw new PiVaultSetupError('Choose a vault account to use.')
    const record: PiVaultModeRecord =
      routeId === undefined
        ? { version: 1, mode: 'custody' }
        : { version: 1, mode: 'custody', routeId }
    await writePiVaultMode(this.#options.modeFile, record)
    await this.#options.onModeChanged?.(record)
    return record
  }

  /** Use Pi's local login only after vault enrollment has been disconnected. */
  async useLocal(): Promise<PiVaultModeRecord> {
    if (
      (await enrollmentAuthority(
        this.paths,
        PI_ANTIGRAVITY_ENROLLMENT_NAME,
        this.#options.claustrum,
      )) !== 'local'
    ) {
      throw new PiVaultSetupError(
        "Disconnect from the vault before switching to Pi's own login.",
      )
    }
    await writePiVaultMode(this.#options.modeFile, LOCAL_MODE)
    await this.#options.onModeChanged?.(LOCAL_MODE)
    return LOCAL_MODE
  }

  /**
   * Forget this host's enrollment (token and ceremony state) and go back to
   * local mode. The vault keeps the enrollment approved until the operator
   * revokes it there.
   */
  async disconnect(): Promise<void> {
    const result = await this.#options.claustrum.disconnectClaustrumEnrollment(
      this.paths,
      PI_ANTIGRAVITY_ENROLLMENT_NAME,
    )
    if (result === 'busy')
      throw new PiVaultSetupError(
        'Another vault setup step is running, so Pi is still connected to the vault. Try again in a moment.',
      )
    await writePiVaultMode(this.#options.modeFile, LOCAL_MODE)
    await this.#options.onModeChanged?.(LOCAL_MODE)
  }
}

// ---------------------------------------------------------------------------
// Rendering through Pi's command and dialog surfaces
// ---------------------------------------------------------------------------

/**
 * One line on where Pi's request for vault access stands. A vault code
 * follows the explanation as a reference the user can quote to the vault
 * operator; it never replaces the explanation.
 */
function describeEnrollment(status: ClaustrumEnrollmentStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Vault access: not requested yet.'
    case 'pending':
      return status.retryCode
        ? `Vault access: the vault can't take Pi's request right now; Pi asks again the next time it checks (reference: ${status.retryCode}).`
        : 'Vault access: waiting for the vault operator to approve this request.'
    case 'approved':
      return 'Vault access: approved by the vault operator.'
    case 'denied':
      return 'Vault access: the vault operator denied the request. Choose Request vault access to ask again.'
    case 'blocked':
      if (status.code === 'pending_exists')
        return 'Vault access: the vault turned down a new request because an earlier request from Pi is still waiting.'
      if (status.code === 'missing_token')
        return "Vault access: approved, but Pi's vault key is missing from this computer. Disconnect from the vault, then request vault access again."
      if (status.code === 'unreadable-state')
        return "Vault access: Pi can't read its record of the vault request. Disconnect from the vault, then request vault access again."
      return `Vault access: the vault ended this request (reference: ${status.code}). Choose Request vault access to start a new one.`
    case 'unavailable':
      if (status.code === UNSUPPORTED_VAULT_CODE)
        return 'Vault access: this Claustrum vault is too old to connect plugins. Ask the vault operator to update Claustrum, or keep using your local accounts.'
      return `Vault access: Pi can't reach the vault right now. Try again later (reference: ${status.code}).`
    case 'busy':
      return 'Vault access: another vault setup step is running. Try again in a moment.'
  }
}

// The vault operator approves and grants with Claustrum's `ck` command,
// outside Pi. Approval alone serves nothing: the enrollment also needs read
// access to the vault's Antigravity accounts.

/** The operator's command that grants Pi's enrollment read access to Antigravity accounts. */
export const PI_VAULT_GRANT_COMMAND = `ck auth grant --principal enrolled:${PI_ANTIGRAVITY_ENROLLMENT_NAME} --selector-kind category --selector antigravity-native --operation read`

/** What to do while Pi's request waits in the vault; names the request when Pi knows its ID. */
function piPendingEnrollmentGuidance(requestId?: string): string[] {
  return [
    'Next, the vault operator runs these outside Pi:',
    requestId === undefined
      ? `1. Find the request from ${PI_ANTIGRAVITY_ENROLLMENT_NAME} with ck auth enroll list, then approve it: ck auth enroll approve --request-id <id>`
      : `1. Approve the request: ck auth enroll approve --request-id ${requestId}`,
    `2. Grant read access: ${PI_VAULT_GRANT_COMMAND}`,
    'Both are needed: without the grant, Pi can see no accounts in the vault.',
    '3. Pi switches to the vault once it sees the approval. Choose Request vault access to check again.',
  ]
}

/**
 * Why a new request was refused with `pending_exists`, and the way out. The
 * vault holds one pending request per name; an earlier one, for example from
 * an enrollment forgotten in Pi, blocks a new one until it expires or the
 * operator denies it.
 */
function piPendingExistsGuidance(): string[] {
  return [
    'The earlier request may come from a vault setup that was disconnected here before the operator answered it.',
    'It expires 15 minutes after it was made; request vault access again after that.',
    `Or the vault operator clears it now: find the request from ${PI_ANTIGRAVITY_ENROLLMENT_NAME} with ck auth enroll list, run ck auth enroll deny --request-id <id>, then request vault access again here.`,
  ]
}

/**
 * Shown when Pi is approved but the vault lists no Antigravity accounts for
 * it. When the vault reported Pi's grants, they tell the two causes apart: no
 * grant at all, or a grant that matches no login. When the grants are
 * unknown, the general message names the grant command.
 */
export function piNoVaultAccountsGuidance(
  reach: VaultGrantReach | undefined,
): string[] {
  return piEmptyRosterGuidance(emptyVaultRosterCause(reach))
}

/** The Vault menu's lines for each reason the vault serves Pi no account. */
function piEmptyRosterGuidance(cause: EmptyVaultRosterCause): string[] {
  switch (cause) {
    case 'no-grant':
      return [
        'The vault operator approved Pi. The vault has not granted Pi read access.',
        `The vault operator grants it with: ${PI_VAULT_GRANT_COMMAND}`,
      ]
    case 'grant-reaches-nothing':
      return [
        'The vault operator approved Pi. Pi has read access, but it reaches no Antigravity login in the vault.',
        `The vault operator updates the vault's logins with: ${VAULT_RECLASSIFY_COMMAND}`,
        `Then they check them with: ${VAULT_STATUS_COMMAND}`,
      ]
    case 'unknown':
      return [
        "The vault operator approved Pi, but Pi can't see any Antigravity accounts in the vault yet.",
        `If the operator has not granted Pi read access yet, they run: ${PI_VAULT_GRANT_COMMAND}`,
      ]
  }
}

/**
 * The send error when the vault serves Pi no account: the menu's lines for
 * the same cause, one per line. An unknown cause returns undefined, so the
 * send keeps its general error.
 */
export function piEmptyVaultRosterRefusal(
  cause: EmptyVaultRosterCause,
): string | undefined {
  return cause === 'unknown'
    ? undefined
    : piEmptyRosterGuidance(cause).join('\n')
}

/** The next steps for an enrollment state that needs the user or the operator to act. */
function enrollmentGuidance(status: ClaustrumEnrollmentStatus): string[] {
  if (status.state === 'pending')
    return piPendingEnrollmentGuidance(status.requestId)
  if (status.state === 'blocked' && status.code === 'pending_exists')
    return piPendingExistsGuidance()
  return []
}

/**
 * Where Pi gets its Antigravity accounts, in one line that also says whether
 * Pi's own login is signed in. A `placeholder` in Pi's credential store is the
 * stand-in entry Pi keeps while the vault serves it; it is not a login, so it
 * reads the same as no login at all.
 */
function describeSource(status: PiVaultSetupStatus): string {
  switch (status.mode) {
    case 'custody':
      return "Using the vault for Antigravity accounts; Pi's own login is set aside."
    case 'local':
      return status.hostSlot === 'login'
        ? "Using Pi's own login (the account you signed in with /login), not the vault."
        : status.hostSlot === 'dormant'
          ? "Using Pi's own login, not the vault."
          : "Using Pi's own login, not the vault, but you are not signed in. Run /login to sign in."
    case 'unreadable':
      return status.modeProblem === undefined
        ? "Pi can't tell whether to use the vault or its own login, so it sends no Antigravity requests."
        : `Pi can't tell whether to use the vault or its own login (${status.modeProblem}), so it sends no Antigravity requests.`
  }
}

/** Setup-menu status text with no credentials or Antigravity project identifiers. */
export function formatPiVaultSetupStatus(status: PiVaultSetupStatus): string[] {
  const lines = [describeSource(status), describeEnrollment(status.enrollment)]
  if (status.mode === 'custody' && status.selectedRouteId !== undefined)
    lines.push('Pi uses the vault account marked "in use by Pi" below.')
  lines.push(...enrollmentGuidance(status.enrollment))
  return lines
}

// ---------------------------------------------------------------------------
// Vault section of the shared command menu
// ---------------------------------------------------------------------------

export interface PiVaultSectionOptions {
  /** The setup controller; created on first use so the vault library loads lazily. */
  setup: () => Promise<PiVaultSetup>
  /** Vault account actions, available only after the approved account source is constructed. */
  accounts?: () => PiVaultAccountsPort | undefined
  /** How Request access polls for the operator's approval (tests shorten it). */
  wait?: PiVaultWaitOptions
}

export interface PiVaultWaitOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Menu payloads leave this process (the shared menu may hand them to a
 * renderer), so a vault account's item id is an opaque digest of its route
 * id under a per-process salt: stable while Pi runs, so an apply finds the
 * same account the user saw, but never the raw route id.
 */
const ITEM_ID_SALT = randomBytes(16)

/**
 * A vault account's display name in the menu: its position in the vault's
 * list. The roster label is usually the account's email, which must not
 * leave this process in a menu payload; positions are shown, never accepted
 * as targets.
 */
export function vaultAccountName(
  listed: readonly PiVaultAccountChoice[],
  account: PiVaultAccountChoice,
): string {
  return `Vault account ${listed.indexOf(account) + 1}`
}

/** A vault account's state as its menu row shows it, in the Vault and Accounts sections alike. */
export const VAULT_ACCOUNT_IN_USE = 'in use by Pi'
export const VAULT_ACCOUNT_AVAILABLE = 'available'
export const VAULT_ACCOUNT_TURNED_OFF = 'turned off for Pi on this computer'

export function opaqueItemId(routeId: string): string {
  return `vault-${createHash('sha256').update(ITEM_ID_SALT).update(routeId).digest('hex').slice(0, 16)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refused(error: unknown): ActionOutcome {
  if (error instanceof PiVaultSetupError)
    return { ok: false, text: error.message, code: 'vault-refused' }
  throw error
}

/**
 * A failed result naming the folder when the vault library refused to save
 * Pi's vault key under a folder other users share; any other error is
 * rethrown for the menu's generic failure handling.
 */
function sharedFolderRefusal(error: unknown): ActionOutcome {
  const outcome = sharedVaultTokenFolderOutcome(error)
  if (outcome) return outcome
  throw error
}

/**
 * Poll the enrollment until it leaves `pending`/`busy` or the wait ends.
 * Returns undefined when Pi's local request disappears while waiting (it was
 * forgotten elsewhere): polling on would propose a fresh request, which the
 * vault refuses with `pending_exists` while the old one is still pending.
 */
async function waitForApproval(
  setup: PiVaultSetup,
  wait: PiVaultWaitOptions = {},
): Promise<ClaustrumEnrollmentStatus | undefined> {
  const sleep =
    wait.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = wait.pollIntervalMs ?? 2_000
  const deadline = Date.now() + (wait.timeoutMs ?? 10 * 60_000)
  let status = await setup.connectStep()
  while (status.state === 'pending' || status.state === 'busy') {
    if (Date.now() >= deadline) return status
    await sleep(interval)
    if ((await setup.sourceStatus()).enrollment.state === 'idle')
      return undefined
    status = await setup.connectStep()
  }
  return status
}

/**
 * The Vault section of Pi's command menu: mode and enrollment status, the
 * vault accounts with use/decline/accept, requesting access (the only place
 * enrollment runs), switching between the vault and the local Pi login, and
 * forgetting the enrollment. Shows status only, never the enrollment token,
 * and never a raw route id, roster label or email.
 */
export function createPiVaultSection(
  options: PiVaultSectionOptions,
): PluginExtraSection {
  // One approval watch at a time, so a second Request vault access while
  // the first is still waiting does not report the operator's decision twice.
  let watching = false

  /** Lines for an approved enrollment whose vault roster is empty; empty when unknown. */
  const approvedRosterGuidance = async (): Promise<string[]> => {
    const port = options.accounts?.()
    if (!port) return []
    try {
      return (await port.list()).length === 0
        ? piNoVaultAccountsGuidance(port.grantReach())
        : []
    } catch {
      // The Vault section reports an unreachable roster when it is opened;
      // an action result says nothing it cannot confirm.
      return []
    }
  }

  /** An enrollment step's result: its state, then what to do next. */
  const stepText = async (
    step: ClaustrumEnrollmentStatus,
    suffix = '',
  ): Promise<string> =>
    [
      `${describeEnrollment(step)}${suffix}`,
      ...enrollmentGuidance(step),
      ...(step.state === 'approved' ? await approvedRosterGuidance() : []),
    ].join('\n')

  return {
    id: 'vault',
    title: 'Vault',
    build: async () => {
      const setup = await options.setup()
      const status = await setup.status()
      const approved = status.enrollment.state === 'approved'
      const lines = formatPiVaultSetupStatus(status)
      const items: ItemDefinition[] = []
      const port = approved ? options.accounts?.() : undefined
      if (port) {
        try {
          const listed = await port.list()
          for (const account of listed) {
            const name = vaultAccountName(listed, account)
            const serving =
              status.mode === 'custody' &&
              status.selectedRouteId === account.routeId
            items.push({
              id: opaqueItemId(account.routeId),
              label: name,
              detail: account.declined
                ? VAULT_ACCOUNT_TURNED_OFF
                : serving
                  ? VAULT_ACCOUNT_IN_USE
                  : VAULT_ACCOUNT_AVAILABLE,
              actions: account.declined
                ? [
                    {
                      id: 'accept',
                      label: 'Turn back on for Pi',
                      run: async () => {
                        await port.accept(account.routeId)
                        return `Pi can use ${name} again.`
                      },
                    },
                  ]
                : [
                    {
                      id: 'use',
                      label: 'Use this account',
                      run: async () => {
                        try {
                          await setup.useVault(account.routeId)
                        } catch (error) {
                          return refused(error)
                        }
                        return `Pi now uses ${name} for Antigravity.`
                      },
                    },
                    {
                      id: 'decline',
                      label: 'Turn off for Pi',
                      description:
                        'The account stays in the vault and in this list, but Pi on this computer never uses it until you turn it back on.',
                      run: async () => {
                        await port.decline(account.routeId)
                        return `Pi on this computer won't use ${name} until you turn it back on.`
                      },
                    },
                  ],
            })
          }
          if (listed.length === 0)
            lines.push(...piNoVaultAccountsGuidance(port.grantReach()))
          else if (status.mode !== 'custody')
            lines.push(
              'Next: choose Use the vault to have Pi use these accounts.',
            )
        } catch (error) {
          lines.push(
            `Pi can't load the vault accounts right now: ${errorText(error)}`,
          )
        }
      }

      const actions: ActionDefinition[] = []
      if (!approved)
        actions.push({
          id: 'request-access',
          label: 'Request vault access',
          description:
            "Asks the vault operator to let Pi use the vault's Antigravity accounts.",
          run: async ({ invocation }) => {
            let step: ClaustrumEnrollmentStatus
            try {
              step = await setup.connectStep()
            } catch (error) {
              return sharedFolderRefusal(error)
            }
            if (step.state !== 'pending' && step.state !== 'busy')
              return {
                ok: step.state === 'approved',
                text: await stepText(step),
              }
            // The approval happens outside Pi; keep polling and report to
            // the session that asked.
            if (!watching) {
              watching = true
              void waitForApproval(setup, options.wait)
                .then(async (final) => {
                  if (final === undefined) return
                  invocation.notify(
                    await stepText(final),
                    final.state === 'approved' ? 'info' : 'warning',
                  )
                })
                .catch((error: unknown) => {
                  const folder = sharedVaultTokenFolder(error)
                  invocation.notify(
                    folder === undefined
                      ? `Requesting vault access failed: ${errorText(error)}`
                      : sharedVaultTokenFolderText(folder),
                    'error',
                  )
                })
                .finally(() => {
                  watching = false
                })
            }
            return {
              ok: true,
              text: await stepText(
                step,
                ' Pi tells you here when the operator decides.',
              ),
            }
          },
        })
      if (approved && status.mode !== 'custody')
        actions.push({
          id: 'use-vault',
          label: 'Use the vault',
          run: async () => {
            try {
              await setup.useVault(status.selectedRouteId)
            } catch (error) {
              return refused(error)
            }
            return 'Pi now uses the vault for Antigravity.'
          },
        })
      if (
        status.mode !== 'local' &&
        (status.enrollment.state === 'idle' ||
          status.enrollment.state === 'pending' ||
          status.enrollment.state === 'denied')
      )
        actions.push({
          id: 'use-local',
          label: "Use Pi's own login",
          run: async () => {
            await setup.useLocal()
            return "Pi now uses its own login for Antigravity. Run /login if you haven't signed in."
          },
        })
      // No Forget while a request is pending: the vault has no way to withdraw
      // it, so forgetting would delete the only secret that can still collect
      // the approval and leave the request blocking a new one. It returns once
      // the operator approves or denies the request.
      if (status.enrollment.state === 'pending')
        lines.push(
          `You can't disconnect while this request waits for the vault operator. To withdraw it, ask the vault operator to run ck auth enroll deny --request-id ${status.enrollment.requestId ?? '<id>'}, then choose Request vault access here so Pi sees the answer.`,
        )
      else if (status.enrollment.state !== 'idle')
        actions.push({
          id: 'forget',
          label: 'Disconnect from the vault',
          description:
            "Removes Pi's vault key from this computer and goes back to Pi's own login. Using the vault here again needs a new request and a new approval. The earlier approval stays in the vault until the vault operator revokes it.",
          irreversible: true,
          confirm:
            'Disconnect this computer from the vault? Pi goes back to its own login, and using the vault here again needs a new approval from the vault operator.',
          run: async () => {
            await setup.disconnect()
            return 'Disconnected from the vault. Pi now uses its own login for Antigravity.'
          },
        })

      return { lines, items, actions }
    },
  }
}
