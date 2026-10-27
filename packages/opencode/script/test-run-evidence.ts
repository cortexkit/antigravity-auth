import { readFileSync } from 'node:fs'

export interface RunEvidenceOptions {
  sessionId?: string | null
  answer?: string
  prompt?: string
  toolOutput?: string
}

/** Accept a completed CLI turn only when its JSON stream contains a fresh assistant answer. */
export function readRunEvidence(
  stdout: string,
  stderr: string,
  code: number,
  options: RunEvidenceOptions = {},
) {
  if (code !== 0)
    throw new Error(`OpenCode exited ${code}: ${stderr || stdout}`)
  if (/Invalid.*signature/i.test(`${stdout}\n${stderr}`))
    throw new Error('Invalid signature')
  const events: Array<Record<string, any>> = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Malformed CLI event')
      return value as Record<string, any>
    })
  if (events.some((event) => event.type === 'error'))
    throw new Error('OpenCode reported an error event')
  const parts = events
    .filter((event) => event.type === 'text')
    .map((event) => {
      const part = event.part
      if (
        part?.type !== 'text' ||
        typeof part.text !== 'string' ||
        typeof part.sessionID !== 'string' ||
        !part.sessionID ||
        typeof part.messageID !== 'string' ||
        !part.messageID ||
        event.sessionID !== part.sessionID
      )
        throw new Error('Malformed assistant text event')
      return part as { text: string; sessionID: string; messageID: string }
    })
  if (!parts.length) throw new Error('No assistant text')
  const sessionId = parts[0]!.sessionID
  const messageId = parts.at(-1)!.messageID
  if (
    parts.some((part) => part.sessionID !== sessionId) ||
    (options.sessionId && sessionId !== options.sessionId)
  )
    throw new Error('Wrong assistant session or message')
  // Tool loops may emit intermediate assistant messages before the final answer.
  const text = parts
    .filter((part) => part.messageID === messageId)
    .map((part) => part.text)
    .join('')
    .trim()
  if (!text || text === options.prompt)
    throw new Error('No assistant answer beyond the prompt')
  if (options.answer !== undefined && text !== options.answer)
    throw new Error(`Expected answer ${options.answer}, received ${text}`)
  if (
    options.toolOutput !== undefined &&
    !events.some(
      (event) =>
        event.part?.type === 'tool' &&
        event.part.sessionID === sessionId &&
        event.part.state?.status === 'completed' &&
        typeof event.part.state.output === 'string' &&
        event.part.state.output.includes(options.toolOutput!),
    )
  )
    throw new Error('Missing completed tool output')
  return { sessionId, messageId, text }
}

export function expectedToolOutput(prompt: string): string | undefined {
  const echo = /\becho '([^']+)'/.exec(prompt)
  if (echo) return echo[1]
  if (
    /^(?:now )?(?:read\b|run:|use (?:bash|glob|grep|read|lsp_diagnostics)\b)/i.test(
      prompt,
    ) ||
    /\buse bash to verify\b/i.test(prompt)
  )
    return ''
  return undefined
}

if (import.meta.main) {
  const [out, err, code, sessionId, prompt] = process.argv.slice(2)
  try {
    if (!out || !err || !code || !prompt)
      throw new Error('Missing CLI capture arguments')
    const evidence = readRunEvidence(
      readFileSync(out, 'utf8'),
      readFileSync(err, 'utf8'),
      Number(code),
      { sessionId, prompt, toolOutput: expectedToolOutput(prompt) },
    )
    console.log(evidence.sessionId)
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
