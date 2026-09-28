// OpenCode V2 Antigravity provider (port of cortexkit/antigravity-auth).
//
// The native `@opencode-ai/ai/providers/google` package builds and parses Gemini
// traffic, so images/PDF/tool-calls need no custom codec. A `http.request` hook
// redirects each Antigravity model request to a loopback server owned by this
// plugin; the server performs the real call through
// `@cortexkit/antigravity-auth-core` (raw HTTP/1.1 transport matching the
// Antigravity CLI, proxy aware), rotating over the multi-account pool in
// `~/.config/opencode/antigravity-accounts.json`, and streams the unwrapped SSE
// back to OpenCode.

import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AccountManager,
  AgyRequestSessionStore,
  applyClaudeTransforms,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  authorizeAntigravity,
  buildAgyAgentRequestMetadata,
  buildImageGenerationConfig,
  buildAntigravityHarnessUserAgent,
  defaultAccountStorageStore,
  ensureProjectContext,
  exchangeAntigravity,
  fetchWithAgyCliTransport,
  formatRefreshParts,
  getModelFamily,
  isImageGenerationModel,
  loadAccountStorage,
  mutateAccountStorage,
  normalizeGeminiTools,
  orderAgyRequestPayloadInPlace,
  parseRateLimitReason,
  parseRefreshParts,
  refreshAntigravityToken,
  resolveModelForHeaderStyle,
  sanitizeCrossModelPayloadInPlace,
  SKIP_THOUGHT_SIGNATURE,
  toGeminiSchema,
  type AccountStorageV4,
  type AgyRequestScope,
  type AntigravityTokenExchangeResult,
  type ManagedAccount,
  type OAuthAuthDetails,
} from '@cortexkit/antigravity-auth-core'
import type {
  Credential,
  Integration,
  Plugin as OpenCodePlugin,
} from '@opencode-ai/plugin'
import type { Registration } from '@opencode-ai/plugin/promise/registration'
import type { SessionRequestKind } from '@opencode-ai/plugin/promise/session'

import { waitForAntigravityCode } from './oauth-callback.ts'

type ResolvedModel = ReturnType<typeof resolveModelForHeaderStyle>
interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: unknown
  functionResponse?: unknown
  [key: string]: unknown
}

interface GeminiContent {
  role?: string
  parts?: GeminiPart[]
  [key: string]: unknown
}

interface GeminiCandidate {
  index?: number
  content?: GeminiContent
  finishReason?: string
  thought?: unknown
  [key: string]: unknown
}

interface GeminiPayload {
  contents?: GeminiContent[]
  tools?: unknown[]
  toolConfig?: Record<string, unknown>
  candidates?: GeminiCandidate[]
  usageMetadata?: unknown
  promptFeedback?: unknown
  generationConfig?: Record<string, unknown>
  providerOptions?: unknown
  safetySettings?: unknown[]
  systemInstruction?: GeminiContent
  model?: unknown
  project?: unknown
  user_prompt_id?: unknown
  session_id?: unknown
  labels?: unknown
  sessionId?: unknown
  [key: string]: unknown
}

interface AntigravityEnvelope {
  project: string
  requestId: string
  request: GeminiPayload
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
}

interface PendingJob {
  payload: GeminiPayload
  resolved: ResolvedModel
  modelID: string
  variant?: string
  sessionID: string
  kind: SessionRequestKind
  stream: boolean
}

interface SendInput {
  envelope: AntigravityEnvelope
  auth: OAuthAuthDetails
  endpoint: string
  signal?: AbortSignal
  kind: SessionRequestKind
}

interface OpenCodeV2Dependencies {
  authorizeAntigravity: typeof authorizeAntigravity
  ensureProjectContext: typeof ensureProjectContext
  exchangeAntigravity: typeof exchangeAntigravity
  mutateAccountStorage: typeof mutateAccountStorage
  refreshAntigravityToken: typeof refreshAntigravityToken
  waitForAntigravityCode: typeof waitForAntigravityCode
  send?: (input: SendInput) => Promise<Response>
}

export type OpenCodeV2DependencyOverrides = Partial<OpenCodeV2Dependencies>

type OAuthSuccess = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

