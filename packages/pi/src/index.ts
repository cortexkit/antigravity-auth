import { join } from 'node:path'
import {
  ANTIGRAVITY_PROVIDER_ID,
  authorizeAntigravity,
  enrollmentAuthority,
  exchangeAntigravity,
  getPublicModelDefinitions,
  loadCommonAuthPiSlot,
  refreshAntigravityToken,
} from '@cortexkit/antigravity-auth-core'
import type { PluginExtraSection } from '@cortexkit/antigravity-auth-core/common-auth/commands'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import {
  type ExtensionAPI,
  getAgentDir,
  type ProviderConfig,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'

import {
  createPiAntigravityAccountSections,
  type PiAntigravityAccountSections,
  registerPiAntigravityCommand,
} from './commands.ts'
import { rememberPackedRefresh } from './credential-cache.ts'
import { getPiAntigravityVaultDir } from './paths.ts'
import {
  createCortexKitAntigravityVaultStream,
  streamCortexKitAntigravity,
} from './stream.ts'
import {
  createPiVaultSection,
  PI_ANTIGRAVITY_ENROLLMENT_NAME,
  type PiVaultModeRead,
  type PiVaultModeRecord,
  PiVaultSetupError,
} from './vault-setup.ts'
import {
  createPiVaultAccountsPort,
  createPiVaultRuntime,
  createPiVaultSend,
  type PiVaultSeams,
} from './vault-source.ts'

/** Refresh value of the vault placeholder login; local mode must never refresh it. */
export const CUSTODY_PLACEHOLDER_REFRESH_PREFIX = 'claustrum-tombstone:v1:'

/** Non-secret key that lets Pi list custody models without a login; never sent. */
export const CUSTODY_PROVIDER_KEY_MARKER = 'antigravity-vault-custody'

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const auth = await authorizeAntigravity()
  callbacks.onAuth({ url: auth.url })
  const code = await callbacks.onPrompt({
    message: 'Paste the Antigravity OAuth callback URL or code:',
  })

  // The state (PKCE verifier + project) is carried in the authorize URL; reuse
  // it so the code exchange can recover the verifier.
  const authState = new URL(auth.url).searchParams.get('state') ?? ''

  // Accept either a raw code or a full redirect URL with ?code= and &state=.
  let rawCode = code.trim()
  let state = authState
  try {
    const url = new URL(rawCode)
    const codeParam = url.searchParams.get('code')
    const stateParam = url.searchParams.get('state')
    if (codeParam) rawCode = codeParam
    if (stateParam) state = stateParam
  } catch {
    // Not a URL — treat the input as a bare authorization code.
  }

  const result = await exchangeAntigravity(rawCode, state)
  if (result.type !== 'success') {
    throw new Error(`Antigravity OAuth exchange failed: ${result.error}`)
  }

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  }
}

async function refreshAntigravityCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  // Local mode refreshes Pi's own login only. The vault placeholder is not a
  // login: refreshing it would send it to Google as a refresh token.
  if (credentials.refresh.startsWith(CUSTODY_PLACEHOLDER_REFRESH_PREFIX))
    throw new Error(
      'Pi holds the Antigravity vault placeholder, not a login. Run /login, or serve Antigravity from the vault.',
    )
  // Stored refresh is `refreshToken|projectId|managedProjectId`.
  const refreshToken = credentials.refresh.split('|')[0] ?? credentials.refresh
  const refreshed = await refreshAntigravityToken(refreshToken)
  // Preserve the project segments packed into the stored refresh string.
  const projectSegments = credentials.refresh.includes('|')
    ? credentials.refresh.slice(credentials.refresh.indexOf('|'))
    : ''
  return {
    refresh: `${refreshed.refresh}${projectSegments}`,
    access: refreshed.access,
    expires: refreshed.expires,
  }
}

function publicModels(): NonNullable<ProviderConfig['models']> {
  return (
    Object.values(getPublicModelDefinitions())
      // Pi's AssistantMessage protocol has no image-output content type. Keep
      // generation-only image routes out of the chat model catalog rather than
      // advertising output that the stream contract cannot represent.
      .filter((model) => !model.modalities.output.includes('image'))
      .map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: textImageInput(),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.limit.context,
        maxTokens: model.limit.output,
      }))
  )
}

