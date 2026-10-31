/**
 * Pi's custody request path. Each physical send takes its bearer and
 * Antigravity project from one fresh vault receipt, so a revoked account or
 * a moved project applies on the next send and a 401 is reported against the
 * exact record version that was served. Nothing is cached or refreshed
 * locally. Each send checks the vault mode file. Account discovery and
 * changes use the vault source's enrollment checks, without reading Pi's
 * saved Google login.
 */

import { existsSync } from 'node:fs'

import {
  type AntigravityVaultAccountSource,
  type CommonAuthClaustrumModule,
  type CommonAuthCommandsModule,
  type CommonAuthPiSlotModule,
  createAntigravityVaultAccountSource,
  type EmptyVaultRosterCause,
  enrollmentAuthority,
  loadCommonAuthClaustrum,
  type VaultGrantReach,
  type VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'
import type {
  ClaustrumEnrollmentConnection,
  ClaustrumScopedClient,
} from '@cortexkit/antigravity-auth-core/common-auth/claustrum'

import {
  getPiAntigravityVaultDir,
  getPiAntigravityVaultModeFile,
  getPiAntigravityVaultRosterFile,
} from './paths.ts'
import type { AntigravityVaultSend } from './stream.ts'
import {
  PI_ANTIGRAVITY_ENROLLMENT_NAME,
  PI_ANTIGRAVITY_VAULT_HOST,
  type PiVaultAccountChoice,
  type PiVaultAccountsPort,
  type PiVaultModeRead,
  type PiVaultModeRecord,
  PiVaultSetup,
  piEmptyVaultRosterRefusal,
  readPiVaultMode,
} from './vault-setup.ts'

/** The shared vault account source operations Pi's request path and setup use. */
export type PiVaultAccountSource = Pick<
  AntigravityVaultAccountSource,
  | 'refresh'
  | 'routes'
  | 'send'
  | 'decline'
  | 'accept'
  | 'grantReach'
  | 'emptyRosterCause'
>

type PiVaultRouteRef = VaultRouteRef

export class PiVaultSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiVaultSendError'
  }
}

export interface PiVaultRequestPathOptions {
  /** Read this host's vault enrollment and account-source choice before each operation; never reuse an earlier request's state. */
  readMode: () => PiVaultModeRead | Promise<PiVaultModeRead>
  /** The shared vault account source, created once on first use. */
  source: () => Promise<PiVaultAccountSource>
  /**
   * The enrollment name a no-account error names in its grant command: the
   * name the operator approved. Without it, the default name.
   */
  grantPrincipal?: () => string | Promise<string>
}

/** Require current vault-mode settings before opening the account source; refuse local or unreadable settings. */
function requireCustody(read: PiVaultModeRead): PiVaultModeRecord {
  if (!read.ok)
    throw new PiVaultSendError(
      `Antigravity vault mode is unclear (${read.reason}). Choose a mode in the Vault section of the Antigravity menu.`,
    )
  if (read.record.mode !== 'custody')
    throw new PiVaultSendError(
      'Antigravity is not served from the vault. Switch in the Vault section of the Antigravity menu.',
    )
  return read.record
}

function selectRoute(
  routes: readonly PiVaultRouteRef[],
  routeId: string | undefined,
  emptyRosterCause: () => EmptyVaultRosterCause,
  principal: string | undefined,
): PiVaultRouteRef {
  if (routeId !== undefined) {
    const selected = routes.find((route) => route.routeId === routeId)
    if (!selected)
      throw new PiVaultSendError(
        'The chosen vault account is no longer available (declined, removed or changed). Choose another in the Vault section of the Antigravity menu.',
      )
    return selected
  }
  const [only, ...rest] = routes
  if (!only)
    throw new PiVaultSendError(
      piEmptyVaultRosterRefusal(emptyRosterCause(), principal) ??
        'The vault serves Pi no Antigravity accounts yet.',
    )
  if (rest.length > 0)
    throw new PiVaultSendError(
      'The vault serves Pi several Antigravity accounts. Choose one in the Vault section of the Antigravity menu.',
    )
  return only
}

