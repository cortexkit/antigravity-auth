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
import { appendFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CORE = '@cortexkit/antigravity-auth-core'
const {
  AccountManager,
  defaultAccountStorageStore,
  loadAccountStorage,
  mutateAccountStorage,
  formatRefreshParts,
  refreshAntigravityToken,
  resolveModelForHeaderStyle,
  getModelFamily,
  ensureProjectContext,
  AgyRequestSessionStore,
  buildAgyAgentRequestMetadata,
  orderAgyRequestPayloadInPlace,
  normalizeGeminiTools,
  fetchWithAgyCliTransport,
  buildAntigravityHarnessUserAgent,
  authorizeAntigravity,
  exchangeAntigravity,
  parseRateLimitReason,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
} = await import(CORE)

function configDir() {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    const appdata = join(process.env.APPDATA.trim(), 'opencode')
    if (existsSync(join(appdata, 'antigravity-accounts.json'))) return appdata
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
}

function stateDir() {
  const xdg = process.env.XDG_STATE_HOME?.trim()
  return xdg
    ? join(xdg, 'opencode')
    : join(homedir(), '.local', 'state', 'opencode')
}

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return xdg
    ? join(xdg, 'opencode')
    : join(homedir(), '.local', 'share', 'opencode')
}

const ACCOUNTS_FILE =
  process.env.ANTIGRAVITY_ACCOUNTS_FILE?.trim() ||
  join(configDir(), 'antigravity-accounts.json')
const LOGFILE = join(stateDir(), 'antigravity-v2.log')
const METHOD_ID = 'antigravity-v2'
const EMPTY_RESPONSE_MAX_ATTEMPTS = 3

function log(...args) {
  try {
    appendFileSync(
      LOGFILE,
      `[${new Date().toISOString()}] ` +
        args
          .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          .join(' ') +
        '\n',
    )
  } catch {}
}

const MODEL_IDS = new Set([
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
])

function familyFor(modelID) {
  return getModelFamily(modelID) === 'claude' ? 'claude' : 'gemini'
}

function requestedModel(modelID, variant) {
  if (!variant || variant === 'default') return modelID
  return `${modelID}-${variant}`
}

function unwrapFrame(parsed) {
  if (
    parsed &&
    typeof parsed === 'object' &&
    'response' in parsed &&
    parsed.response &&
    typeof parsed.response === 'object'
  ) {
    return parsed.response
  }
  return parsed
}

// Antigravity's GPT/Claude bridges occasionally emit parts and roles the strict
// native Gemini event schema rejects (e.g. role "assistant", or a part carrying
// only a thought signature). Normalise every frame to the Gemini shape.
function sanitizeInner(inner) {
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
        const out = {}
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

const IMAGE_DIR = join(dataDir(), 'antigravity-images')
const IMAGE_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// The native Gemini event parser only renders text and tool calls, so generated
// images are written to disk and announced as text instead of being dropped.
async function persistInlineImages(inner) {
  const parts = inner?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return inner
  for (let index = 0; index < parts.length; index += 1) {
    const inline = parts[index]?.inlineData
    if (!inline?.data || !String(inline.mimeType ?? '').startsWith('image/'))
      continue
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(IMAGE_DIR, { recursive: true })
      const extension = IMAGE_EXTENSION[inline.mimeType] ?? 'png'
      const file = join(
        IMAGE_DIR,
        `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`,
      )
      await writeFile(file, Buffer.from(inline.data, 'base64'))
      parts[index] = { text: `[Antigravity image saved: ${file}]` }
      log('image-saved', file, inline.mimeType)
    } catch (error) {
      log('image-save-error', error?.message ?? String(error))
      parts[index] = {
        text: '[Antigravity returned an image that could not be saved]',
      }
    }
  }
  return inner
}
function retryAfterMs(response) {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) && date - Date.now() > 0
    ? date - Date.now()
    : undefined
}

async function readErrorReason(response) {
  try {
    const parsed = JSON.parse(await response.clone().text())
    const details = parsed?.error?.details ?? parsed?.details ?? []
    return (
      details
        .map((item) => item?.reason)
        .find((value) => typeof value === 'string') ?? parsed?.error?.status
    )
  } catch {
    return undefined
  }
}