function localProviderConfig(
  models: NonNullable<ProviderConfig['models']>,
  assertLocalAdmission: () => Promise<void>,
): ProviderConfig {
  return {
    name: 'Google Antigravity (CortexKit OAuth)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    api: 'google-generative-ai',
    models,
    oauth: {
      name: 'Google Antigravity (CortexKit)',
      login: async (callbacks) => {
        await assertLocalAdmission()
        return loginAntigravity(callbacks)
      },
      refreshToken: async (credentials) => {
        await assertLocalAdmission()
        return refreshAntigravityCredentials(credentials)
      },
      getApiKey: (credentials) => {
        // Bridge the packed refresh (refreshToken|projectId|managedProjectId)
        // to the stream, which otherwise only receives the bare access token.
        rememberPackedRefresh(credentials.access, credentials.refresh)
        return credentials.access
      },
    },
    streamSimple: (model, context, options) =>
      streamCortexKitAntigravity(model, context, options, assertLocalAdmission),
  }
}

/** Custody (or unreadable mode): no OAuth, so Pi never refreshes locally. */
function custodyProviderConfig(
  models: NonNullable<ProviderConfig['models']>,
  send: ReturnType<typeof createPiVaultSend>,
): ProviderConfig {
  return {
    name: 'Google Antigravity (CortexKit vault)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    api: 'google-generative-ai',
    models,
    apiKey: CUSTODY_PROVIDER_KEY_MARKER,
    streamSimple: createCortexKitAntigravityVaultStream(
      send,
      CUSTODY_PROVIDER_KEY_MARKER,
    ),
  }
}

/**
 * Registered while the native credential slot cannot be synchronized with the
 * chosen mode. It keeps the same provider id and models, so Pi neither falls
 * back to its built-in Google catalog nor lists a second provider. It has no
 * OAuth, so Pi never refreshes or rewrites the native login, and every request
 * fails with the reason before anything is sent.
 */
function refusingProviderConfig(
  models: NonNullable<ProviderConfig['models']>,
  reason: string,
): ProviderConfig {
  return {
    name: 'Google Antigravity (CortexKit, unavailable)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    api: 'google-generative-ai',
    models,
    apiKey: CUSTODY_PROVIDER_KEY_MARKER,
    streamSimple: createCortexKitAntigravityVaultStream(async () => {
      throw new PiVaultSetupError(
        `${reason} Resolve it from /antigravity; Antigravity requests are refused until then. No request was sent.`,
      )
    }, CUSTODY_PROVIDER_KEY_MARKER),
  }
}

/**
 * The vault runtime Pi composes custody from: the public `./claustrum` entry
 * of `@cortexkit/common-auth`, the setup-only enrollment connection, and the
 * shared Antigravity vault account source for the `pi` host.
 */
export interface PiAntigravityExtension {
  /**
   * The Vault section for the shared command menu, where enrollment, mode
   * switching and account choice happen.
   */
  readonly vaultSection: PluginExtraSection
  /** Pi's own Accounts, Quota, Routing and Limits sections for the same menu. */
  readonly accountSections: PiAntigravityAccountSections
}

/**
 * Register the Antigravity provider for the mode the user chose: Pi's own
 * login (local, the default) or the vault (custody). Changing the mode in
 * the Vault section re-registers the same provider id, so Pi never lists two.
 * `seams` replaces only I/O (vault client transport, file paths, auth slot)
 * for tests; Pi's default entry passes none.
 */
