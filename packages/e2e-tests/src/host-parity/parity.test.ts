import { expect, test } from 'bun:test'
import { requestCases, subjects } from './cases.ts'
import { runConversation } from './runner.ts'

test.each(
  subjects,
)('%s enters the stock public request and response paths', async (subject) => {
  const input = requestCases[0]!
  const result = await runConversation({ input, subject, custody: 'local' })
  expect(result).toMatchObject({
    wire: [{ target: expect.stringContaining(':streamGenerateContent') }],
    turns: [{ text: 'Four.', terminal: ['stop'], errors: [] }],
  })
})