function buildEnvelope(payload, resolved, projectID, metadata) {
  const request = { ...payload }
  delete request.model
  delete request.project
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

  // AGY's GPT bridge re-encodes protobuf numeric constraints as strings before
  // OpenAI JSON-Schema validation, so `minLength: 1` must move to the description.
  const isGpt = /^gpt-/i.test(resolved.actualModel)
  normalizeGeminiTools(request, { moveNumericConstraintsToDescription: isGpt })

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

export default {
  id: 'local.antigravity',

  async setup(ctx) {
    const requestSessions = new AgyRequestSessionStore('opencode-v2')
    const jobs = new Map()

    let accounts = await loadAccountStorage(ACCOUNTS_FILE).catch((error) => {
      log('accounts-load-error', error?.message ?? String(error))
      return null
    })
    let manager = new AccountManager(undefined, accounts, {
      store: defaultAccountStorageStore,
      storagePath: ACCOUNTS_FILE,
    })
    log('setup-start', 'accounts', manager.getTotalAccountCount())

    const reloadPool = async () => {
      try {
        await manager.flushSaveToDisk().catch(() => {})
        accounts = await loadAccountStorage(ACCOUNTS_FILE)
        manager = new AccountManager(undefined, accounts, {
          store: defaultAccountStorageStore,
          storagePath: ACCOUNTS_FILE,
        })
        log('pool-reloaded', manager.getTotalAccountCount())
      } catch (error) {
        log('reload-pool-error', error?.message ?? String(error))
      }
    }

    async function accessFor(account, force = false) {
      if (
        !force &&
        account.access &&
        account.expires &&
        account.expires > Date.now() + 60_000
      ) {
        return manager.toAuthDetails(account)
      }
      const refreshed = await refreshAntigravityToken(
        account.parts.refreshToken,
      )
      const auth = {
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

    function send(envelope, auth, endpoint, signal) {
      return fetchWithAgyCliTransport(
        `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.access}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'Accept-Encoding': 'gzip',
            'User-Agent': buildAntigravityHarnessUserAgent(),
          },
          body: JSON.stringify(envelope),
        },
        { signal: signal ?? null, idleTimeoutMs: 300_000 },
      )
    }

    async function pickResponse(job, signal) {
      const family = familyFor(job.modelID)
      const requested = requestedModel(job.modelID, job.variant)
      const identity = { id: job.sessionID ?? 'default', parentId: null }
      const excluded = new Set()
      const poolSize = Math.max(1, manager.getEnabledAccounts().length)
      let failure = null

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

        let auth
        try {
          auth = await accessFor(account)
        } catch (error) {
          log(
            'token-error',
            `#${account.index}`,
            error?.message ?? String(error),
          )
          excluded.add(account.index)
          failure = error
          continue
        }

        let context
        try {
          context = await ensureProjectContext(auth)
        } catch (error) {
          log(
            'project-error',
            `#${account.index}`,
            error?.message ?? String(error),
          )
          excluded.add(account.index)
          failure = error
          continue
        }

        const scope = requestSessions.beginRequest(
          String(job.sessionID ?? '__default__'),
        )
        const metadata = buildAgyAgentRequestMetadata(
          scope.session,
          job.payload,
          job.resolved.actualModel,
          scope.timestamp,
          {
            stepCountMode: 'cli',
          },
        )
        const envelope = buildEnvelope(
          job.payload,
          job.resolved,
          context.effectiveProjectId,
          metadata,
        )

        for (
          let endpointIndex = 0;
          endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length;
          endpointIndex += 1
        ) {
          const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex]
          let response
          try {
            response = await send(envelope, auth, endpoint, signal)
          } catch (error) {
            log(
              'transport-error',
              `#${account.index}`,
              endpoint,
              error?.message ?? String(error),
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

          const reason = await readErrorReason(response)
          if (!response.ok) {
            const detail = await response
              .clone()
              .text()
              .catch(() => '')
            let message = ''
            try {
              message = JSON.parse(detail)?.error?.message ?? ''
            } catch {
              message = detail.slice(0, 200)
            }
            log(
              'upstream-error',
              response.status,
              reason ?? '',
              message.slice(0, 300),
            )
          }
          if (
            response.status === 404 &&
            endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
          )
            continue

          if (response.status === 401) {
            try {
              auth = await accessFor(account, true)
              endpointIndex -= 1
              continue
            } catch (error) {
              failure = error
            }
            excluded.add(account.index)
            break
          }

          if (response.status === 429 || response.status === 403) {
            const limit =
              parseRateLimitReason(reason, '', response.status) || 'RATE_LIMIT'
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
      }

      throw (
        failure ??
        new Error(
          'No Antigravity account available (all rate-limited or disabled)',
        )
      )
    }

    // Streams one upstream SSE response into the loopback response, unwrapping the
    // `{ "response": … }` Antigravity envelope. Reports whether any model content
    // arrived so a bare STOP can be retried.
    async function pipeStream(upstream, res) {
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawContent = false
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
            let parsed
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            const inner = await persistInlineImages(
              sanitizeInner(unwrapFrame(parsed)),
            )
            const parts = inner?.candidates?.[0]?.content?.parts ?? []
            if (
              parts.some(
                (part) => part?.text || part?.functionCall || part?.inlineData,
              )
            )
              sawContent = true
            res.write(`data: ${JSON.stringify(inner)}\n\n`)
            if (inner?.candidates?.[0]?.finishReason) {
              terminal = true
              break
            }
          }
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
      }
      return { sawContent, terminal }
    }

    // Collects one complete Antigravity answer (used by the document tool).
    async function collectText(upstream) {
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      const LF = String.fromCharCode(10)
      const CR = String.fromCharCode(13)
      let buffer = ''
      const chunks = []
      const images = []
      let done = false
      try {
        while (!done) {
          const { done: finished, value } = await reader.read()
          if (finished) break
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
            let parsed
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            const inner = unwrapFrame(parsed)
            for (const part of inner?.candidates?.[0]?.content?.parts ?? []) {
              if (part?.thought) continue
              if (typeof part?.text === 'string' && part.text)
                chunks.push(part.text)
              if (part?.inlineData?.data) images.push(part.inlineData)
            }
            if (inner?.candidates?.[0]?.finishReason) {
              done = true
              break
            }
          }
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
      }
      return { text: chunks.join(''), images }
    }

    const DOCUMENT_MIME = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
    }

    const server = createServer((req, res) => {
      const id = (req.url ?? '').split('/').filter(Boolean).pop() ?? ''
      const job = jobs.get(id)
      jobs.delete(id)
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
      res.on('close', () => controller.abort())

      ;(async () => {
        let lastError = null
        for (
          let attempt = 1;
          attempt <= EMPTY_RESPONSE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          let picked
          try {
            picked = await pickResponse(job, controller.signal)
          } catch (error) {
            lastError = error
            break
          }
          if (!res.headersSent) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
            })
          }
          const { sawContent, terminal } = await pipeStream(
            picked.response,
            res,
          )
          log(
            'stream-done',
            job.modelID,
            'content',
            sawContent,
            'terminal',
            terminal,
            'attempt',
            attempt,
          )
          if (sawContent || attempt === EMPTY_RESPONSE_MAX_ATTEMPTS) {
            res.end()
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        const message =
          lastError?.message ??
          String(lastError ?? 'Antigravity request failed')
        log('request-failed', job.modelID, message)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message, status: 502 } }))
        } else {
          res.end()
        }
      })().catch((error) => {
        log('server-error', error?.message ?? String(error))
        try {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                error: {
                  message: error?.message ?? String(error),
                  status: 502,
                },
              }),
            )
          } else {
            res.end()
          }
        } catch {}
      })
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const port = server.address().port
    log('loopback-listening', port)

    await ctx.session.hook('http.request', async (event) => {
      try {
        if (event.model.providerID !== 'google') return
        if (!MODEL_IDS.has(event.model.id)) return
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
        const payload = JSON.parse(raw || '{}')
        const requested = requestedModel(event.model.id, event.model.variant)
        const resolved = resolveModelForHeaderStyle(requested, 'antigravity')
        const id = randomUUID()
        jobs.set(id, {
          payload,
          resolved,
          modelID: event.model.id,
          variant: event.model.variant,
          sessionID: event.sessionID,
        })
        setTimeout(() => jobs.delete(id), 10 * 60_000)
        const attachments = (payload.contents ?? [])
          .flatMap((content) => content?.parts ?? [])
          .filter((part) => part?.inlineData)
          .map(
            (part) =>
              `${part.inlineData.mimeType}:${String(part.inlineData.data ?? '').length}b`,
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
        log('request-hook-error', error?.message ?? String(error))
      }
    })

    // PDF / image reader. OpenCode's CLI drops PDF attachments before they reach
    // the provider, so the plugin loads the document itself and asks Antigravity
    // directly — the same "reuse the working channel" approach as ModLens.
    await ctx.tool.transform((draft) => {
      draft.add({
        name: 'antigravity_read_document',
        description:
          'Read a local PDF or image with an Antigravity multimodal model and return its text. Use for .pdf, .png, .jpg, .webp, .gif, .heic files. Arguments: path (absolute), question (optional), model (optional, defaults to gemini-3.6-flash).',
        input: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to the PDF or image file',
            },
            question: {
              type: 'string',
              description: 'What to extract or ask about the document',
            },
            model: {
              type: 'string',
              description:
                'Antigravity model id, e.g. gemini-3.6-flash or gemini-3.1-pro',
            },
          },
          required: ['path'],
        },
        async execute(input) {
          const { readFile } = await import('node:fs/promises')
          const { extname, basename } = await import('node:path')
          const path = String(input?.path ?? '').trim()
          if (!path)
            return { content: 'antigravity_read_document: `path` is required' }
          const extension = extname(path).toLowerCase()
          const mimeType = DOCUMENT_MIME[extension]
          if (!mimeType) {
            return {
              content: `antigravity_read_document: unsupported file type ${extension || '(none)'}`,
            }
          }
          let data
          try {
            data = (await readFile(path)).toString('base64')
          } catch (error) {
            return {
              content: `antigravity_read_document: cannot read ${path}: ${error?.message ?? String(error)}`,
            }
          }
          const question =
            String(input?.question ?? '').trim() ||
            'Transcribe this document completely and describe any tables, figures or layout that matter.'
          const modelID = MODEL_IDS.has(String(input?.model))
            ? String(input.model)
            : 'gemini-3.6-flash'
          const variant =
            modelID.startsWith('gemini-3.') && !modelID.includes('image')
              ? 'high'
              : undefined
          const resolved = resolveModelForHeaderStyle(
            requestedModel(modelID, variant),
            'antigravity',
          )
          const job = {
            payload: {
              contents: [
                {
                  role: 'user',
                  parts: [
                    { inlineData: { mimeType, data } },
                    { text: question },
                  ],
                },
              ],
            },
            resolved,
            modelID,
            variant,
            sessionID: `tool:${basename(path)}`,
          }
          log(
            'tool-read',
            basename(path),
            mimeType,
            data.length,
            '->',
            resolved.actualModel,
          )
          const picked = await pickResponse(job, undefined)
          const { text, images } = await collectText(picked.response)
          if (!text && images.length === 0)
            return {
              content:
                'antigravity_read_document: the model returned no content',
            }
          const content = []
          if (text) content.push({ type: 'text', text })
          for (const image of images) {
            content.push({
              type: 'file',
              mime: image.mimeType ?? 'image/png',
              uri: `data:${image.mimeType ?? 'image/png'};base64,${image.data}`,
              name: `${basename(path)}-output`,
            })
          }
          return {
            content,
            metadata: {
              model: resolved.actualModel,
              file: basename(path),
              mime: mimeType,
            },
          }
        },
      })
    })

    // OAuth: every login appends an account to the shared pool.
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: 'google',
        method: {
          id: METHOD_ID,
          type: 'oauth',
          label: 'Google Antigravity (add account)',
        },
        authorize: async () => {
          const authorization = await authorizeAntigravity()
          const state = new URL(authorization.url).searchParams.get('state')
          if (!state)
            throw new Error(
              'Antigravity authorization URL is missing OAuth state',
            )
          const { waitForAntigravityCode } = await import(
            './oauth-callback.mjs'
          )
          const pending = waitForAntigravityCode(state)
          return {
            url: authorization.url,
            instructions:
              'Open the URL and sign in. The Google account is appended to the Antigravity pool.',
            mode: 'auto',
            callback: async () => {
              const code = await pending
              const result = await exchangeAntigravity(code, state)
              if (result.type === 'failed')
                throw new Error(
                  `Antigravity token exchange failed: ${result.error}`,
                )
              const now = Date.now()
              await mutateAccountStorage(ACCOUNTS_FILE, (current) => ({
                ...current,
                version: 4,
                accounts: [
                  ...current.accounts.filter(
                    (item) => item.email !== result.email,
                  ),
                  {
                    email: result.email,
                    refreshToken: result.refresh,
                    projectId: result.projectId || undefined,
                    addedAt: now,
                    lastUsed: now,
                    enabled: true,
                    rateLimitResetTimes: {},
                  },
                ],
              }))
              await reloadPool()
              log('account-added', 'pool', manager.getTotalAccountCount())
              return {
                type: 'oauth',
                methodID: METHOD_ID,
                refresh: result.refresh,
                access: result.access,
                expires: result.expires,
                metadata: {
                  accountID: result.email ?? '',
                  projectID: result.projectId ?? '',
                },
              }
            },
          }
        },
        refresh: async (credential) => {
          const refreshToken = String(credential.refresh ?? '').split('|')[0]
          const refreshed = await refreshAntigravityToken(refreshToken)
          return {
            type: 'oauth',
            methodID: METHOD_ID,
            refresh: formatRefreshParts({ refreshToken: refreshed.refresh }),
            access: refreshed.access,
            expires: refreshed.expires,
            ...(credential.metadata ? { metadata: credential.metadata } : {}),
          }
        },
        label: (credential) =>
          credential?.metadata?.accountID || 'Antigravity account',
      })
    })

    return async () => {
      try {
        await manager.flushSaveToDisk()
        await manager.dispose()
      } catch {}
      await new Promise((resolve) => server.close(() => resolve()))
      log('dispose')
    }
  },
}