export function upsertOAuthAccount(
  current: AccountStorageV4,
  result: OAuthSuccess,
  now: number,
): AccountStorageV4 {
  const refreshParts = parseRefreshParts(result.refresh)
  if (!refreshParts.refreshToken) {
    throw new Error('Antigravity token exchange returned no refresh token')
  }
  const existingIndex = current.accounts.findIndex((account) =>
    result.email
      ? account.email === result.email
      : account.refreshToken === refreshParts.refreshToken,
  )
  const existing =
    existingIndex >= 0 ? current.accounts[existingIndex] : undefined
  const account = {
    ...existing,
    email: result.email ?? existing?.email,
    label: result.label ?? existing?.label,
    refreshToken: refreshParts.refreshToken,
    projectId:
      refreshParts.projectId || result.projectId || existing?.projectId,
    managedProjectId:
      refreshParts.managedProjectId ?? existing?.managedProjectId,
    addedAt: existing?.addedAt ?? now,
    lastUsed: now,
    enabled: true,
    accountIneligible: false,
    accountIneligibleAt: undefined,
    accountIneligibleReason: undefined,
    verificationRequired: false,
    verificationRequiredAt: undefined,
    verificationRequiredReason: undefined,
    eligibilityStateUpdatedAt: now,
  }
  const accounts = [...current.accounts]
  if (existingIndex >= 0) accounts[existingIndex] = account
  else accounts.push(account)
  return { ...current, version: 4, accounts }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configDir(): string {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    const appdata = join(process.env.APPDATA.trim(), 'opencode')
    if (existsSync(join(appdata, 'antigravity-accounts.json'))) return appdata
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim()
  return xdg
    ? join(xdg, 'opencode')
    : join(homedir(), '.local', 'state', 'opencode')
}

const ACCOUNTS_FILE =
  process.env.ANTIGRAVITY_ACCOUNTS_FILE?.trim() ||
  join(configDir(), 'antigravity-accounts.json')
const LOGFILE = join(stateDir(), 'antigravity-v2.log')
const INTEGRATION_ID = 'google' as Integration.ID
const METHOD_ID = 'antigravity-v2' as Integration.MethodID
function log(...args: unknown[]): void {
  try {
    const directory = dirname(LOGFILE)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    appendFileSync(
      LOGFILE,
      `[${new Date().toISOString()}] ` +
        args
          .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          .join(' ') +
        '\n',
      { mode: 0o600 },
    )
    chmodSync(LOGFILE, 0o600)
  } catch {
    return
  }
}

const MODEL_IDS = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
])

function familyFor(modelID: string): 'claude' | 'gemini' {
  return getModelFamily(modelID) === 'claude' ? 'claude' : 'gemini'
}

function requestedModel(modelID: string, variant?: string): string {
  if (!variant || variant === 'default') return modelID
  return `${modelID}-${variant}`
}

function unwrapFrame(parsed: unknown): GeminiPayload {
  if (isRecord(parsed) && isRecord(parsed.response)) {
    return parsed.response as GeminiPayload
  }
  return isRecord(parsed) ? (parsed as GeminiPayload) : {}
}

// Antigravity's GPT/Claude bridges occasionally emit parts and roles the strict
// native Gemini event schema rejects (e.g. role "assistant", or a part carrying
// only a thought signature). Normalise every frame to the Gemini shape.
function sanitizeInner(inner: GeminiPayload): GeminiPayload {
  const candidates = inner?.candidates
  if (!Array.isArray(candidates)) return inner
  for (const candidate of candidates) {
    const content = candidate?.content
    if (!content || typeof content !== 'object') continue
    if (content.role !== 'user' && content.role !== 'model')
      content.role = 'model'
    // `parts` is required by the native schema; GPT-OSS opens a turn without it.
    if (!Array.isArray(content.parts)) {
      content.parts = []
      continue
    }
    content.parts = content.parts
      .map((part) => {
        if (!part || typeof part !== 'object') return null
        const out: GeminiPart = {}
        if (typeof part.text === 'string') out.text = part.text
        if (part.thought !== undefined) out.thought = Boolean(part.thought)
        if (typeof part.thoughtSignature === 'string')
          out.thoughtSignature = part.thoughtSignature
        if (part.inlineData) out.inlineData = part.inlineData
        if (part.functionCall) out.functionCall = part.functionCall
        if (part.functionResponse) out.functionResponse = part.functionResponse
        if (
          out.text === undefined &&
          !out.inlineData &&
          !out.functionCall &&
          !out.functionResponse
        ) {
          out.text = ''
        }
        return out
      })
      .filter((part) => part !== null)
  }
  return inner
}

const IMAGE_DIR = join(homedir(), '.opencode', 'generated-images')
const IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// The native Gemini event parser only renders text and tool calls, so generated
// images are written to disk and announced as text instead of being dropped.
async function persistInlineImages(
  inner: GeminiPayload,
): Promise<GeminiPayload> {
  const parts = inner?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return inner
  for (let index = 0; index < parts.length; index += 1) {
    const inline = parts[index]?.inlineData
    if (!inline?.data || !String(inline.mimeType ?? '').startsWith('image/'))
      continue
    try {
      const { chmod, mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(IMAGE_DIR, { recursive: true, mode: 0o700 })
      await chmod(IMAGE_DIR, 0o700)
      const mimeType = inline.mimeType ?? 'image/png'
      const extension = IMAGE_EXTENSION[mimeType] ?? 'png'
      const file = join(
        IMAGE_DIR,
        `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`,
      )
      await writeFile(file, Buffer.from(inline.data, 'base64'), {
        mode: 0o600,
      })
      await chmod(file, 0o600)
      parts[index] = { text: `[Antigravity image saved: ${file}]` }
      log('image-saved', file, inline.mimeType)
    } catch (error) {
      log('image-save-error', errorMessage(error))
      parts[index] = {
        text: '[Antigravity returned an image that could not be saved]',
      }
    }
  }
  return inner
}
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) && date - Date.now() > 0
    ? date - Date.now()
    : undefined
}

