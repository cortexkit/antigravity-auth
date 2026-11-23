import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { redactCredentialText } from '@cortexkit/antigravity-auth-core'
import type {
  GeminiDumpContext,
  RequestDebug,
  RequestDump,
  RequestLogger,
  ResponseDump,
} from '@cortexkit/antigravity-auth-core/engine'
import type { PiRequestSettings } from './request-settings.ts'

export function createPiRequestDiagnostics(
  settings: () => PiRequestSettings,
  defaultDirectory?: string,
) {
  const directory = () => settings().log_dir || defaultDirectory
  const write = (file: string, text: string) => {
    try {
      const dir = directory()
      if (!dir) return
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(dir, file), text, { mode: 0o600 })
    } catch {
      // A read-only or unavailable diagnostics directory must not fail a request.
    }
  }
  const log = (
    level: keyof Pick<RequestLogger, 'debug' | 'info' | 'warn' | 'error'>,
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    const levels = ['error', 'warn', 'info', 'debug', 'trace']
    if (levels.indexOf(level) > levels.indexOf(settings().log_level)) return
    try {
      write(
        'pi-antigravity.log',
        `${redactCredentialText(JSON.stringify({ level, message, extra }))}\n`,
      )
    } catch {
      // Upstream diagnostic objects may not be serializable.
    }
  }
  const logger: RequestLogger = {
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  }
  let sequence = 0
  const debugLine = (event: string, data: unknown) => {
    if (settings().debug)
      write(
        'pi-antigravity-debug.log',
        `${redactCredentialText(JSON.stringify({ event, data }))}\n`,
      )
  }
  const debug: RequestDebug = {
    isDebugEnabled: () => settings().debug,
    startAntigravityDebugRequest(meta) {
      if (!settings().debug) return null
      const context = {
        id: String(++sequence),
        streaming: meta.streaming,
        startedAt: Date.now(),
      }
      debugLine('request', {
        ...context,
        method: meta.method,
        url: meta.resolvedUrl,
      })
      return context
    },
    logAntigravityDebugResponse: (context, response) =>
      debugLine('response', { id: context?.id, status: response.status }),
    logAccountContext: (label, info) =>
      debugLine(label, { index: info.index, family: info.family }),
    logRateLimitEvent: (index, _email, family, status, wait) =>
      debugLine('rate-limit', { index, family, status, wait }),
    logRateLimitSnapshot: (family, rows) =>
      debugLine('limits', { family, count: rows.length }),
    logResponseBody: async () => undefined,
    logModelFamily: (_url, model, family) =>
      debugLine('model-family', { model, family }),
  }
  const secrets = new WeakMap<
    GeminiDumpContext,
    { bearer?: string; projectId?: string }
  >()
  const append: ResponseDump['appendResponseText'] = (context, text) => {
    if (!context) return
    const fields = secrets.get(context)
    write(
      context.files.response,
      redactCredentialText(
        text,
        fields?.bearer,
        fields?.projectId ? [fields.projectId] : [],
      ),
    )
  }
  const dump: RequestDump & ResponseDump = {
    dumpRequest(input) {
      if (process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP !== '1' || !directory())
        return null
      const id = `${process.pid}-${Date.now()}-${++sequence}`
      const files = {
        request: `${id}-request.json`,
        response: `${id}-response.sse`,
        metadata: `${id}-meta.json`,
      }
      const context = { id, files, metadata: {} }
      const bearer = new Headers(input.headers)
        .get('authorization')
        ?.replace(/^Bearer\s+/i, '')
      secrets.set(context, { bearer, projectId: input.projectId })
      write(
        files.request,
        redactCredentialText(
          String(input.body ?? ''),
          bearer,
          input.projectId ? [input.projectId] : [],
        ),
      )
      return context
    },
    noteResponse(context, response) {
      if (context)
        write(
          context.files.metadata,
          `${JSON.stringify({ status: response.status })}\n`,
        )
    },
    appendResponseText: append,
    createResponseTransform(context) {
      if (!context) return null
      const decoder = new TextDecoder()
      let pending = ''
      return new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          pending += decoder.decode(chunk, { stream: true })
          const newline = pending.lastIndexOf('\n')
          if (newline !== -1) {
            append(context, pending.slice(0, newline + 1))
            pending = pending.slice(newline + 1)
          }
        },
        flush() {
          append(context, pending + decoder.decode())
        },
      })
    },
  }
  return { logger, debug, dump }
}
