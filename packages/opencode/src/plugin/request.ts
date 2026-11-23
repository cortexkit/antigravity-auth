import crypto from 'node:crypto'
import { createAgyRequestSessionContext } from '@cortexkit/antigravity-auth-core'
import {
  createRequestWire as bindRequestWire,
  createDisplayedThinkingRegistry,
  type RequestWireLocation,
  requestWireTestHelpers,
} from '@cortexkit/antigravity-auth-core/engine'
import { cacheSignature, getCachedSignature } from './cache'
import { getKeepThinking } from './config'
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugTuiEnabled,
  logAntigravityDebugResponse,
  logCacheStats,
} from './debug'
import { getSessionFingerprint } from './fingerprint'
import {
  appendGeminiDumpResponseText,
  createGeminiDumpResponseTransform,
  noteGeminiDumpResponse,
} from './gemini-dump'
import { processImageData } from './image-saver'
import { createLogger } from './logger'
import { requestHelperLog } from './request-helper-effects'
import { VAULT_ROUTING_PURPOSE_HEADER } from './shared/vault-routing-purpose'
import { defaultSignatureStore } from './stores/signature-store'

const log = createLogger('request')
const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`
const DEFAULT_AGY_REQUEST_SESSION = createAgyRequestSessionContext()

const OPENCODE_TITLE_PROMPT_PREFIX = 'Generate a title for this conversation:'

function getOpenCodeTitleSourceText(
  payload: Record<string, unknown>,
): string | undefined {
  if (!Array.isArray(payload.contents)) {
    return undefined
  }

  const texts = payload.contents.flatMap((content) => {
    if (!content || typeof content !== 'object') {
      return []
    }
    const parts = (content as Record<string, unknown>).parts
    if (!Array.isArray(parts)) {
      return []
    }
    return parts.flatMap((part) =>
      part &&
      typeof part === 'object' &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : [],
    )
  })

  const promptIndex = texts.findIndex((text) =>
    text.startsWith(OPENCODE_TITLE_PROMPT_PREFIX),
  )
  return promptIndex >= 0
    ? texts.slice(promptIndex + 1).find((text) => text.trim().length > 0)
    : undefined
}

const wireEffects = {
  pluginSessionId: PLUGIN_SESSION_ID,
  defaultSession: DEFAULT_AGY_REQUEST_SESSION,
  debugMessagePrefix: DEBUG_MESSAGE_PREFIX,
  helperLog: requestHelperLog,
  dump: {
    noteResponse: noteGeminiDumpResponse,
    appendResponseText: appendGeminiDumpResponseText,
    createResponseTransform: createGeminiDumpResponseTransform,
  },
  processImageData,
  stripAdapterHeaders(headers: Headers) {
    headers.delete('x-session-affinity')
    headers.delete('x-session-id')
    headers.delete('x-parent-session-id')
    headers.delete('x-opencode-session-id')
    headers.delete('x-opencode-parent-session-id')
    headers.delete(VAULT_ROUTING_PURPOSE_HEADER)
  },
  titleSourceText: getOpenCodeTitleSourceText,
}

export function createRequestWire(location: RequestWireLocation) {
  return bindRequestWire(location, wireEffects)
}

// OpenCode 1's single-location binding: every read goes to the module-level
// config, signature cache, debug log and fingerprint at call time.
const openCode1WireLocation: RequestWireLocation = {
  signatures: {
    get keepThinking() {
      return getKeepThinking()
    },
    signatureStore: defaultSignatureStore,
    cacheSignature: (sessionId, text, signature) =>
      cacheSignature(sessionId, text, signature),
    getCachedSignature: (sessionId, text) =>
      getCachedSignature(sessionId, text),
  },
  debug: {
    isDebugTuiEnabled: () => isDebugTuiEnabled(),
    logAntigravityDebugResponse: (context, response, meta) =>
      logAntigravityDebugResponse(context, response, meta),
    logCacheStats: (model, cacheRead, cacheWrite, totalInput) =>
      logCacheStats(model, cacheRead, cacheWrite, totalInput),
  },
  logger: log,
  sessionFingerprint: () => getSessionFingerprint(),
  displayedThinking: createDisplayedThinkingRegistry(),
  cacheStats: { last: null },
}

const openCode1Wire = createRequestWire(openCode1WireLocation)
export const {
  prepare: prepareAntigravityRequest,
  transformResponse: transformAntigravityResponse,
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
} = openCode1Wire

/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID
}

export const __testExports = requestWireTestHelpers(openCode1WireLocation)