async function readErrorDetails(
  response: Response,
): Promise<{ reason?: string; message: string }> {
  const body = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) return { message: body.slice(0, 300) }
    const error = isRecord(parsed.error) ? parsed.error : undefined
    const details = Array.isArray(error?.details)
      ? error.details
      : Array.isArray(parsed.details)
        ? parsed.details
        : []
    const reason = details
      .map((item) => (isRecord(item) ? item.reason : undefined))
      .find((value): value is string => typeof value === 'string')
    const resolvedReason =
      reason ?? (typeof error?.status === 'string' ? error.status : undefined)
    return {
      ...(resolvedReason ? { reason: resolvedReason } : {}),
      message:
        typeof error?.message === 'string'
          ? error.message.slice(0, 300)
          : body.slice(0, 300),
    }
  } catch {
    return { message: body.slice(0, 300) }
  }
}

function configureToolCalling(request: GeminiPayload): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    delete request.toolConfig
    return
  }
  const toolConfig =
    request.toolConfig &&
    typeof request.toolConfig === 'object' &&
    !Array.isArray(request.toolConfig)
      ? request.toolConfig
      : {}
  const functionCallingConfig: Record<string, unknown> = isRecord(
    toolConfig.functionCallingConfig,
  )
    ? toolConfig.functionCallingConfig
    : {}
  functionCallingConfig.mode = 'VALIDATED'
  toolConfig.functionCallingConfig = functionCallingConfig
  request.toolConfig = toolConfig
}

function normalizeFunctionResponseRoles(request: GeminiPayload): void {
  for (const content of request.contents ?? []) {
    const parts = content.parts ?? []
    if (
      parts.length > 0 &&
      parts.every((part) => part.functionResponse !== undefined)
    ) {
      content.role = 'model'
    }
  }
}

function ensureFunctionCallSignatures(request: GeminiPayload): void {
  for (const content of request.contents ?? []) {
    let foundFunctionCall = false
    for (const part of content.parts ?? []) {
      if (!part.functionCall) continue
      const signature = part.thoughtSignature
      if (!foundFunctionCall) {
        foundFunctionCall = true
        part.thoughtSignature =
          typeof signature === 'string' && signature.length >= 50
            ? signature
            : SKIP_THOUGHT_SIGNATURE
        continue
      }
      delete part.thoughtSignature
      delete part.thought_signature
    }
  }
}

function ensureTrailingUserTurn(request: GeminiPayload): void {
  if (!Array.isArray(request.contents) || request.contents.length === 0) return
  const last = request.contents.at(-1)
  if (last?.role !== 'model' && last?.role !== 'assistant') return
  request.contents.push({ role: 'user', parts: [{ text: '[Continue]' }] })
}

