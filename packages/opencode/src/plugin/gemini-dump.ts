import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactJsonBodyString } from './logging-utils'

export const GEMINI_DUMP_COMMAND_NAME = 'gemini-dump'

const DUMP_STATUS_TITLE = '## Gemini Dump Status'
const DUMP_ENABLED_TITLE = '## Gemini Dump Enabled'
const DUMP_DISABLED_TITLE = '## Gemini Dump Disabled'
const DUMP_USAGE_TITLE = '## Gemini Dump Usage'
const DUMP_USAGE =
  'Usage: `/gemini-dump`, `/gemini-dump on`, or `/gemini-dump off`.'
const DUMP_DIR_ENV = 'OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR'
const DEFAULT_DUMP_DIR = join(tmpdir(), 'opencode-antigravity-gemini-dumps')
// Dumps contain full prompts, tool outputs, and generated content. On shared
// temp storage these must not be world/group readable.
const DUMP_DIR_MODE = 0o700
const DUMP_FILE_MODE = 0o600

// Dump ids are `<timestamp>-<sequence>-<kind>` file names in one directory.
// The sequence is process-wide so two locations dumping in the same
// millisecond cannot overwrite each other's files; whether dumping is enabled
// is per location (see createGeminiDumpState).
let nextDumpId = 0

export type GeminiDumpCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'usage' }

export interface GeminiDumpContext {
  id: string
  files: {
    request: string
    response: string
    metadata: string
  }
  metadata: Record<string, unknown>
}

export interface GeminiDumpRequestInput {
  originalUrl: string
  resolvedUrl: string
  method?: string
  headers?: HeadersInit | Headers
  body?: BodyInit | null
  streaming: boolean
  requestedModel?: string
  effectiveModel?: string
  sessionId?: string
  projectId?: string
}

/**
 * One location's dump switch. `/gemini-dump on` in one location never
 * enables dumping for another, and each location's requests consult only
 * their own switch.
 */
export interface GeminiDumpState {
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  /** Dump a request when this location's switch is on; null otherwise. */
  dumpRequest(input: GeminiDumpRequestInput): GeminiDumpContext | null
  /** Status text reflecting this location's switch unless `enabled` is given. */
  buildStatusSummary(input?: { enabled?: boolean }): string
  /** Command reply reflecting this location's switch unless `enabled` is given. */
  executeCommand(input: { argumentsText: string; enabled?: boolean }): string
}

/** Initial switch value when a location supplies none: the environment flag. */
function dumpEnabledFromEnvironment(): boolean {
  return process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP === '1'
}

/** Build one location's dump switch, defaulting to the environment flag. */
export function createGeminiDumpState(
  options: { enabled?: boolean } = {},
): GeminiDumpState {
  let enabled = options.enabled ?? dumpEnabledFromEnvironment()
  return {
    isEnabled: () => enabled,
    setEnabled: (next) => {
      enabled = next
    },
    dumpRequest: (input) => (enabled ? writeGeminiDump(input) : null),
    buildStatusSummary: (input) =>
      renderGeminiDumpStatus(input?.enabled ?? enabled),
    executeCommand: (input) =>
      renderGeminiDumpCommand(input.argumentsText, input.enabled ?? enabled),
  }
}

// One shared switch behind the exported module-level dump functions below.
// A state from `createGeminiDumpState` is separate and never reads or writes
// it.
const legacyDumpState = createGeminiDumpState()

export function isGeminiDumpEnabled() {
  return legacyDumpState.isEnabled()
}

export function setGeminiDumpEnabled(enabled: boolean) {
  legacyDumpState.setEnabled(enabled)
}

export function resetGeminiDumpState() {
  legacyDumpState.setEnabled(dumpEnabledFromEnvironment())
  nextDumpId = 0
}

export function getGeminiDumpDirectory() {
  return process.env[DUMP_DIR_ENV] || DEFAULT_DUMP_DIR
}

export function parseGeminiDumpCommandAction(
  argumentsText: string,
): GeminiDumpCommandAction {
  const normalized = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  return { type: 'usage' }
}

export function buildGeminiDumpStatusSummary(input?: { enabled?: boolean }) {
  return legacyDumpState.buildStatusSummary(input)
}

function renderGeminiDumpStatus(enabled: boolean): string {
  return [
    DUMP_STATUS_TITLE,
    '',
    `- Enabled: ${enabled ? 'enabled' : 'disabled'}`,
    `- Directory: ${getGeminiDumpDirectory()}`,
    '- Captures: final Antigravity request body plus raw response SSE/text chunks',
    '- Warning: dumps contain prompt/session content; turn this off after debugging',
  ].join('\n')
}

export function executeGeminiDumpCommand(input: {
  argumentsText: string
  enabled?: boolean
}) {
  return legacyDumpState.executeCommand(input)
}

