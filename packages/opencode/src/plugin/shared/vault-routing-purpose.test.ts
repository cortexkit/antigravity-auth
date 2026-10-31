import { expect, test } from 'bun:test'
import { prepareAntigravityRequest } from '../request'
import {
  createVaultRoutingHeaders,
  isPrimaryVaultRequest,
  VAULT_ROUTING_PURPOSE_HEADER,
} from './vault-routing-purpose'

test('legacy hook positively identifies only known primary agents and keeps other providers unchanged', async () => {
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
    expect(isPrimaryVaultRequest(undefined, output.headers)).toBe(
      agent === 'build' || agent === 'plan',
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
  expect(isPrimaryVaultRequest(undefined)).toBe(false)
  expect(isPrimaryVaultRequest('primary')).toBe(true)
  for (const kind of ['title', 'compaction', 'generate'])
    expect(
      isPrimaryVaultRequest(kind, {
        [VAULT_ROUTING_PURPOSE_HEADER]: 'primary',
      }),
    ).toBe(false)
})

test('legacy wire preparation strips the internal purpose header alongside session headers', () => {
  const prepared = prepareAntigravityRequest(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
    {
      method: 'POST',
      headers: {
        [VAULT_ROUTING_PURPOSE_HEADER]: 'primary',
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