export function buildEnvelope(
  payload: GeminiPayload,
  resolved: ResolvedModel,
  projectID: string,
  scope: AgyRequestScope,
  options: { preserveFunctionCallSignatures?: boolean } = {},
): AntigravityEnvelope {
  const request = structuredClone(payload)
  // OpenCode 2.0 emits snake_case declarations; the shared transforms consume
  // camelCase. Normalize before cleaning schemas for Gemini and Claude.
  for (const tool of request.tools ?? []) {
    if (!isRecord(tool)) continue
    if (Array.isArray(tool.function_declarations)) {
      tool.functionDeclarations ??= tool.function_declarations
      delete tool.function_declarations
    }
    if (!Array.isArray(tool.functionDeclarations)) continue
    for (const declaration of tool.functionDeclarations) {
      if (!isRecord(declaration)) continue
      if (declaration.parameters_json_schema !== undefined) {
        declaration.parametersJsonSchema ??= declaration.parameters_json_schema
        delete declaration.parameters_json_schema
      }
    }
  }
  const replaySignatures = options.preserveFunctionCallSignatures
    ? (request.contents ?? []).flatMap((content) =>
        (content.parts ?? []).flatMap((part) =>
          part.functionCall
            ? [
                typeof part.thoughtSignature === 'string'
                  ? part.thoughtSignature
                  : undefined,
              ]
            : [],
        ),
      )
    : []
  delete request.model
  delete request.project
  delete request.providerOptions
  delete request.user_prompt_id
  delete request.session_id

  const generationConfig = { ...(request.generationConfig ?? {}) }
  delete generationConfig.thinkingConfig
  if (resolved.thinkingLevel) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: resolved.thinkingLevel,
    }
  } else if (resolved.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: resolved.thinkingBudget,
    }
  }
  if (Object.keys(generationConfig).length > 0)
    request.generationConfig = generationConfig
  else delete request.generationConfig

  // AGY rejects some numeric JSON Schema keywords (e.g. exclusiveMinimum),
  // and its GPT bridge encodes others as strings. Preserve them in descriptions.
  sanitizeCrossModelPayloadInPlace(request, {
    targetModel: resolved.actualModel,
  })
  const isImage = isImageGenerationModel(resolved.actualModel)
  const isClaude = familyFor(resolved.actualModel) === 'claude'
  if (isImage) {
    generationConfig.imageConfig = buildImageGenerationConfig()
    generationConfig.candidateCount ??= 1
    delete generationConfig.thinkingConfig
    request.generationConfig = generationConfig
    delete request.tools
    delete request.toolConfig
    request.systemInstruction = {
      parts: [
        {
          text: 'You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user request.',
        },
      ],
    }
  } else if (isClaude) {
    applyClaudeTransforms(request, {
      model: resolved.actualModel,
      ...(resolved.thinkingBudget !== undefined
        ? { tierThinkingBudget: resolved.thinkingBudget }
        : {}),
      normalizedThinking: {
        includeThoughts: true,
        ...(resolved.thinkingBudget !== undefined
          ? { thinkingBudget: resolved.thinkingBudget }
          : {}),
      },
      cleanJSONSchema: (schema) => {
        const clean = toGeminiSchema(schema, {
          moveNumericConstraintsToDescription: true,
        })
        return isRecord(clean) ? clean : {}
      },
    })
    const claudeGeneration = request.generationConfig
    if (claudeGeneration) {
      claudeGeneration.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS
      delete claudeGeneration.max_output_tokens
    }
    const claudeThinking = isRecord(claudeGeneration?.thinkingConfig)
      ? claudeGeneration.thinkingConfig
      : undefined
    if (claudeThinking) {
      claudeGeneration!.thinkingConfig = {
        includeThoughts: claudeThinking.include_thoughts !== false,
        ...(typeof claudeThinking.thinking_budget === 'number'
          ? { thinkingBudget: claudeThinking.thinking_budget }
          : {}),
      }
    }
  } else {
    normalizeGeminiTools(request, {
      moveNumericConstraintsToDescription: true,
    })
    configureToolCalling(request)
  }
  if (!isImage) {
    normalizeFunctionResponseRoles(request)
    if (replaySignatures.length > 0) {
      let signatureIndex = 0
      for (const content of request.contents ?? []) {
        for (const part of content.parts ?? []) {
          if (!part.functionCall) continue
          const signature = replaySignatures[signatureIndex]
          signatureIndex += 1
          if (signature) part.thoughtSignature = signature
        }
      }
    }
    ensureFunctionCallSignatures(request)
  }
  ensureTrailingUserTurn(request)

  const metadata = buildAgyAgentRequestMetadata(
    scope.session,
    request,
    resolved.actualModel,
    scope.timestamp,
  )
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)

  return {
    project: projectID,
    requestId: metadata.requestId,
    request,
    model: resolved.actualModel,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}

