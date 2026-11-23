import { Buffer } from 'node:buffer'

export const epoch = Date.UTC(2026, 6, 22, 12)
export const credential = {
  accessToken: 'parity-token',
  projectId: 'parity-project',
}
export const placeholder = 'parity-vault-placeholder'
export const maskedFields: readonly string[] = []

export type Wire = {
  target: string
  headers: [string, string][]
  bodyBase64: string
}

export type Reply = {
  status?: number
  headers?: Record<string, string>
  body?: string
  stall?: 'before-headers' | 'after-body'
  transportError?: string
}

export const sse = (...frames: (object | string)[]) =>
  frames
    .map(
      (frame) =>
        `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`,
    )
    .join('')
export const candidate = (
  parts: object[],
  finishReason?: string,
  index = 0,
) => ({
  response: {
    candidates: [{ index, content: { role: 'model', parts }, finishReason }],
  },
})
export const success: Reply = {
  body: sse(candidate([{ text: 'Four.' }], 'STOP')),
}

export function bodyOf(wire: Wire): Record<string, unknown> {
  const bytes = Buffer.from(wire.bodyBase64, 'base64')
  if (
    !wire.headers.some(
      ([key, value]) =>
        key.toLowerCase() === 'transfer-encoding' && value === 'chunked',
    )
  )
    return JSON.parse(bytes.toString('utf8'))

  const chunks: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const prefix = bytes.indexOf('\r\n', offset)
    const length = Number.parseInt(
      bytes.subarray(offset, prefix).toString('ascii'),
      16,
    )
    if (prefix < offset || !Number.isSafeInteger(length) || length < 0)
      throw new Error('Invalid captured HTTP chunk')
    if (length === 0) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    chunks.push(bytes.subarray(prefix + 2, prefix + 2 + length))
    offset = prefix + 2 + length + 2
  }
  throw new Error('Captured HTTP chunk stream is missing its terminator')
}
