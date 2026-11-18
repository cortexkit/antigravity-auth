import { expect, test } from 'bun:test'
import { prepareAntigravityRequest } from '../request'
import {
  createVaultRoutingHeaders,
  isTitleVaultRequest,
  VAULT_ROUTING_PURPOSE_HEADER,
} from './vault-routing-purpose'

test('legacy hook identifies only the title agent as a title and keeps other providers unchanged', async () => {
  const hook = createVaultRoutingHeaders('google')
  for (const agent of [
    'build',
    'plan',
    'title',
    'compaction',
    'summary',
    '',
    'unknown',
  ]) {
    const output = { headers: {} as Record<string, string> }
    await hook(
      { agent, model: { providerID: 'google' } } as Parameters<typeof hook>[0],
      output,
    )
    expect(isTitleVaultRequest(undefined, output.headers)).toBe(
      agent === 'title',
    )
  }
  const other = { headers: { untouched: 'yes' } }
  await hook(
    { agent: 'build', model: { providerID: 'other' } } as Parameters<
      typeof hook
    >[0],
    other,
  )
  expect(other.headers).toEqual({ untouched: 'yes' })
  expect(isTitleVaultRequest(undefined)).toBe(false)
  expect(isTitleVaultRequest('title')).toBe(true)
  for (const kind of ['primary', 'compaction', 'generate'])
    expect(
      isTitleVaultRequest(kind, {
        [VAULT_ROUTING_PURPOSE_HEADER]: 'title',
      }),
    ).toBe(false)
})

test('legacy wire preparation strips the internal purpose header alongside session headers', () => {
  const prepared = prepareAntigravityRequest(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
    {
      method: 'POST',
      headers: {
        [VAULT_ROUTING_PURPOSE_HEADER]: 'title',
        'x-session-affinity': 'session',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    },
    'token',
    'project',
  )
  const headers = new Headers(prepared.init.headers)
  expect(headers.has(VAULT_ROUTING_PURPOSE_HEADER)).toBe(false)
  expect(headers.has('x-session-affinity')).toBe(false)
})