/** Custody checks that run before discovery, a roster change or a send. */
async function openCustody(
  options: PiVaultRequestPathOptions,
): Promise<{ record: PiVaultModeRecord; source: PiVaultAccountSource }> {
  const record = requireCustody(await options.readMode())
  const source = await options.source()
  return { record, source }
}

/** The send function the custody stream uses for every model request. */
export function createPiVaultSend(
  options: PiVaultRequestPathOptions,
): AntigravityVaultSend {
  return async (dispatch, signal) => {
    const { record, source } = await openCustody(options)
    signal.throwIfAborted()
    let routes = source.routes()
    if (routes.length === 0) {
      // Load the vault roster before selecting an account for this request.
      await source.refresh()
      signal.throwIfAborted()
      routes = source.routes()
    }
    // Only a request that finds no account names the enrollment; with no
    // route to bind, this await cannot change which account the send uses.
    const principal =
      routes.length === 0 ? await options.grantPrincipal?.() : undefined
    // Capture the route before any further await, so the send is bound to
    // the account the roster named now, not to whatever later sits there.
    // Pi does not ask fleet routing: its stream supplies no reliable request purpose.
    const ref = selectRoute(
      routes,
      record.routeId,
      () => source.emptyRosterCause(),
      principal,
    )
    return source.send(ref, dispatch, { site: 'model', signal })
  }
}

/** Vault accounts for the setup command, with declined ones marked. */
export function createPiVaultAccountsPort(
  options: PiVaultRequestPathOptions,
): PiVaultAccountsPort {
  // Kept from the last listing so decline/accept act on the account the user
  // picked, never on a route id that now names another account.
  let lastRows = new Map<string, PiVaultRouteRef>()
  // Pi's grants as reported by the vault refresh that the last listing ran.
  let lastReach: VaultGrantReach | undefined

  const refFor = (routeId: string): PiVaultRouteRef => {
    const ref = lastRows.get(routeId)
    if (!ref)
      throw new PiVaultSendError(
        'That vault account is no longer listed. Open the Vault section again.',
      )
    return ref
  }

  return {
    list: async () => {
      const { source } = await openCustody(options)
      lastReach = undefined
      const roster = await source.refresh()
      lastReach = source.grantReach()
      const rows = new Map<string, PiVaultRouteRef>()
      const choices: PiVaultAccountChoice[] = []
      for (const row of roster?.rows ?? []) {
        if (!row.accountIdentity) continue
        const ref: PiVaultRouteRef = {
          routeId: row.routeId,
          credentialId: row.credentialId,
          accountIdentity: row.accountIdentity,
          label: row.label,
          ...(row.email !== undefined && { email: row.email }),
        }
        rows.set(row.routeId, ref)
        const declined = (roster?.declined ?? []).some(
          (entry) =>
            entry.credentialId === row.credentialId &&
            (entry.accountIdentity === undefined ||
              entry.accountIdentity === row.accountIdentity),
        )
        choices.push({
          routeId: row.routeId,
          label: row.label,
          ...(row.email !== undefined && { email: row.email }),
          declined,
        })
      }
      lastRows = rows
      return choices
    },
    grantReach: () => lastReach,
    decline: async (routeId) => {
      const { source } = await openCustody(options)
      await source.decline(refFor(routeId))
    },
    accept: async (routeId) => {
      const { source } = await openCustody(options)
      await source.accept(refFor(routeId))
    },
  }
}

// ---------------------------------------------------------------------------
// Production composition
// ---------------------------------------------------------------------------

/**
 * I/O seams of the vault composition. Pi's default entry passes none: the
 * vault client connects through the connection file Claustrum publishes,
 * Pi's auth slot is read from Pi's auth.json, and files live under Pi's
 * vault directory. Tests replace only the client transport and file paths.
 */
