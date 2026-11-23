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
import { createLogger } from './logger'
import { requestHelperLog } from './request-helper-effects'
import { VAULT_ROUTING_PURPOSE_HEADER } from './shared/vault-routing-purpose'
import { defaultSignatureStore } from './stores/signature-store'

const log = createLogger('request')
const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`
const DEFAULT_AGY_REQUEST_SESSION = createAgyRequestSessionContext()

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
  stripAdapterHeaders(headers: Headers) {
    headers.delete('x-session-affinity')
    headers.delete('x-session-id')
    headers.delete('x-parent-session-id')
    headers.delete('x-opencode-session-id')
    headers.delete('x-opencode-parent-session-id')
    headers.delete(VAULT_ROUTING_PURPOSE_HEADER)
  },
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
  getLastCacheStats,
} = openCode1Wire

/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID
}

export const __testExports = requestWireTestHelpers(openCode1WireLocation)
