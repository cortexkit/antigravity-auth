import {
  AccountIdentityAmbiguityError,
  authorizeAntigravity,
  exchangeAntigravity,
  getPublicModelDefinitions,
} from '@cortexkit/antigravity-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import {
  type ExtensionAPI,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import { registerAccountCommands } from './commands.ts'
import { rememberPackedRefresh } from './credential-cache.ts'
import { PiAccountRuntime } from './runtime.ts'
import { streamCortexKitAntigravity } from './stream.ts'

const ANTIGRAVITY_PROVIDER_ID = 'google-antigravity'

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
  runtime: PiAccountRuntime,
): Promise<OAuthCredentials> {
  const auth = await authorizeAntigravity()
  callbacks.signal?.throwIfAborted()
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
    if (stateParam && stateParam !== authState)
      throw new Error('OAuth state mismatch')
    if (stateParam) state = stateParam
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    // Not a URL — treat the input as a bare authorization code.
  }

  callbacks.signal?.throwIfAborted()
  const result = await exchangeAntigravity(rawCode, state)
  if (result.type !== 'success') {
    throw new Error(`Antigravity OAuth exchange failed: ${result.error}`)
  }

  callbacks.signal?.throwIfAborted()
  await runtime.login(result)

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    email: result.email,
    accountId: result.accountId,
  }
}

export default function cortexKitPiAntigravityAuth(pi: ExtensionAPI): void {
  const runtime = new PiAccountRuntime()
  registerAccountCommands(pi, runtime, (callbacks) =>
    loginAntigravity(callbacks, runtime),
  )
  pi.on('session_start', async (_event, context) => {
    try {
      const auth = readStoredCredential(ANTIGRAVITY_PROVIDER_ID)
      if (auth?.type === 'oauth') {
        await runtime.migrate(auth)
      }
    } catch (error) {
      context.ui.notify(
        error instanceof AccountIdentityAmbiguityError
          ? 'Antigravity account migration found ambiguous token-only identity; no accounts were merged. Re-authenticate or repair the account file before retrying.'
          : 'Antigravity account migration failed; existing auth and pool were retained. Repair the account file before retrying.',
        'error',
      )
    }
  })
  pi.on('session_shutdown', async () => runtime.dispose())
  const models = Object.values(getPublicModelDefinitions())
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

  pi.registerProvider(ANTIGRAVITY_PROVIDER_ID, {
    name: 'Google Antigravity (CortexKit OAuth)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    api: 'google-generative-ai',
    models,
    oauth: {
      name: 'Google Antigravity (CortexKit)',
      login: (callbacks) => loginAntigravity(callbacks, runtime),
      refreshToken: (credentials, signal) =>
        runtime.refreshHost(credentials, signal),
      getApiKey: (credentials) => {
        // Bridge the packed refresh (refreshToken|projectId|managedProjectId)
        // to the stream, which otherwise only receives the bare access token.
        rememberPackedRefresh(credentials.access, credentials.refresh)
        runtime.remember(credentials)
        return credentials.access
      },
    },
    streamSimple: (model, context, options) =>
      streamCortexKitAntigravity(model, context, options, runtime),
  })
}