export interface PiVaultSeams {
  connect?: () => Promise<ClaustrumScopedClient>
  connectEnrollment?: () => Promise<ClaustrumEnrollmentConnection>
  readHostSlot?: () => unknown
  nativeAuthPath?: string
  nativeStashPath?: string
  loadPiSlot?: () => Promise<CommonAuthPiSlotModule>
  vaultDir?: string
  modeFile?: string
  rosterFile?: string
  loadClaustrum?: () => Promise<CommonAuthClaustrumModule>
  /** Commands library loader for the menu (tests capture the renderer call). */
  loadCommands?: () => Promise<CommonAuthCommandsModule>
}

export interface PiVaultRuntime {
  readMode(): PiVaultModeRead
  readonly requestPath: PiVaultRequestPathOptions
  setup(): Promise<PiVaultSetup>
}

async function claustrumConnectionFile(): Promise<string> {
  const { resolveClaustrumConnectionPath } = await import(
    '@cortexkit/claustrum-client'
  )
  return resolveClaustrumConnectionPath()
}

function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined
      throw error
    })
    return pending
  }
}

/**
 * Build Pi's vault composition. Nothing is loaded or connected here; the
 * vault library and the shared account source are created on the first
 * custody send or setup action.
 */
export function createPiVaultRuntime(
  readHostSlot: () => unknown,
  seams: PiVaultSeams = {},
  onModeChanged?: (record: PiVaultModeRecord) => void | Promise<void>,
): PiVaultRuntime {
  const vaultDir = seams.vaultDir ?? getPiAntigravityVaultDir()
  const modeFile = seams.modeFile ?? getPiAntigravityVaultModeFile()
  const rosterFile = seams.rosterFile ?? getPiAntigravityVaultRosterFile()
  const loadClaustrum = seams.loadClaustrum ?? loadCommonAuthClaustrum
  const readMode = () => readPiVaultMode(modeFile)

  const source = memoize(async (): Promise<PiVaultAccountSource> => {
    const claustrum = await loadClaustrum()
    const { tokenPath } = claustrum.hostEnrollmentPaths({
      stateDir: vaultDir,
      host: PI_ANTIGRAVITY_VAULT_HOST,
    })
    return createAntigravityVaultAccountSource({
      claustrum,
      host: PI_ANTIGRAVITY_VAULT_HOST,
      rosterPath: rosterFile,
      tokenPath,
      connect:
        seams.connect ??
        (async () =>
          claustrum.connectClaustrumScopedClient({
            connectionFile: await claustrumConnectionFile(),
          })),
      // The vault serves this host only once setup has stored an approved
      // enrollment token; Pi's own send path also requires custody mode.
      isCustodyActive: () => existsSync(tokenPath),
      // Pi reads the HTTP status of each send itself.
      reporterSource: 'direct',
    })
  })

  const setup = memoize(async () => {
    const claustrum = await loadClaustrum()
    return new PiVaultSetup({
      claustrum,
      stateDir: vaultDir,
      modeFile,
      readHostSlot,
      ...(onModeChanged && { onModeChanged }),
      connectEnrollment:
        seams.connectEnrollment ??
        (async () =>
          claustrum.connectClaustrumEnrollmentClient({
            connectionFile: await claustrumConnectionFile(),
          })),
    })
  })

  return {
    readMode,
    setup,
    requestPath: {
      readMode: async () => {
        const settings = await setup()
        const status = await settings.sourceStatus()
        const authority = await enrollmentAuthority(
          settings.paths,
          PI_ANTIGRAVITY_ENROLLMENT_NAME,
        )
        if (authority === 'local' && status.mode === 'custody')
          throw new PiVaultSendError(
            'Vault enrollment is not active. No request was sent.',
          )
        if (status.mode === 'unreadable')
          throw new PiVaultSendError(
            'Vault enrollment or source settings cannot be read.',
          )
        return {
          ok: true,
          record: {
            version: 1,
            mode: status.mode,
            ...(status.selectedRouteId
              ? { routeId: status.selectedRouteId }
              : {}),
          },
        }
      },
      source,
      grantPrincipal: async () => (await setup()).grantPrincipal(),
    },
  }
}
