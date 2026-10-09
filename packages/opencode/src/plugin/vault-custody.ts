/**
 * Vault custody for the OpenCode host (OpenCode 1 and OpenCode 2 locations
 * alike): whether Antigravity accounts are served from the plugin's own
 * account store ("local") or from the Claustrum vault ("custody"), the
 * setup steps that switch between them, and the vault account source the
 * custody request path uses.
 *
 * Everything lives in an owner-only `antigravity-auth-vault` directory
 * beside the resolved account file: the non-secret mode file, the vault
 * roster and this host's enrollment files (written by the vault library).
 * The mode file holds only the mode; no token, project or account data is
 * written here. A missing mode file is local mode, so nothing connects to
 * the vault and no source starts while local custody is in force.
 *
 * Every custody entry re-reads the mode and checks the host's own auth slot
 * against it through the vault library: a real host login while the vault
 * holds the accounts refuses custody instead of silently picking one of the
 * two. The host supplies a reader for its slot; a slot that cannot be read
 * refuses custody rather than being treated as empty.
 */

import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type AntigravityVaultAccountSource,
  type CommonAuthClaustrumModule,
  type CommonAuthCommandsModule,
  createAntigravityVaultAccountSource,
  getAntigravityVaultEnrollmentName,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  readVaultProviderState,
  resolveClaustrumConnectionPath,
  type VaultLogger,
  type VaultProviderStateFile,
  type VaultReporterSource,
  type VaultScopedClient,
} from '@cortexkit/antigravity-auth-core'
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core/atomic-write'

/** The host auth slot this plugin's provider lives in on OpenCode. */
export const OPENCODE_VAULT_PROVIDER = 'google'
/** The vault host name; one enrollment per host. */
export const OPENCODE_VAULT_HOST = 'opencode'
/** The enrollment name the vault operator sees and approves. */
export const OPENCODE_VAULT_ENROLLMENT_NAME =
  getAntigravityVaultEnrollmentName(OPENCODE_VAULT_HOST)
/** The vault directory's name, beside the resolved account file. */
export const OPENCODE_VAULT_DIR_NAME = 'antigravity-auth-vault'

type Claustrum = CommonAuthClaustrumModule
type EnrollmentStatus = Awaited<
  ReturnType<Claustrum['readClaustrumEnrollmentStatus']>
>
type EnrollmentConnection = Awaited<
  ReturnType<Claustrum['connectClaustrumEnrollmentClient']>
>
type EnrollmentPaths = ReturnType<Claustrum['hostEnrollmentPaths']>
type HostSlotContent = ReturnType<Claustrum['classifyHostSlot']>
type MenuOptions = Parameters<CommonAuthCommandsModule['createCommandMenu']>[0]
type MenuExtraSection = NonNullable<MenuOptions['extras']>[number]
type MenuActionOutcome = Exclude<
  Awaited<
    ReturnType<
      NonNullable<
        Awaited<ReturnType<MenuExtraSection['build']>>['actions']
      >[number]['run']
    >
  >,
  string
>

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface OpenCodeVaultPaths {
  readonly dir: string
  readonly modeFile: string
  readonly rosterFile: string
  /** The vault accounts' credential-free provider state. */
  readonly stateFile: string
}

/** The vault paths for one resolved account file. */
export function openCodeVaultPaths(accountFile: string): OpenCodeVaultPaths {
  const dir = join(dirname(accountFile), OPENCODE_VAULT_DIR_NAME)
  return {
    dir,
    modeFile: join(dir, 'opencode-mode.json'),
    rosterFile: join(dir, 'opencode-roster.json'),
    stateFile: join(dir, 'opencode-state.json'),
  }
}

/** Creates the vault directory readable by its owner only. */
async function ensureVaultDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

// ---------------------------------------------------------------------------
// Mode file
// ---------------------------------------------------------------------------

export type OpenCodeVaultMode = 'local' | 'custody'

export interface OpenCodeVaultModeRecord {
  readonly version: 1
  readonly mode: OpenCodeVaultMode
}

export type OpenCodeVaultModeRead =
  | { readonly ok: true; readonly record: OpenCodeVaultModeRecord }
  | { readonly ok: false; readonly reason: string }

const LOCAL_MODE: OpenCodeVaultModeRecord = Object.freeze({
  version: 1,
  mode: 'local',
})
const CUSTODY_MODE: OpenCodeVaultModeRecord = Object.freeze({
  version: 1,
  mode: 'custody',
})

