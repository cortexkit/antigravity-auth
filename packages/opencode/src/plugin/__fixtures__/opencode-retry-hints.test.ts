import { expect } from 'bun:test'
import { openCodeRetryHint } from '../shared/opencode-retry-hints.ts'

export function expectNoOpenCodeRetryHints(text: string): void {
  expect(openCodeRetryHint(text), text).toBeUndefined()
}