export function createOpenCodeV2AntigravityPlugin(
  overrides: OpenCodeV2DependencyOverrides = {},
): OpenCodePlugin.Plugin {
  const dependencies: OpenCodeV2Dependencies = {
    authorizeAntigravity:
      overrides.authorizeAntigravity ?? authorizeAntigravity,
    ensureProjectContext:
      overrides.ensureProjectContext ?? ensureProjectContext,
    exchangeAntigravity: overrides.exchangeAntigravity ?? exchangeAntigravity,
    mutateAccountStorage:
      overrides.mutateAccountStorage ?? mutateAccountStorage,
    refreshAntigravityToken:
      overrides.refreshAntigravityToken ?? refreshAntigravityToken,
    waitForAntigravityCode:
      overrides.waitForAntigravityCode ?? waitForAntigravityCode,
    send: overrides.send,
  }

  return {
    id: 'cortexkit.antigravity-auth',

    async setup(ctx) {
      const requestSessions = new AgyRequestSessionStore('opencode-v2')
      const jobs = new Map<string, PendingJob>()
      const jobTimers = new Map<string, NodeJS.Timeout>()
      const lastModelBySession = new Map<string, string>()
      const activeControllers = new Set<AbortController>()
      const registrations: Registration[] = []

      let accounts = await loadAccountStorage(ACCOUNTS_FILE).catch((error) => {
        log('accounts-load-error', errorMessage(error))
        return null
      })
      let manager = new AccountManager(undefined, accounts, {
        store: defaultAccountStorageStore,
        storagePath: ACCOUNTS_FILE,
      })
      log('setup-start', 'accounts', manager.getTotalAccountCount())

      const reloadPool = async (
        options: { flushCurrent?: boolean } = {},
      ): Promise<void> => {
        const previous = manager
        if (options.flushCurrent !== false) await previous.flushSaveToDisk()
        try {
          accounts = await loadAccountStorage(ACCOUNTS_FILE)
          manager = new AccountManager(undefined, accounts, {
            store: defaultAccountStorageStore,
            storagePath: ACCOUNTS_FILE,
          })
          await previous.dispose().catch((error) => {
            log('previous-pool-dispose-error', errorMessage(error))
          })
          log('pool-reloaded', manager.getTotalAccountCount())
        } catch (error) {
          log('reload-pool-error', errorMessage(error))
          throw error
        }
      }

      async function accessFor(
        account: ManagedAccount,
        force = false,
      ): Promise<OAuthAuthDetails> {
        if (
          !force &&
          account.access &&
          account.expires &&
          account.expires > Date.now() + 60_000
        ) {
          return manager.toAuthDetails(account)
        }
        const refreshed = await dependencies.refreshAntigravityToken(
          account.parts.refreshToken,
        )
        const auth: OAuthAuthDetails = {
          type: 'oauth',
          refresh: formatRefreshParts({
            refreshToken: refreshed.refresh,
            projectId: account.parts.projectId,
            managedProjectId: account.parts.managedProjectId,
          }),
          access: refreshed.access,
          expires: refreshed.expires,
        }
        manager.updateFromAuth(account, auth)
        return auth
      }

      function send(
        envelope: AntigravityEnvelope,
        auth: OAuthAuthDetails,
        endpoint: string,
        signal: AbortSignal | undefined,
        kind: SessionRequestKind,
      ): Promise<Response> {
        if (dependencies.send) {
          return dependencies.send({ envelope, auth, endpoint, signal, kind })
        }
        return fetchWithAgyCliTransport(
          `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.access}`,
              'Content-Type': 'application/json',
              'Accept-Encoding': 'gzip',
              'User-Agent': buildAntigravityHarnessUserAgent(),
            },
            body: JSON.stringify(envelope),
          },
          { signal: signal ?? null, idleTimeoutMs: 300_000 },
        )
      }

      function requestSessionKey(job: PendingJob): string {
        return `${job.sessionID || '__default__'}:${job.kind}`
      }

      async function pickResponse(
        job: PendingJob,
        signal?: AbortSignal,
      ): Promise<{ response: Response; account: ManagedAccount }> {
        const family = familyFor(job.modelID)
        const requested = job.resolved.actualModel
        const identity = { id: job.sessionID ?? 'default', parentId: null }
        const excluded = new Set<number>()
        const poolSize = Math.max(1, manager.getEnabledAccounts().length)
        let failure: unknown = null

        for (let attempt = 0; attempt < poolSize + 2; attempt += 1) {
          const account = manager.getCurrentOrNextForFamily(
            family,
            requested,
            'hybrid',
            'antigravity',
            false,
            100,
            10 * 60_000,
            identity,
            excluded,
          )
          if (!account) break

          let auth: OAuthAuthDetails
          try {
            auth = await accessFor(account)
          } catch (error) {
            log('token-error', `#${account.index}`, errorMessage(error))
            excluded.add(account.index)
            failure = error
            continue
          }

          let context: Awaited<ReturnType<typeof ensureProjectContext>>
          try {
            context = await dependencies.ensureProjectContext(auth)
          } catch (error) {
            log('project-error', `#${account.index}`, errorMessage(error))
            excluded.add(account.index)
            failure = error
            continue
          }

          const sessionKey = requestSessionKey(job)
          const scope = requestSessions.beginRequest(sessionKey)
          const envelope = buildEnvelope(
            job.payload,
            job.resolved,
            context.effectiveProjectId,
            scope,
            {
              preserveFunctionCallSignatures:
                lastModelBySession.get(sessionKey) === job.resolved.actualModel,
            },
          )
          if (
            !lastModelBySession.has(sessionKey) &&
            lastModelBySession.size >= 256
          ) {
            const oldestKey = lastModelBySession.keys().next().value
            if (oldestKey) lastModelBySession.delete(oldestKey)
          }
          lastModelBySession.delete(sessionKey)
          lastModelBySession.set(sessionKey, job.resolved.actualModel)

          // A forced refresh happens at most once per account/request; if the
          // endpoint still answers 401 afterwards the account is excluded and the
          // pool selection continues instead of refreshing in an unbounded loop.
          let forcedRefresh = false
          for (
            let endpointIndex = 0;
            endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length;
            endpointIndex += 1
          ) {
            const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex]
            if (!endpoint) continue
            let response: Response
            try {
              response = await send(envelope, auth, endpoint, signal, job.kind)
            } catch (error) {
              log(
                'transport-error',
                `#${account.index}`,
                endpoint,
                errorMessage(error),
              )
              failure = error
              continue
            }
            log(
              'upstream',
              `#${account.index}`,
              endpoint,
              job.resolved.actualModel,
              response.status,
            )

            if (response.ok) {
              manager.markRequestSuccess(account)
              manager.markAccountUsed(account.index)
              manager.recordRequest(account.index, family)
              manager.requestSaveToDisk()
              return { response, account }
            }

            const { reason, message } = await readErrorDetails(response)
            log('upstream-error', response.status, reason ?? '', message)
            if (
              response.status === 404 &&
              endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
            )
              continue

            if (response.status === 401) {
              if (!forcedRefresh) {
                try {
                  auth = await accessFor(account, true)
                  forcedRefresh = true
                  endpointIndex -= 1
                  continue
                } catch (error) {
                  failure = error
                }
              }
              excluded.add(account.index)
              break
            }

            if (response.status === 403 && reason === 'ACCOUNT_INELIGIBLE') {
              manager.markAccountIneligible(account.index, reason)
              await manager.flushSaveToDisk()
              excluded.add(account.index)
              failure = new Error('Antigravity account is ineligible')
              break
            }

            if (response.status === 403 && reason === 'VALIDATION_REQUIRED') {
              manager.markAccountVerificationRequired(account.index, reason)
              await manager.flushSaveToDisk()
              excluded.add(account.index)
              failure = new Error('Antigravity account requires validation')
              break
            }

            if (response.status === 503 || response.status === 529) {
              failure = new Error(
                `Antigravity capacity failure ${response.status}${message ? `: ${message}` : ''}`,
              )
              if (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1)
                continue
              manager.markRateLimitedWithReason(
                account,
                family,
                'antigravity',
                requested,
                'MODEL_CAPACITY_EXHAUSTED',
                45_000,
                3_600_000,
              )
              excluded.add(account.index)
              break
            }

            if (response.status === 429) {
              const limit =
                parseRateLimitReason(reason, '', response.status) ||
                'RATE_LIMIT'
              manager.markRateLimitedWithReason(
                account,
                family,
                'antigravity',
                requested,
                limit,
                retryAfterMs(response) ?? 60_000,
                3_600_000,
              )
              excluded.add(account.index)
              failure = new Error(
                `Antigravity ${response.status}${reason ? ` (${reason})` : ''}`,
              )
              break
            }

            failure = new Error(
              `Antigravity HTTP ${response.status}${reason ? ` (${reason})` : ''}`,
            )
            excluded.add(account.index)
            break
          }
          // Transport failures may exhaust every endpoint without producing an
          // HTTP response. Move to another account instead of selecting the same
          // account again in the outer loop.
          excluded.add(account.index)
        }

        throw (
          failure ??
          new Error(
            'No Antigravity account available (all rate-limited or disabled)',
          )
        )
      }

      // Streams one upstream SSE response into the loopback response, unwrapping the
      // `{ "response": … }` Antigravity envelope. A complete terminal frame is
      // mandatory; clean EOF and embedded errors fail through the host error path.
      async function pipeStream(
        upstream: Response,
        res: ServerResponse,
      ): Promise<{
        sawContent: boolean
        hasFunctionCall: boolean
        terminal: true
      }> {
        if (!upstream.body)
          throw new Error('Antigravity response body is missing')
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let sawContent = false
        let hasFunctionCall = false
        let terminal = false
        try {
          while (!terminal) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replace(/\r\n/g, '\n')
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf('\n\n')
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).replace(/^ /, ''))
                .join('\n')
                .trim()
              if (!data || data === '[DONE]') continue
              let parsed: unknown
              try {
                parsed = JSON.parse(data)
              } catch {
                throw new Error('Antigravity returned a malformed SSE frame')
              }
              if (isRecord(parsed) && isRecord(parsed.error)) {
                const message =
                  typeof parsed.error.message === 'string'
                    ? parsed.error.message
                    : `Antigravity stream failed (${String(parsed.error.status ?? parsed.error.code ?? 'unknown')})`
                throw new Error(message)
              }
              const inner = await persistInlineImages(
                sanitizeInner(unwrapFrame(parsed)),
              )
              const parts = inner?.candidates?.[0]?.content?.parts ?? []
              if (
                parts.some(
                  (part) =>
                    part?.text || part?.functionCall || part?.inlineData,
                )
              )
                sawContent = true
              if (parts.some((part) => part?.functionCall)) {
                hasFunctionCall = true
              }
              if (!res.headersSent) {
                res.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache',
                })
              }
              res.write(`data: ${JSON.stringify(inner)}\n\n`)
              if (inner?.candidates?.[0]?.finishReason) {
                terminal = true
                break
              }
            }
          }
          if (!terminal) {
            throw new Error('Antigravity stream ended before a terminal frame')
          }
        } finally {
          try {
            await reader.cancel()
          } catch (error) {
            log('stream-cancel-error', errorMessage(error))
          }
        }
        return { sawContent, hasFunctionCall, terminal: true }
      }

      // Collects one upstream SSE stream into a single JSON GenerateContentResponse
      // (used when the host issued a non-streaming `generateContent` call — the
      // loopback must not answer that with `text/event-stream`).
      async function collectNonStream(
        upstream: Response,
      ): Promise<GeminiPayload> {
        if (!upstream.body)
          throw new Error('Antigravity response body is missing')
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        const LF = String.fromCharCode(10)
        const CR = String.fromCharCode(13)
        let buffer = ''
        const byIndex = new Map<number, GeminiCandidate>()
        let usageMetadata: unknown
        let promptFeedback: unknown
        let terminal = false
        try {
          while (!terminal) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.split(CR).join('')
            let boundary = buffer.indexOf(LF + LF)
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf(LF + LF)
              const data = frame
                .split(LF)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join(LF)
                .trim()
              if (!data || data === '[DONE]') continue
              let parsed: unknown
              try {
                parsed = JSON.parse(data)
              } catch {
                throw new Error('Antigravity returned a malformed SSE frame')
              }
              if (isRecord(parsed) && isRecord(parsed.error)) {
                const message =
                  typeof parsed.error.message === 'string'
                    ? parsed.error.message
                    : `Antigravity stream failed (${String(parsed.error.status ?? parsed.error.code ?? 'unknown')})`
                throw new Error(message)
              }
              const inner = sanitizeInner(unwrapFrame(parsed))
              for (const candidate of inner?.candidates ?? []) {
                const index = candidate.index ?? 0
                let entry = byIndex.get(index)
                if (!entry) {
                  entry = {
                    ...candidate,
                    content: { ...(candidate.content ?? {}), parts: [] },
                  }
                  byIndex.set(index, entry)
                }
                for (const part of candidate.content?.parts ?? []) {
                  if (part?.text || part?.inlineData || part?.functionCall)
                    entry.content?.parts?.push(part)
                }
                if (candidate.finishReason)
                  entry.finishReason = candidate.finishReason
                if (candidate.thought) entry.thought = candidate.thought
                if (candidate.index !== undefined) entry.index = index
              }
              if (inner?.usageMetadata) usageMetadata = inner.usageMetadata
              if (inner?.promptFeedback) promptFeedback = inner.promptFeedback
              if (
                inner?.candidates?.some((candidate) => candidate.finishReason)
              )
                terminal = true
            }
          }
          if (!terminal) {
            throw new Error('Antigravity stream ended before a terminal frame')
          }
        } finally {
          try {
            await reader.cancel()
          } catch (error) {
            log('non-stream-cancel-error', errorMessage(error))
          }
        }
        const merged: GeminiPayload = {
          candidates: [...byIndex.values()],
          ...(usageMetadata ? { usageMetadata } : {}),
          ...(promptFeedback ? { promptFeedback } : {}),
        }
        return persistInlineImages(merged)
      }

      const server = createServer((req, res) => {
        const id = (req.url ?? '').split('/').filter(Boolean).pop() ?? ''
        const job = jobs.get(id)
        jobs.delete(id)
        const jobTimer = jobTimers.get(id)
        if (jobTimer) clearTimeout(jobTimer)
        jobTimers.delete(id)
        req.resume()
        if (!job) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: { message: 'unknown antigravity request', status: 404 },
            }),
          )
          return
        }

        const controller = new AbortController()
        activeControllers.add(controller)
        res.on('close', () => controller.abort())

        ;(async () => {
          const picked = await pickResponse(job, controller.signal)
          const finish = (body?: string): void => {
            if (!res.headersSent) {
              res.writeHead(200, {
                'content-type': job.stream
                  ? 'text/event-stream; charset=utf-8'
                  : 'application/json; charset=utf-8',
                'cache-control': 'no-cache',
              })
            }
            res.end(body)
          }

          if (!job.stream) {
            const collected = await collectNonStream(picked.response)
            const hasFunctionCall = collected.candidates?.some((candidate) =>
              candidate.content?.parts?.some((part) => part.functionCall),
            )
            if (!hasFunctionCall) {
              requestSessions.completeExecution(requestSessionKey(job))
            }
            log('non-stream-done', job.modelID)
            finish(JSON.stringify(collected))
            return
          }

          const { sawContent, hasFunctionCall, terminal } = await pipeStream(
            picked.response,
            res,
          )
          if (!hasFunctionCall) {
            requestSessions.completeExecution(requestSessionKey(job))
          }
          log(
            'stream-done',
            job.modelID,
            'content',
            sawContent,
            'terminal',
            terminal,
          )
          finish()
        })()
          .catch((error) => {
            log('server-error', errorMessage(error))
            try {
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' })
                res.end(
                  JSON.stringify({
                    error: {
                      message: errorMessage(error),
                      status: 502,
                    },
                  }),
                )
              } else {
                res.destroy(error instanceof Error ? error : undefined)
              }
            } catch (responseError) {
              log('loopback-error-response-failed', errorMessage(responseError))
            }
          })
          .finally(() => activeControllers.delete(controller))
      })

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('OpenCode 2 loopback server did not publish a port')
      }
      const port = (address as AddressInfo).port
      log('loopback-listening', port)

      registrations.push(
        await ctx.session.hook('http.request', async (event) => {
          try {
            if (event.model.providerID !== 'google') return
            if (event.kind !== 'title' && !MODEL_IDS.has(event.model.id)) return
            const url = new URL(event.request.url)
            if (
              !/\/models\/[^:]+:(?:streamGenerateContent|generateContent)/.test(
                url.pathname,
              )
            )
              return

            const raw = Buffer.from(await event.request.arrayBuffer()).toString(
              'utf8',
            )
            const parsedPayload: unknown = JSON.parse(raw || '{}')
            if (!isRecord(parsedPayload)) {
              throw new Error('OpenCode 2 emitted a non-object Gemini request')
            }
            const payload = parsedPayload as GeminiPayload
            const requested =
              event.kind === 'title'
                ? 'gemini-3.5-flash-low'
                : requestedModel(event.model.id, event.model.variant)
            const resolved = resolveModelForHeaderStyle(
              requested,
              'antigravity',
            )
            const id = randomUUID()
            jobs.set(id, {
              payload,
              resolved,
              modelID: event.model.id,
              variant: event.model.variant,
              sessionID: event.sessionID,
              kind: event.kind,
              // The hook matches both endpoints; the loopback answers the streaming
              // one with SSE and the non-streaming one with a single JSON response.
              stream: /streamGenerateContent/.test(url.pathname),
            })
            const jobTimer = setTimeout(() => {
              jobs.delete(id)
              jobTimers.delete(id)
            }, 10 * 60_000)
            jobTimer.unref()
            jobTimers.set(id, jobTimer)
            const attachments = (payload.contents ?? []).flatMap((content) =>
              (content.parts ?? []).flatMap((part) =>
                part.inlineData
                  ? [
                      `${part.inlineData.mimeType}:${String(part.inlineData.data ?? '').length}b`,
                    ]
                  : [],
              ),
            )
            log(
              'route',
              event.model.id,
              event.model.variant ?? 'default',
              '->',
              resolved.actualModel,
              'media',
              JSON.stringify(attachments),
            )
            event.request = new Request(`http://127.0.0.1:${port}/agy/${id}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          } catch (error) {
            log('request-hook-error', errorMessage(error))
            throw error
          }
        }),
      )

      // OAuth: every login appends an account to the shared pool.
      registrations.push(
        await ctx.integration.transform((draft) => {
          draft.method.update({
            integrationID: INTEGRATION_ID,
            method: {
              id: METHOD_ID,
              type: 'oauth',
              label: 'Google Antigravity (add account)',
            },
            authorize: async () => {
              const authorization = await dependencies.authorizeAntigravity()
              const state = new URL(authorization.url).searchParams.get('state')
              if (!state) {
                throw new Error(
                  'Antigravity authorization URL is missing OAuth state',
                )
              }
              const pending = dependencies.waitForAntigravityCode(state)
              const callback = (async () => {
                const code = await pending
                const result = await dependencies.exchangeAntigravity(
                  code,
                  state,
                )
                if (result.type === 'failed') {
                  throw new Error(
                    `Antigravity token exchange failed: ${result.error}`,
                  )
                }
                const now = Date.now()
                const refreshParts = parseRefreshParts(result.refresh)
                if (!refreshParts.refreshToken) {
                  throw new Error(
                    'Antigravity token exchange returned no refresh token',
                  )
                }
                await manager.flushSaveToDisk()
                await dependencies.mutateAccountStorage(
                  ACCOUNTS_FILE,
                  (current) => upsertOAuthAccount(current, result, now),
                )
                await reloadPool({ flushCurrent: false })
                log('account-added', 'pool', manager.getTotalAccountCount())
                const credential: Credential.OAuth = {
                  type: 'oauth',
                  methodID: METHOD_ID,
                  refresh: formatRefreshParts({
                    refreshToken: refreshParts.refreshToken,
                    projectId:
                      refreshParts.projectId || result.projectId || undefined,
                    managedProjectId: refreshParts.managedProjectId,
                  }),
                  access: result.access,
                  expires: result.expires,
                }
                return credential
              })()
              return {
                url: authorization.url,
                instructions:
                  'Open the URL and sign in. The Google account is appended to the Antigravity pool.',
                mode: 'auto',
                callback,
              }
            },
            refresh: async (credential) => {
              const parts = parseRefreshParts(credential.refresh)
              const refreshed = await dependencies.refreshAntigravityToken(
                parts.refreshToken,
              )
              const nextCredential: Credential.OAuth = {
                type: 'oauth',
                methodID: METHOD_ID,
                refresh: formatRefreshParts({
                  refreshToken: refreshed.refresh,
                  projectId: parts.projectId,
                  managedProjectId: parts.managedProjectId,
                }),
                access: refreshed.access,
                expires: refreshed.expires,
                ...(credential.metadata
                  ? { metadata: credential.metadata }
                  : {}),
              }
              return nextCredential
            },
            label: () => 'Antigravity account',
          })
        }),
      )

      return async () => {
        for (const registration of registrations.reverse()) {
          await registration
            .dispose()
            .catch((error) =>
              log('registration-dispose-error', errorMessage(error)),
            )
        }
        jobs.clear()
        lastModelBySession.clear()
        for (const timer of jobTimers.values()) clearTimeout(timer)
        jobTimers.clear()
        for (const controller of activeControllers) controller.abort()
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        requestSessions.clear()
        await manager
          .flushSaveToDisk()
          .catch((error) => log('pool-flush-error', errorMessage(error)))
        await manager
          .dispose()
          .catch((error) => log('pool-dispose-error', errorMessage(error)))
        log('dispose')
      }
    },
  }
}

export default createOpenCodeV2AntigravityPlugin()