function parseMode(raw: unknown): OpenCodeVaultModeRecord | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const keys = Object.keys(raw).sort()
  if (keys.length !== 2 || keys[0] !== 'mode' || keys[1] !== 'version')
    return undefined
  if (!('version' in raw) || raw.version !== 1) return undefined
  if (!('mode' in raw)) return undefined
  if (raw.mode === 'local') return LOCAL_MODE
  if (raw.mode === 'custody') return CUSTODY_MODE
  return undefined
}

/**
 * Reads the mode file. A missing file is local mode. A file that exists but
 * cannot be read or understood is reported, never guessed: custody is then
 * refused, because the user's choice is unknown.
 */
export async function readOpenCodeVaultMode(
  modeFile: string,
): Promise<OpenCodeVaultModeRead> {
  let text: string
  try {
    text = await readFile(modeFile, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return { ok: true, record: LOCAL_MODE }
    return { ok: false, reason: 'the vault mode file could not be read' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the vault mode file is not valid JSON' }
  }
  const record = parseMode(raw)
  return record
    ? { ok: true, record }
    : { ok: false, reason: 'the vault mode file has an unknown shape' }
}

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

/** A custody step refused before anything changed, with a message for the user. */
export class OpenCodeVaultCustodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCodeVaultCustodyError'
  }
}

export interface OpenCodeVaultStatus {
  readonly mode: OpenCodeVaultMode | 'unreadable'
  readonly modeProblem?: string
  readonly enrollment: EnrollmentStatus
  /** `unreadable` when the host's slot reader failed. */
  readonly hostSlot: HostSlotContent | 'unreadable'
}

export interface OpenCodeVaultCustodyOptions {
  /** The resolved account file the vault directory sits beside. */
  readonly accountFile: string
  /**
   * The host's own auth slot for `google`, read through the host's public
   * API and shaped as the vault library classifies it (`oauth` or `api`).
   * It must reject when the slot cannot be read.
   */
  readonly readHostSlot: () => Promise<unknown>
  /** Which side reads a send's HTTP status for 401 reports. */
  readonly reporterSource: VaultReporterSource
  /**
   * The vault's connection file; defaults to the vault client library's own
   * resolution of it (core `resolveClaustrumConnectionPath`). Read only when
   * a vault client is opened.
   */
  readonly connectionFile?: () => string | Promise<string>
  readonly loadClaustrum?: () => Promise<Claustrum>
  /** Opens the request-path vault client; defaults to the connection file. */
  readonly connect?: () => Promise<VaultScopedClient>
  /** Opens the setup-only enrollment client; defaults to the connection file. */
  readonly connectEnrollment?: () => Promise<EnrollmentConnection>
  readonly logger?: VaultLogger
  readonly now?: () => number
}

export interface OpenCodeVaultCustody {
  readonly paths: OpenCodeVaultPaths
  readMode(): Promise<OpenCodeVaultModeRead>
  /**
   * The vault account source for a custody send path. Refused unless the
   * mode is custody, this host's enrollment is approved and the host slot
   * holds no real login. The source is created once and reused until
   * custody ends.
   */
  custodySource(): Promise<AntigravityVaultAccountSource>
  status(): Promise<OpenCodeVaultStatus>
  /** One enrollment step: propose this host to the vault, or poll the proposal. */
  requestAccess(): Promise<EnrollmentStatus>
  /** Serve accounts from the vault from now on. */
  useVault(): Promise<void>
  /** Serve accounts from the local account store again; ends the vault source. */
  useLocal(): Promise<void>
  /** The Vault section of the `/antigravity` menu. */
  menuSection(): MenuExtraSection
  /** The vault accounts' stored provider state (missing file: none). */
  readState(): Promise<VaultProviderStateFile>
  /** Closes the vault source, if one was created. */
  dispose(): Promise<void>
}

