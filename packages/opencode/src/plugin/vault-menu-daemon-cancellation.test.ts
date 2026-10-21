import { expect, it } from 'bun:test'
import { expectedInsulaReset } from './__fixtures__/vault-menu-daemon.test'

it('the owned daemon only permits insula resets during an expected custody cancellation', () => {
  expect(expectedInsulaReset(true, true, 'ECONNRESET')).toBe(true)
  expect(expectedInsulaReset(false, true, 'ECONNRESET')).toBe(false)
  expect(expectedInsulaReset(true, false, 'ECONNRESET')).toBe(false)
  expect(expectedInsulaReset(true, true, 'EPIPE')).toBe(false)
  expect(expectedInsulaReset(true, true, undefined)).toBe(false)
})
