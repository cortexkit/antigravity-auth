/**
 * Vault custody for the OpenCode host (OpenCode 1 and OpenCode 2 locations
 * alike): whether Antigravity accounts are served from the plugin's own
 * account store ("local") or from the Claustrum vault ("custody"), the
 * setup steps that switch between them, and the vault account source the
 * custody request path uses.
 *
 * Everything lives in an owner-only `antigravity-auth-vault` directory, the
 * vault folder the entry point settled for this process (`vault-folder.ts`):
 * the non-secret mode file, the vault roster and this host's enrollment files
 * (written by the vault library).
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

import { chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AntigravityVaultAccountSource,
  type CommonAuthClaustrumModule,
  type CommonAuthCommandsModule,
  createAntigravityVaultAccountSource,
  type EmptyVaultRosterCause,
  type EnrollmentAuthority,
  emptyVaultRosterCause,
  enrollmentAuthority,
  getAntigravityVaultEnrollmentName,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  readVaultProviderState,
  resolveClaustrumConnectionPath,
  sharedVaultTokenFolderOutcome,
  UNSUPPORTED_VAULT_CODE,
  VAULT_ACCOUNT_REMEDY,
  VAULT_RECLASSIFY_COMMAND,
  VAULT_STATUS_COMMAND,
  type VaultGrantReach,
  type VaultLogger,
  type VaultProviderStateFile,
  type VaultReporterSource,
  type VaultScopedClient,
} from '@cortexkit/antigravity-auth-core'
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core/atomic-write'

import { removeMovedVaultStateLeftover } from '../runtime-layout'
import { createLogger } from './logger'
import {
  createVaultAccountPool,
  type VaultAccountPool,
  type VaultAccountPoolOptions,
} from './shared/vault-request-credentials.ts'
import { normalizeVaultInsulaQuota } from './vault-insula-quota'

/** The host auth slot this plugin's provider lives in on OpenCode. */
export const OPENCODE_VAULT_PROVIDER = 'google'
/** The vault host name; one enrollment per host. */
export const OPENCODE_VAULT_HOST = 'opencode'
/** The enrollment name the vault operator sees and approves. */
export const OPENCODE_VAULT_ENROLLMENT_NAME =
  getAntigravityVaultEnrollmentName(OPENCODE_VAULT_HOST)
/**
 * The vault directory's name, in both places it can live: beside the account
 * file, and in the plugin's state-home folder (`runtime-paths.ts`).
 */
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

/** One read of this host's enrollment files: the mode and the status. */
interface EnrollmentSnapshot {
  readonly authority: EnrollmentAuthority
  readonly status: EnrollmentStatus
}

/**
 * How long a remembered enrollment read lasts where a file's identity may not
 * change on every write: on Windows some file systems report inode 0, so a
 * replaced file is told apart only by its times and size.
 */
const COARSE_ENROLLMENT_IDENTITY_TTL_MS = 250

/**
 * The device, inode, size and change times of both enrollment files, taken
 * before they are read. Undefined when a file cannot be examined; the caller
 * then reads the files without remembering the result.
 */
async function enrollmentFilesIdentity(
  paths: EnrollmentPaths,
): Promise<
  | { readonly key: string; readonly coarse: boolean; readonly takenAt: number }
  | undefined