export function createOpenCodeVaultCustody(
  options: OpenCodeVaultCustodyOptions,
): OpenCodeVaultCustody {
  const paths = openCodeVaultPaths(options.accountFile)
  const loadClaustrum = options.loadClaustrum ?? loadCommonAuthClaustrum
  const connectionFile =
    options.connectionFile ?? (() => resolveClaustrumConnectionPath())
  let source: AntigravityVaultAccountSource | null = null
  let creating: Promise<AntigravityVaultAccountSource> | null = null

  const enrollmentPaths = async (): Promise<EnrollmentPaths> =>
    (await loadClaustrum()).hostEnrollmentPaths({
      stateDir: paths.dir,
      host: OPENCODE_VAULT_HOST,
    })

  const readEnrollment = async (): Promise<EnrollmentStatus> => {
    const claustrum = await loadClaustrum()
    return claustrum
      .readClaustrumEnrollmentStatus(
        await enrollmentPaths(),
        OPENCODE_VAULT_ENROLLMENT_NAME,
      )
      .catch(
        (): EnrollmentStatus => ({
          state: 'blocked',
          proposedName: OPENCODE_VAULT_ENROLLMENT_NAME,
          code: 'unreadable-state',
        }),
      )
  }

  /** Refuses custody unless the host slot reads and holds no real login. */
  const assertCustodySlot = async (): Promise<void> => {
    const claustrum = await loadClaustrum()
    let slot: unknown
    try {
      slot = await options.readHostSlot()
    } catch {
      throw new OpenCodeVaultCustodyError(
        'OpenCode\u2019s own sign-in for Google could not be read, so the vault cannot be used.',
      )
    }
    try {
      claustrum.assertHostSlotMatchesMode({
        mode: 'custody',
        auth: slot,
        provider: OPENCODE_VAULT_PROVIDER,
      })
    } catch {
      throw new OpenCodeVaultCustodyError(
        'OpenCode is signed in to Google with its own login. Remove that login before serving accounts from the vault.',
      )
    }
  }

  const requireCustodyMode = async (): Promise<void> => {
    const mode = await readOpenCodeVaultMode(paths.modeFile)
    if (!mode.ok)
      throw new OpenCodeVaultCustodyError(
        `The vault mode is unclear (${mode.reason}). Choose a mode in the Vault section of the Antigravity menu.`,
      )
    if (mode.record.mode !== 'custody')
      throw new OpenCodeVaultCustodyError(
        'Antigravity accounts are not served from the vault.',
      )
  }

  const closeSource = async (): Promise<void> => {
    const pending = creating
    creating = null
    const current = source ?? (await pending?.catch(() => null)) ?? null
    source = null
    current?.close()
  }

  const custody: OpenCodeVaultCustody = {
    paths,
    readMode: () => readOpenCodeVaultMode(paths.modeFile),

    async custodySource() {
      await requireCustodyMode()
      await assertCustodySlot()
      if (source) return source
      creating ??= (async () => {
        const claustrum = await loadClaustrum()
        const { tokenPath } = await enrollmentPaths()
        const created = createAntigravityVaultAccountSource({
          claustrum,
          host: OPENCODE_VAULT_HOST,
          hostProvider: OPENCODE_VAULT_PROVIDER,
          rosterPath: paths.rosterFile,
          tokenPath,
          connect:
            options.connect ??
            (async () =>
              claustrum.connectClaustrumScopedClient({
                connectionFile: await connectionFile(),
              })),
          // The vault serves this host only while the mode file says custody
          // and an approved enrollment token is on disk.
          isCustodyActive: async () => {
            const mode = await readOpenCodeVaultMode(paths.modeFile)
            if (!mode.ok || mode.record.mode !== 'custody') return false
            return (await readEnrollment()).state === 'approved'
          },
          readHostSlot: () => options.readHostSlot(),
          reporterSource: options.reporterSource,
          state: { path: paths.stateFile, fs: await loadCommonAuthFs() },
          ...(options.logger ? { logger: options.logger } : {}),
          ...(options.now ? { now: options.now } : {}),
        })
        created.start()
        source = created
        return created
      })()
      try {
        return await creating
      } catch (error) {
        creating = null
        throw error
      }
    },

    async status() {
      const mode = await readOpenCodeVaultMode(paths.modeFile)
      const claustrum = await loadClaustrum()
      let hostSlot: OpenCodeVaultStatus['hostSlot']
      try {
        hostSlot = claustrum.classifyHostSlot(
          await options.readHostSlot(),
          OPENCODE_VAULT_PROVIDER,
        )
      } catch {
        hostSlot = 'unreadable'
      }
      return {
        ...(mode.ok
          ? { mode: mode.record.mode }
          : { mode: 'unreadable' as const, modeProblem: mode.reason }),
        enrollment: await readEnrollment(),
        hostSlot,
      }
    },

    async requestAccess() {
      const claustrum = await loadClaustrum()
      await ensureVaultDir(paths.dir)
      const client = await (options.connectEnrollment
        ? options.connectEnrollment()
        : claustrum.connectClaustrumEnrollmentClient({
            connectionFile: await connectionFile(),
          }))
      try {
        const manager = new claustrum.ClaustrumEnrollmentManager({
          client,
          paths: await enrollmentPaths(),
          proposedName: OPENCODE_VAULT_ENROLLMENT_NAME,
          ...(options.now ? { now: options.now } : {}),
        })
        const current = await manager.status()
        if (current.state === 'denied' || current.state === 'blocked')
          await manager.resetTerminal()
        return await manager.reconcile()
      } finally {
        client.close()
      }
    },

    async useVault() {
      const enrollment = await readEnrollment()
      if (enrollment.state !== 'approved')
        throw new OpenCodeVaultCustodyError(
          'OpenCode is not enrolled with the vault yet. Request access and wait for the operator to approve it first.',
        )
      await assertCustodySlot()
      await ensureVaultDir(paths.dir)
      await writeJsonAtomic(paths.modeFile, CUSTODY_MODE)
    },

    async useLocal() {
      await ensureVaultDir(paths.dir)
      await writeJsonAtomic(paths.modeFile, LOCAL_MODE)
      await closeSource()
    },

    menuSection() {
      return {
        id: 'vault',
        title: 'Vault',
        build: async () => {
          const status = await custody.status()
          const actions: NonNullable<
            Awaited<ReturnType<MenuExtraSection['build']>>['actions']
          > = [
            {
              id: 'request-access',
              label:
                status.enrollment.state === 'pending'
                  ? 'Check vault approval'
                  : 'Request vault access',
              run: async () =>
                `Vault access: ${describeEnrollment(await custody.requestAccess())}`,
            },
          ]
          if (status.mode !== 'custody')
            actions.push({
              id: 'use-vault',
              label: 'Serve accounts from the vault',
              run: async () => refusalOr(() => custody.useVault()),
            })
          if (status.mode !== 'local')
            actions.push({
              id: 'use-local',
              label: 'Serve accounts from this computer',
              run: async () => refusalOr(() => custody.useLocal()),
            })
          return { lines: statusLines(status), actions }
        },
      }
    },

    readState: () => readVaultProviderState(paths.stateFile),

    dispose: closeSource,
  }
  return custody
}