export async function registerCortexKitPiAntigravity(
  pi: Pick<ExtensionAPI, 'registerProvider' | 'registerCommand'> &
    Partial<Pick<ExtensionAPI, 'on'>>,
  seams: PiVaultSeams = {},
): Promise<PiAntigravityExtension> {
  const models = publicModels()
  const readHostSlot =
    seams.readHostSlot ?? (() => readStoredCredential(ANTIGRAVITY_PROVIDER_ID))
  let refreshRegistry: (() => void) | undefined
  const vault = createPiVaultRuntime(readHostSlot, seams, async () => {
    try {
      await synchronizeSlot()
    } finally {
      refreshRegistry?.()
    }
  })
  const send = createPiVaultSend(vault.requestPath)

  const register = (mode: PiVaultModeRead) => {
    const local = mode.ok && mode.record.mode === 'local'
    pi.registerProvider(
      ANTIGRAVITY_PROVIDER_ID,
      local
        ? localProviderConfig(models, assertLocalAdmission)
        : custodyProviderConfig(models, send),
    )
  }
  const currentMode = async (): Promise<PiVaultModeRecord> => {
    const setup = await vault.setup()
    const status = await setup.sourceStatus()
    const authority = await enrollmentAuthority(
      setup.paths,
      PI_ANTIGRAVITY_ENROLLMENT_NAME,
    )
    if (authority === 'unreadable' || status.mode === 'unreadable') {
      throw new PiVaultSetupError(
        'Vault enrollment or source settings cannot be read. Local credentials remain unavailable.',
      )
    }
    if (authority === 'vault')
      return {
        version: 1,
        mode: 'custody',
        ...(status.selectedRouteId ? { routeId: status.selectedRouteId } : {}),
      }
    if (status.mode !== 'local')
      throw new PiVaultSetupError(
        'Vault enrollment must be approved before activating vault credentials.',
      )
    return { version: 1, mode: 'local' }
  }
  const assertLocalAdmission = async () => {
    if ((await currentMode()).mode !== 'local')
      throw new PiVaultSetupError(
        'Vault enrollment excludes local login, refresh and request execution.',
      )
  }
  const synchronizeSlotOnce = async () => {
    try {
      await swapSlotForMode()
    } catch (error) {
      // Leave the provider registered but refusing, so a failed swap neither
      // serves from the wrong credential nor unregisters the models.
      pi.registerProvider(
        ANTIGRAVITY_PROVIDER_ID,
        refusingProviderConfig(
          models,
          error instanceof Error ? error.message : String(error),
        ),
      )
      throw error
    }
  }
  // Startup, session_start and every mode change synchronize the slot. Run them
  // one at a time: each reads the mode when it starts, so the run that
  // registers last is the one that read the newest mode.
  let synchronizing: Promise<void> = Promise.resolve()
  const synchronizeSlot = (): Promise<void> => {
    const run = synchronizing.then(synchronizeSlotOnce)
    synchronizing = run.catch(() => {})
    return run
  }
  const swapSlotForMode = async () => {
    const mode = await currentMode()
    const { openPiSlot } = await (seams.loadPiSlot ?? loadCommonAuthPiSlot)()
    const slot = openPiSlot({
      authPath: seams.nativeAuthPath ?? join(getAgentDir(), 'auth.json'),
      stashPath:
        seams.nativeStashPath ??
        join(
          seams.vaultDir ?? getPiAntigravityVaultDir(),
          'google-login-stash.json',
        ),
      provider: ANTIGRAVITY_PROVIDER_ID,
      placeholderKey: CUSTODY_PROVIDER_KEY_MARKER,
    })
    if (mode.mode === 'custody') await slot.enterVault()
    else if ((await slot.exitVault()) === 'conflict')
      throw new PiVaultSetupError(
        'The native Google login changed. It was not overwritten; restore the saved login after resolving the conflict.',
      )
    const after = await currentMode()
    if (after.mode !== mode.mode)
      throw new PiVaultSetupError(
        'Vault enrollment changed while the credential slot was being synchronized. The account source was not activated.',
      )
    register({ ok: true, record: after })
  }
  // Pi's first catalog refresh reads auth.json to decide which models are usable.
  // Install the vault marker before the factory returns so discovery and the
  // first request cannot refresh the dormant Google login. A failed swap has
  // registered the refusing provider; the factory still resolves so the
  // /antigravity menu below, which holds the remedies, stays registered.
  await synchronizeSlot().catch(() => {})
  pi.on?.('session_start', async (_event, context) => {
    refreshRegistry = () => context.modelRegistry.refresh()
    try {
      await synchronizeSlot()
    } finally {
      refreshRegistry()
    }
  })

  const accounts = createPiVaultAccountsPort(vault.requestPath)
  const extension: PiAntigravityExtension = {
    accountSections: createPiAntigravityAccountSections({
      setup: vault.setup,
      accounts: () => accounts,
    }),
    vaultSection: createPiVaultSection({
      setup: vault.setup,
      accounts: () => accounts,
    }),
  }
  registerPiAntigravityCommand(pi, {
    sections: extension.accountSections,
    extras: [extension.vaultSection],
    ...(seams.loadCommands && { loadCommands: seams.loadCommands }),
  })
  return extension
}

export default async function cortexKitPiAntigravityAuth(
  pi: ExtensionAPI,
): Promise<void> {
  await registerCortexKitPiAntigravity(pi)
}