function renderGeminiDumpCommand(
  argumentsText: string,
  enabled: boolean,
): string {
  const action = parseGeminiDumpCommandAction(argumentsText)

  if (action.type === 'status') return renderGeminiDumpStatus(enabled)

  if (action.type === 'enable') {
    return [DUMP_ENABLED_TITLE, '', renderGeminiDumpStatus(true)].join('\n')
  }

  if (action.type === 'disable') {
    return [DUMP_DISABLED_TITLE, '', renderGeminiDumpStatus(false)].join('\n')
  }

  return [
    DUMP_USAGE_TITLE,
    '',
    DUMP_USAGE,
    '',
    renderGeminiDumpStatus(enabled),
  ].join('\n')
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Mask all but the first 4 and last 4 chars of a sensitive identifier.
 * Short inputs collapse to `****` so a UUID / project ID never appears
 * in full in a debug log or dump file. Returns `undefined` for
 * undefined inputs so the caller can drop the field.
 */
function maskIdentifier(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

function redactProjectId(value: string | undefined): string | undefined {
  return maskIdentifier(value)
}

function redactSessionId(value: string | undefined): string | undefined {
  return maskIdentifier(value)
}

function redactForDump(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDump)
  if (value == null || typeof value !== 'object') return value

  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'cookie' ||
      lower === 'set-cookie'
    ) {
      redacted[key] = '[redacted]'
      continue
    }
    if (lower === 'user-agent') {
      // Fingerprint User-Agent strings are stable identifiers. Mask
      // the body but keep the header shape so the dump still tells
      // operators a UA was sent.
      redacted[key] = typeof entry === 'string' ? maskIdentifier(entry) : entry
      continue
    }
    redacted[key] = redactForDump(entry)
  }
  return redacted
}

function headersToRecord(
  headers?: HeadersInit | Headers,
): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function parseBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(bodyText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function collectToolNames(value: unknown): string[] {
  const names: string[] = []
  const walk = (entry: unknown) => {
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item)
      return
    }
    if (!entry || typeof entry !== 'object') return
    const record = entry as Record<string, unknown>
    const declarations = record.functionDeclarations
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        if (declaration && typeof declaration === 'object') {
          const name = (declaration as Record<string, unknown>).name
          if (typeof name === 'string') names.push(name)
        }
      }
    }
    for (const item of Object.values(record)) walk(item)
  }
  walk(value)
  return names
}

function bodyStructureSummary(bodyText: string) {
  const parsed = parseBody(bodyText)
  if (!parsed) return { parseable: false as const }

  const request =
    parsed.request && typeof parsed.request === 'object'
      ? (parsed.request as Record<string, unknown>)
      : undefined
  const contents = Array.isArray(request?.contents) ? request.contents : []
  const toolNames = collectToolNames(request ?? parsed)

  return {
    parseable: true as const,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    requestId:
      typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
    requestType:
      typeof parsed.requestType === 'string' ? parsed.requestType : undefined,
    contentsCount: contents.length,
    toolsCount: toolNames.length,
    toolsHash: hashText(toolNames.join('\n')),
    toolsFirst: toolNames.slice(0, 20),
    toolsLast: toolNames.slice(-10),
    bodyHash: hashText(bodyText),
    bodyBytes: bodyText.length,
  }
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: DUMP_FILE_MODE,
  })
}

function updateMetadata(
  context: GeminiDumpContext,
  patch: Record<string, unknown>,
) {
  context.metadata = {
    ...context.metadata,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  writeJson(context.files.metadata, context.metadata)
}

export function dumpGeminiRequest(
  input: GeminiDumpRequestInput,
): GeminiDumpContext | null {
  return legacyDumpState.dumpRequest(input)
}

function writeGeminiDump(
  input: GeminiDumpRequestInput,
): GeminiDumpContext | null {
  if (typeof input.body !== 'string') return null

  nextDumpId += 1
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(nextDumpId).padStart(5, '0')}-${input.streaming ? 'stream' : 'json'}`
  const dumpDir = getGeminiDumpDirectory()
  const prefix = join(dumpDir, id)
  mkdirSync(dumpDir, { recursive: true, mode: DUMP_DIR_MODE })

  const context: GeminiDumpContext = {
    id,
    files: {
      request: `${prefix}.request.json`,
      response: `${prefix}.response.raw`,
      metadata: `${prefix}.meta.json`,
    },
    metadata: {
      id,
      createdAt: new Date().toISOString(),
      originalUrl: input.originalUrl,
      resolvedUrl: input.resolvedUrl,
      method: input.method,
      streaming: input.streaming,
      requestedModel: input.requestedModel,
      effectiveModel: input.effectiveModel,
      sessionId: redactSessionId(input.sessionId),
      projectId: redactProjectId(input.projectId),
      headers: redactForDump(headersToRecord(input.headers)),
      request: bodyStructureSummary(input.body),
      files: {
        request: `${prefix}.request.json`,
        response: `${prefix}.response.raw`,
        metadata: `${prefix}.meta.json`,
      },
    },
  }

  // The body embeds raw project IDs — redact credential-shaped fields
  // before the verbatim request copy lands on disk.
  writeFileSync(context.files.request, redactJsonBodyString(input.body), {
    encoding: 'utf8',
    mode: DUMP_FILE_MODE,
  })
  writeFileSync(context.files.response, '', {
    encoding: 'utf8',
    mode: DUMP_FILE_MODE,
  })
  writeJson(context.files.metadata, context.metadata)
  return context
}

export function noteGeminiDumpResponse(
  context: GeminiDumpContext | null | undefined,
  response: Pick<Response, 'status' | 'statusText' | 'headers'>,
) {
  if (!context) return
  updateMetadata(context, {
    responseStatus: response.status,
    responseStatusText: response.statusText,
    responseHeaders: redactForDump(headersToRecord(response.headers)),
  })
}

export function appendGeminiDumpResponseText(
  context: GeminiDumpContext | null | undefined,
  text: string,
) {
  if (!context) return
  appendFileSync(context.files.response, text, 'utf8')
  updateMetadata(context, {
    responseBytes: text.length,
    responseHash: hashText(text),
  })
}

export function createGeminiDumpResponseTransform(
  context: GeminiDumpContext | null | undefined,
): TransformStream<Uint8Array, Uint8Array> | null {
  if (!context) return null
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      appendFileSync(context.files.response, Buffer.from(chunk))
      controller.enqueue(chunk)
    },
  })
}