async function refusalOr(
  step: () => Promise<void>,
): Promise<string | MenuActionOutcome> {
  try {
    await step()
  } catch (error) {
    if (error instanceof OpenCodeVaultCustodyError)
      return { ok: false, text: error.message, code: 'refused' }
    throw error
  }
  return 'Done. Start a new request to use the change.'
}

function describeEnrollment(status: EnrollmentStatus): string {
  switch (status.state) {
    case 'idle':
      return 'not requested'
    case 'pending':
      return status.retryCode
        ? `waiting for operator approval (retrying: ${status.retryCode})`
        : 'waiting for operator approval'
    case 'approved':
      return `approved as ${status.approvedName ?? status.proposedName}`
    case 'denied':
      return 'denied by the operator'
    case 'blocked':
      return `blocked (${status.code})`
    case 'unavailable':
      return `vault unavailable (${status.code})`
    case 'busy':
      return 'another setup step is running'
  }
}

function describeHostSlot(slot: OpenCodeVaultStatus['hostSlot']): string {
  switch (slot) {
    case 'login':
      return 'signed in with an OpenCode login'
    case 'placeholder':
      return 'holds the vault placeholder'
    case 'empty':
      return 'empty'
    case 'unreadable':
      return 'could not be read'
  }
}

/** Non-secret status lines: never a token, project or account address. */
export function statusLines(status: OpenCodeVaultStatus): string[] {
  return [
    `Mode: ${
      status.mode === 'custody'
        ? 'vault'
        : status.mode === 'local'
          ? 'this computer'
          : `unclear (${status.modeProblem ?? 'unknown'})`
    }`,
    `Vault access: ${describeEnrollment(status.enrollment)}`,
    `OpenCode Google sign-in: ${describeHostSlot(status.hostSlot)}`,
  ]
}
