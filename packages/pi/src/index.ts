import {
  authorizeAntigravity,
  exchangeAntigravity,
  getPublicModelDefinitions,
  refreshAntigravityToken,
} from "@cortexkit/antigravity-auth-core"
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { rememberPackedRefresh } from "./credential-cache.ts"
import { streamCortexKitAntigravity } from "./stream.ts"

const ANTIGRAVITY_PROVIDER_ID = "google-antigravity"

function textImageInput(): Array<"text" | "image"> {
  return ["text", "image"]
}

async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const auth = await authorizeAntigravity()
  callbacks.onAuth({ url: auth.url })
  const code = await callbacks.onPrompt({
    message: "Paste the Antigravity OAuth callback URL or code:",
  })

  // The state (PKCE verifier + project) is carried in the authorize URL; reuse
  // it so the code exchange can recover the verifier.
  const authState = new URL(auth.url).searchParams.get("state") ?? ""

  // Accept either a raw code or a full redirect URL with ?code= and &state=.
  let rawCode = code.trim()
  let state = authState
  try {
    const url = new URL(rawCode)
    const codeParam = url.searchParams.get("code")
    const stateParam = url.searchParams.get("state")
    if (codeParam) rawCode = codeParam
    if (stateParam) state = stateParam
  } catch {
    // Not a URL — treat the input as a bare authorization code.
  }

  const result = await exchangeAntigravity(rawCode, state)
  if (result.type !== "success") {
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
  // Stored refresh is `refreshToken|projectId|managedProjectId`.
  const refreshToken = credentials.refresh.split("|")[0] ?? credentials.refresh
  const refreshed = await refreshAntigravityToken(refreshToken)
  // Preserve the project segments packed into the stored refresh string.
  const projectSegments = credentials.refresh.includes("|")
    ? credentials.refresh.slice(credentials.refresh.indexOf("|"))
    : ""
  return {
    refresh: `${refreshed.refresh}${projectSegments}`,
    access: refreshed.access,
    expires: refreshed.expires,
  }
}

export default function cortexKitPiAntigravityAuth(pi: ExtensionAPI): void {
  const models = Object.values(getPublicModelDefinitions())
    // Pi's AssistantMessage protocol has no image-output content type. Keep
    // generation-only image routes out of the chat model catalog rather than
    // advertising output that the stream contract cannot represent.
    .filter((model) => !model.modalities.output.includes("image"))
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
    name: "Google Antigravity (CortexKit OAuth)",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    api: "google-generative-ai",
    models,
    oauth: {
      name: "Google Antigravity (CortexKit)",
      login: loginAntigravity,
      refreshToken: refreshAntigravityCredentials,
      getApiKey: (credentials) => {
        // Bridge the packed refresh (refreshToken|projectId|managedProjectId)
        // to the stream, which otherwise only receives the bare access token.
        rememberPackedRefresh(credentials.access, credentials.refresh)
        return credentials.access
      },
    },
    streamSimple: streamCortexKitAntigravity,
  })
}