> {
  // A monotonic clock: a wall clock moved back (or frozen by a test) must not
  // stretch the expiry.
  const takenAt = performance.now()
  let coarse = process.platform === 'win32'
  const parts: string[] = []
  for (const path of [paths.tokenPath, paths.statePath]) {
    try {
      const info = await stat(path, { bigint: true })
      if (info.ino === 0n) coarse = true
      parts.push(
        `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      )
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        parts.push('absent')
      else return undefined
    }
  }
  return { key: parts.join('|'), coarse, takenAt }
}

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

/** The vault paths inside one vault folder. */
export function openCodeVaultPaths(vaultDir: string): OpenCodeVaultPaths {
  const dir = vaultDir
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
  readonly hostSlot: HostSlotContent | 'unreadable' | 'not-used'
}

export interface OpenCodeVaultCustodyOptions {
  readonly onAuthorityChanged?: (authority: EnrollmentAuthority) => void
  readonly onRosterChanged?: () => void
  /**
   * The folder holding this host's vault files: the one the entry point
   * settled for this process (`prepareVaultFolder` in `vault-folder.ts`).
   */
  readonly vaultDir: string
  /**
   * The account file that folder was settled against. Disconnect hands it to
   * `removeMovedVaultStateLeftover`, which looks for an old vault folder
   * beside it. Defaults to the one `legacyAccountFile()` names.
   */
  readonly accountFile?: string
  /**
   * Set when the entry point could not settle where the vault files live:
   * the refusal's message, which names the folders involved. Custody then
   * reads and writes no vault file. The mode reads as unclear with this text,
   * so neither vault nor local accounts are served, the Vault section shows
   * it, and every vault action refuses with it.
   */
  readonly layoutRefusal?: string
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
  /** Background observation interval; the shared consumer keeps its 5s default. */
  readonly pollIntervalMs?: number
  /** Enable the OpenCode 1 background quota source; other hosts keep direct polling. */
  readonly insulaQuota?: boolean
}

export interface OpenCodeVaultCustody {
  /** Detect approval and disconnect with the existing enrollment-status poll, without another timer. Local mode opens no vault connection. */
  startObservation(): Promise<void>
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
  /**
   * The enrollment name the vault grants read access to: the name in the
   * last approved status custody read, else the default name.
   */
  grantPrincipal(): string
  /**
   * Replaces a source whose refresh has stayed pending for `maxMs` or more:
   * the source is disposed, which makes its pending refreshes reject, and the
   * next `custodySource` (or observation, while it runs) builds a new one.
   * Resolves true when a source was replaced.
   */
  recycleStalledSource(maxMs: number): Promise<boolean>
  /** The source custody currently serves, without any I/O; null before one exists. */
  currentSource(): AntigravityVaultAccountSource | null
  /** Closes the vault source, if one was created. */
  dispose(): Promise<void>
}

export function createOpenCodeVaultCustody(
  options: OpenCodeVaultCustodyOptions,
): OpenCodeVaultCustody {
  const paths = openCodeVaultPaths(options.vaultDir)
  const layoutRefusal = options.layoutRefusal
  // What custody reports for this host's enrollment while the vault folder
  // is unsettled: nothing is read, and the code says why.
  const unsettled: EnrollmentStatus = {
    state: 'unavailable',
    proposedName: OPENCODE_VAULT_ENROLLMENT_NAME,
    code: 'vault-folder-unsettled',
  }
  const refuseUnsettled = () => {
    if (layoutRefusal !== undefined)
      throw new OpenCodeVaultCustodyError(layoutRefusal)
  }
  const loadClaustrum = options.loadClaustrum ?? loadCommonAuthClaustrum
  const connectionFile =
    options.connectionFile ?? (() => resolveClaustrumConnectionPath())
  let source: AntigravityVaultAccountSource | null = null
  let creating: Promise<AntigravityVaultAccountSource> | null = null
  // The enrollment name from the last approved status read here. The request
  // path's no-account message is built synchronously, so it cannot read the
  // enrollment itself; the source's custody check reads it before each listing.
  let approvedPrincipal: string | undefined
  // When each refresh of the current source that is still pending began.
  let pendingRefreshes = new Map<symbol, number>()
  const clock = options.now ?? Date.now

  const enrollmentPaths = async (): Promise<EnrollmentPaths> =>
    (await loadClaustrum()).hostEnrollmentPaths({
      stateDir: paths.dir,
      host: OPENCODE_VAULT_HOST,
    })

  const readEnrollment = async (): Promise<EnrollmentStatus> => {
    if (layoutRefusal !== undefined) return unsettled
    const claustrum = await loadClaustrum()
    const status = await claustrum
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
    if (status.state === 'approved') approvedPrincipal = grantPrincipal(status)
    return status
  }

  /**
   * The last enrollment read, kept while both enrollment files keep the
   * identity they had just before that read. The vault library replaces these
   * files by atomic rename, so an approval or a disconnect gives a file a new
   * identity and the next call reads it again. Where identities are coarse
   * (see COARSE_ENROLLMENT_IDENTITY_TTL_MS), a kept read also expires after a
   * short time. Concurrent callers that see the same identity share one read.
   */
  let enrollmentCache:
    | {
        readonly key: string
        readonly expiresAt: number
        readonly value: EnrollmentSnapshot
      }
    | undefined
  let enrollmentReading:
    | { readonly key: string; readonly promise: Promise<EnrollmentSnapshot> }
    | undefined
  const forgetEnrollment = () => {
    enrollmentCache = undefined
    enrollmentReading = undefined
  }

  const readEnrollmentSnapshot = async (): Promise<EnrollmentSnapshot> => {
    if (layoutRefusal !== undefined)
      return { authority: 'unreadable', status: unsettled }
    const enrollment = await enrollmentPaths()
    const identity = await enrollmentFilesIdentity(enrollment)
    if (identity) {
      const cached = enrollmentCache
      if (cached?.key === identity.key && performance.now() <= cached.expiresAt)
        return cached.value
      if (enrollmentReading?.key === identity.key)
        return enrollmentReading.promise
    }
    const promise = (async (): Promise<EnrollmentSnapshot> => {
      // The mode stays the vault library's own decision, which treats a
      // corrupt or missing token specially; the status adds the approval.
      const authority = await enrollmentAuthority(
        enrollment,
        OPENCODE_VAULT_ENROLLMENT_NAME,
        await loadClaustrum(),
      )
      return { authority, status: await readEnrollment() }
    })()
    if (!identity) return promise
    const reading = { key: identity.key, promise }
    enrollmentReading = reading
    try {
      const value = await promise
      // A failed read is not kept: it may be transient, and is retried.
      const failed =
        value.authority === 'unreadable' ||
        (value.status.state === 'blocked' &&
          value.status.code === 'unreadable-state')
      if (!failed && enrollmentReading === reading)
        enrollmentCache = {
          key: identity.key,
          expiresAt: identity.coarse
            ? identity.takenAt + COARSE_ENROLLMENT_IDENTITY_TTL_MS
            : Number.POSITIVE_INFINITY,
          value,
        }
      return value
    } finally {
      if (enrollmentReading === reading) enrollmentReading = undefined
    }
  }

  const requireCustodyMode = async (): Promise<void> => {
    refuseUnsettled()
    const mode = await custody.readMode()
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
    pendingRefreshes = new Map()
    await current?.dispose()
  }

  let observedAuthority: EnrollmentAuthority | undefined
  let observing = false
  let closed = false
  let watching: Promise<void> | undefined
  let cancelWait: (() => void) | undefined
  const ensureSource = async (): Promise<AntigravityVaultAccountSource> => {
    if (closed) throw new OpenCodeVaultCustodyError('Vault custody is disposed')
    refuseUnsettled()
    if (source) return source
    creating ??= (async () => {
      const claustrum = await loadClaustrum()
      const { tokenPath } = await enrollmentPaths()
      const created = createAntigravityVaultAccountSource({
        claustrum,
        host: OPENCODE_VAULT_HOST,
        rosterPath: paths.rosterFile,
        tokenPath,
        connect:
          options.connect ??
          (async () =>
            claustrum.connectClaustrumScopedClient({
              connectionFile: await connectionFile(),
            })),
        isCustodyActive: async () => {
          if (closed) return false
          // Mode and approval come from one enrollment read.
          const { authority, status } = await readEnrollmentSnapshot()
          if (closed) return false
          if (authority !== observedAuthority) {
            observedAuthority = authority
            options.onAuthorityChanged?.(authority)
          }
          if (authority !== 'vault') return false
          return status.state === 'approved'
        },
        onRoster: () => options.onRosterChanged?.(),
        onError: () => options.onRosterChanged?.(),
        reporterSource: options.reporterSource,
        state: { path: paths.stateFile, fs: await loadCommonAuthFs() },
        ...(options.insulaQuota
          ? {
              insula: {
                provider: 'antigravity',
                normalize: normalizeVaultInsulaQuota,
              },
            }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.pollIntervalMs !== undefined
          ? { pollIntervalMs: options.pollIntervalMs }
          : {}),
      })
      const refreshes = new Map<symbol, number>()
      // Each refresh is timed, so a consumer refresh that never settles can be
      // found and its source replaced (`recycleStalledSource`).
      const timedRefresh = async () => {
        const id = Symbol('refresh')
        refreshes.set(id, clock())
        try {
          return await created.refresh()
        } finally {
          refreshes.delete(id)
        }
      }
      const activeSource: AntigravityVaultAccountSource = {
        ...created,
        refresh: async () => {
          const roster = await timedRefresh()
          // A request can join an observer tick that read local authority just
          // before approval. Its empty result is not vault discovery: retry
          // through the consumer's shared in-flight slot under fresh authority.
          if (!roster && !closed) {
            const mode = await custody.readMode()
            if (mode.ok && mode.record.mode === 'custody') return timedRefresh()
          }
          return roster
        },
      }
      source = activeSource
      pendingRefreshes = refreshes
      created.start()
      return activeSource
    })()
    try {
      return await creating
    } catch (error) {
      creating = null
      throw error
    }
  }

  /**
   * What an approved host does next. In vault mode, read the roster the
   * vault source last saved (no vault round trip while the menu opens): an
   * empty one means the vault serves this host nothing. The grants named by
   * the running source's latest discovery say why; without a running source
   * they are unknown. A missing or unreadable roster says nothing, since
   * emptiness is unknown.
   */
  const approvedNextSteps = async (
    mode: OpenCodeVaultStatus['mode'],
    principal: string,
  ): Promise<string[]> => {
    if (mode === 'local')
      return [
        'Next: choose Serve accounts from the vault to use the accounts the vault serves this host.',
      ]
    if (mode !== 'custody') return []
    try {
      const roster = await (await loadClaustrum()).readVaultRoster(
        paths.rosterFile,
      )
      return roster?.rows.length === 0
        ? noVaultAccountsGuidance(source?.grantReach(), principal)
        : []
    } catch {
      return []
    }
  }

  const connectStep = async (
    resetTerminal: boolean,
  ): Promise<EnrollmentStatus> => {
    if (closed) throw new OpenCodeVaultCustodyError('Vault custody is disposed')
    refuseUnsettled()
    const claustrum = await loadClaustrum()
    // Enrollment creates missing directories with native owner-only ACLs on Windows.
    // Precreating one with mkdir/chmod would leave an inherited DACL the token writer refuses.
    const client = await (options.connectEnrollment
      ? options.connectEnrollment()
      : claustrum.connectClaustrumEnrollmentClient({
          connectionFile: await connectionFile(),
        }))
    try {
      if (closed)
        throw new OpenCodeVaultCustodyError('Vault custody is disposed')
      const manager = new claustrum.ClaustrumEnrollmentManager({
        client,
        paths: await enrollmentPaths(),
        proposedName: OPENCODE_VAULT_ENROLLMENT_NAME,
        ...(options.now ? { now: options.now } : {}),
      })
      const current = await manager.status()
      if (
        resetTerminal &&
        (current.state === 'denied' || current.state === 'blocked')
      )
        await manager.resetTerminal()
      return await manager.reconcile()
    } finally {
      // This step may have rewritten the enrollment files.
      forgetEnrollment()
      client.close()
    }
  }

  const stepText = async (step: EnrollmentStatus): Promise<string> =>
    [
      `Vault access: ${describeEnrollment(step)}`,
      ...enrollmentGuidance(step),
      ...(step.state === 'approved'
        ? await approvedNextSteps(
            (await custody.status()).mode,
            grantPrincipal(step),
          )
        : []),
    ].join('\n')

  const waitForApproval = async (): Promise<EnrollmentStatus | undefined> => {
    while (!closed) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          cancelWait = undefined
          resolve()
        }
        const timer = setTimeout(done, 2_000)
        timer.unref?.()
        cancelWait = done
      })
      if (closed) return undefined
      const current = await readEnrollment()
      // A disconnected ceremony has lost its request secret. Do not propose
      // another request while the abandoned one may still be pending in the vault.
      if (closed || current.state === 'idle') return undefined
      if (current.state !== 'pending' && current.state !== 'busy')
        return current
      const step = await connectStep(false)
      if (step.state !== 'pending' && step.state !== 'busy') return step
    }
    return undefined
  }

  const custody: OpenCodeVaultCustody = {
    paths,
    async startObservation() {
      // Nothing to observe while the vault folder is unsettled; the start
      // goes on so the menu and requests can say why.
      if (layoutRefusal !== undefined) return
      observing = true
      await ensureSource()
    },
    async readMode() {
      if (layoutRefusal !== undefined)
        return { ok: false, reason: layoutRefusal }
      const { authority } = await readEnrollmentSnapshot()
      if (authority === 'unreadable')
        return { ok: false, reason: VAULT_ACCOUNT_REMEDY }
      return {
        ok: true,
        record: authority === 'vault' ? CUSTODY_MODE : LOCAL_MODE,
      }
    },

    async custodySource() {
      await requireCustodyMode()
      return ensureSource()
    },

    async status() {
      const mode = await custody.readMode()
      const claustrum = await loadClaustrum()
      let hostSlot: OpenCodeVaultStatus['hostSlot']
      try {
        hostSlot =
          !mode.ok || mode.record.mode === 'custody'
            ? 'not-used'
            : claustrum.classifyHostSlot(
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
      return connectStep(true)
    },

    async useVault() {
      refuseUnsettled()
      const enrollment = await readEnrollment()
      if (enrollment.state !== 'approved')
        throw new OpenCodeVaultCustodyError(
          'OpenCode is not enrolled with the vault yet. Request access and wait for the operator to approve it first.',
        )
      await ensureVaultDir(paths.dir)
      await writeJsonAtomic(paths.modeFile, CUSTODY_MODE)
    },

    async useLocal() {
      refuseUnsettled()
      const claustrum = await loadClaustrum()
      const disconnected = await claustrum.disconnectClaustrumEnrollment(
        await enrollmentPaths(),
        OPENCODE_VAULT_ENROLLMENT_NAME,
      )
      forgetEnrollment()
      if (disconnected === 'busy')
        throw new OpenCodeVaultCustodyError(
          'Vault enrollment is busy. Disconnect after the current enrollment operation finishes.',
        )
      if (!observing) await closeSource()
      await ensureVaultDir(paths.dir)
      await writeJsonAtomic(paths.modeFile, LOCAL_MODE)
      if (observing) await source?.refresh()
      // A move of the vault files out of OpenCode's config folder may have
      // left the enrollment state there, so that older versions of this
      // plugin kept refusing local accounts. Disconnected, they may use them
      // again: remove that leftover too.
      try {
        await removeMovedVaultStateLeftover(paths.dir, options.accountFile)
      } catch (error) {
        ;(options.logger ?? createLogger('vault-custody')).warn(
          "The vault enrollment state a move left in OpenCode's config folder could not be removed; older plugin versions still read vault mode there",
          { error: error instanceof Error ? error.message : String(error) },
        )
      }
    },

    menuSection() {
      return {
        id: 'vault',
        title: 'Vault',
        build: async () => {
          // The start could not settle where the vault files live: say why,
          // and offer nothing that would touch them.
          if (layoutRefusal !== undefined)
            return { lines: [`Vault: ${layoutRefusal}`], actions: [] }
          const status = await custody.status()
          const lines = statusLines(status)
          if (status.enrollment.state === 'approved')
            lines.push(
              ...(await approvedNextSteps(
                status.mode,
                grantPrincipal(status.enrollment),
              )),
            )
          const actions: NonNullable<
            Awaited<ReturnType<MenuExtraSection['build']>>['actions']
          > = [
            {
              id: 'request-access',
              label:
                status.enrollment.state === 'pending'
                  ? 'Check vault approval'
                  : 'Request vault access',
              run: async ({ invocation }) => {
                let step: EnrollmentStatus
                try {
                  step = await custody.requestAccess()
                } catch (error) {
                  // A vault key the library refuses to save under a folder
                  // other users share gets its own plain sentence.
                  return (
                    sharedVaultTokenFolderOutcome(error) ?? {
                      ok: false,
                      text: `Requesting vault access failed: ${error instanceof Error ? error.message : String(error)}. Check the vault connection and request access again.`,
                    }
                  )
                }
                if (
                  (step.state === 'pending' || step.state === 'busy') &&
                  !watching &&
                  !closed
                ) {
                  // All menu builds share one watch; its notice belongs to the
                  // session that first requested access, not later menu visitors.
                  watching = waitForApproval()
                    .then(async (final) => {
                      if (final === undefined || closed) return
                      const text = await stepText(final)
                      if (!closed)
                        invocation.notify(
                          text,
                          final.state === 'approved' ? 'info' : 'warning',
                        )
                    })
                    .catch((error: unknown) => {
                      if (!closed)
                        invocation.notify(
                          sharedVaultTokenFolderOutcome(error)?.text ??
                            `Requesting vault access failed: ${error instanceof Error ? error.message : String(error)}. Check the vault connection and request access again.`,
                          'error',
                        )
                    })
                    .finally(() => {
                      watching = undefined
                    })
                }
                return {
                  ok: step.state === 'approved' || step.state === 'pending',
                  text: await stepText(step),
                }
              },
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
              label: 'Disconnect vault and restore local accounts',
              run: async () => refusalOr(() => custody.useLocal()),
            })
          return { lines, actions }
        },
      }
    },

    readState: async () => {
      refuseUnsettled()
      return readVaultProviderState(paths.stateFile)
    },

    grantPrincipal: () => approvedPrincipal ?? OPENCODE_VAULT_ENROLLMENT_NAME,

    async recycleStalledSource(maxMs) {
      const current = source
      if (!current || closed) return false
      const now = clock()
      let stalled = false
      for (const startedAt of pendingRefreshes.values())
        if (now - startedAt >= maxMs) stalled = true
      if (!stalled) return false
      source = null
      creating = null
      pendingRefreshes = new Map()
      // Disposing closes the consumer, whose pending refresh then rejects
      // instead of waiting on its connect forever.
      await current.dispose().catch(() => {})
      // The observer ran on the replaced source; resume it on a new one.
      if (observing && !closed) await ensureSource()
      return true
    },

    currentSource: () => source,

    dispose: async () => {
      closed = true
      cancelWait?.()
      await closeSource()
      await watching
    },
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

function isUnsupportedEnrollment(status: EnrollmentStatus): boolean {
  return (
    status.state === 'unavailable' && status.code === UNSUPPORTED_VAULT_CODE
  )
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
      return isUnsupportedEnrollment(status)
        ? 'vault too old to connect plugins'
        : `vault unavailable (${status.code})`
    case 'busy':
      return 'another setup step is running'
  }
}

/**
 * The vault operator approves and grants with Claustrum's `ck` command,
 * outside OpenCode. Approval alone serves nothing: the enrollment also needs
 * read access to the vault's Antigravity accounts. The grant names the
 * enrollment as the operator approved it, which may differ from the name
 * OpenCode proposed.
 */
export function vaultGrantCommand(principal: string): string {
  return `ck auth grant --principal enrolled:${principal} --selector-kind category --selector antigravity-native --operation read`
}

/**
 * The enrollment name the vault knows this host by: the name the operator
 * approved, else the proposed name, else the default this host proposes.
 */
function grantPrincipal(status: EnrollmentStatus): string {
  return (
    (status.state === 'approved' ? status.approvedName : undefined) ??
    (status.state === 'idle' || status.state === 'busy'
      ? undefined
      : status.proposedName) ??
    OPENCODE_VAULT_ENROLLMENT_NAME
  )
}

/** What to do while this host's request waits in the vault; names the request when its ID is known. */
function pendingEnrollmentGuidance(requestId?: string): string[] {
  return [
    'Next, the vault operator runs these outside OpenCode:',
    requestId === undefined
      ? '1. Find the request ID with ck auth enroll list, then approve it: ck auth enroll approve --request-id <id>'
      : `1. Approve the request: ck auth enroll approve --request-id ${requestId}`,
    // The operator may approve the request under another name; the grant
    // must name the approved one, so the default only serves as an example.
    `2. Grant read access to the name approved in step 1, for example: ${vaultGrantCommand(OPENCODE_VAULT_ENROLLMENT_NAME)}`,
    'Both are needed: an approval without the grant serves this host no accounts.',
    '3. OpenCode checks approval in the background and tells this session when the operator decides; once approved, accounts come from the vault.',
  ]
}

/**
 * Why a new request was refused with `pending_exists`, and the way out. The
 * vault holds one pending request per name; an earlier one blocks a new one
 * until it expires or the operator denies it.
 */
function pendingExistsGuidance(): string[] {
  return [
    `An earlier request for ${OPENCODE_VAULT_ENROLLMENT_NAME} is still pending in the vault, possibly from an earlier, abandoned request on this host.`,
    'It expires 15 minutes after it was made; request vault access again after that.',
    'Or the vault operator clears it now: find its ID with ck auth enroll list, run ck auth enroll deny --request-id <id>, then request vault access again here.',
  ]
}

/**
 * Shown when this host is approved but the vault lists no Antigravity
 * accounts for it. When the vault reported this host's grants, they tell the
 * two causes apart: no grant at all, or a grant that matches no login. When
 * the grants are unknown, the general message names the grant command.
 * `principal` is the enrollment name the operator approved.
 */
function noVaultAccountsGuidance(
  reach: VaultGrantReach | undefined,
  principal: string,
): string[] {
  return emptyRosterGuidance(emptyVaultRosterCause(reach), principal)
}

/** The Vault section's lines for each reason the vault serves no account. */
function emptyRosterGuidance(
  cause: EmptyVaultRosterCause,
  principal: string,
): string[] {
  switch (cause) {
    case 'no-grant':
      return [
        `Vault access is approved. The vault has not granted ${principal} read access.`,
        `The vault operator grants it with: ${vaultGrantCommand(principal)}`,
      ]
    case 'grant-reaches-nothing':
      return [
        `Vault access is approved. ${principal} has read access, but it reaches no Antigravity login in the vault.`,
        `The vault operator updates the vault's logins with: ${VAULT_RECLASSIFY_COMMAND}`,
        `Then they check them with: ${VAULT_STATUS_COMMAND}`,
      ]
    case 'unknown':
      return [
        `Vault access is approved, but the vault serves ${principal} no Antigravity accounts.`,
        `The vault operator grants read access with: ${vaultGrantCommand(principal)}`,
      ]
  }
}

/**
 * The message for a request that finds no account because the vault serves
 * this host none: the Vault section's lines for the same cause, one per line.
 * `principal` is the enrollment name the operator approved; without it the
 * default name is used. An unknown cause returns undefined, so the request
 * keeps the general vault remedy.
 */
export function openCodeEmptyVaultRosterRefusal(
  cause: EmptyVaultRosterCause,
  principal: string = OPENCODE_VAULT_ENROLLMENT_NAME,
): string | undefined {
  return cause === 'unknown'
    ? undefined
    : emptyRosterGuidance(cause, principal).join('\n')
}

/**
 * The vault account pool both OpenCode hosts send requests through. A request
 * that finds no account names the cause the Vault section names, for the
 * enrollment name `grantPrincipal` returns (custody's `grantPrincipal`);
 * without one, or when it returns undefined, the default name.
 */
export function createOpenCodeVaultAccountPool(
  options: Omit<VaultAccountPoolOptions, 'emptyRosterRefusal'> & {
    readonly grantPrincipal?: () => string | undefined
  },
): VaultAccountPool {
  const { grantPrincipal: principal, ...poolOptions } = options
  return createVaultAccountPool({
    ...poolOptions,
    emptyRosterRefusal: (cause) =>
      openCodeEmptyVaultRosterRefusal(cause, principal?.()),
  })
}

/** The next steps for an enrollment state that needs the user or the operator to act. */
function enrollmentGuidance(status: EnrollmentStatus): string[] {
  if (status.state === 'pending')
    return pendingEnrollmentGuidance(status.requestId)
  if (status.state === 'blocked' && status.code === 'pending_exists')
    return pendingExistsGuidance()
  if (status.state === 'denied')
    return [
      'The operator denied this request. Resolve access with the vault operator, then request vault access again.',
    ]
  if (status.state === 'blocked')
    return [
      'Resolve the enrollment problem with the vault operator, then request vault access again.',
    ]
  if (status.state === 'unavailable') {
    if (isUnsupportedEnrollment(status))
      return [
        'This Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first), or keep using your local accounts.',
      ]
    return [
      'Check that the vault is running and its connection file is available, then request vault access again.',
    ]
  }
  if (status.state === 'busy')
    return [
      'Another enrollment operation is running. OpenCode will keep checking its outcome in the background.',
    ]
  return []
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
    case 'not-used':
      return 'not used in vault mode'
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
    ...(status.mode === 'local'
      ? [`OpenCode Google sign-in: ${describeHostSlot(status.hostSlot)}`]
      : []),
    ...enrollmentGuidance(status.enrollment),
  ]
}
