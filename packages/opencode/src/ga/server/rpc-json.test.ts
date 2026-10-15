import { describe, expect, it } from 'bun:test'

import { toRpcJson } from './index.ts'

describe('toRpcJson', () => {
  it('drops undefined-valued keys so the answer is a JSON value', () => {
    const value = toRpcJson({
      id: 'acct-0',
      cooldownUntil: undefined,
      quota: { gemini: undefined, 'non-gemini': { remainingPercent: 100 } },
      nested: [{ keep: 1, drop: undefined }],
    })
    expect(value).toEqual({
      id: 'acct-0',
      quota: { 'non-gemini': { remainingPercent: 100 } },
      nested: [{ keep: 1 }],
    })
    expect(JSON.stringify(value)).toBe(
      '{"id":"acct-0","quota":{"non-gemini":{"remainingPercent":100}},"nested":[{"keep":1}]}',
    )
  })

  it('keeps null, false, zero and empty strings, and returns primitives unchanged', () => {
    expect(toRpcJson(null)).toBeNull()
    expect(toRpcJson(false)).toBe(false)
    expect(toRpcJson(0)).toBe(0)
    expect(toRpcJson('')).toBe('')
    expect(toRpcJson({ a: null, b: false, c: 0, d: '' })).toEqual({
      a: null,
      b: false,
      c: 0,
      d: '',
    })
  })

  it('preserves non-plain objects instead of inspecting their internals', () => {
    const date = new Date(0)
    expect(toRpcJson(date)).toBe(date)
    const array = [date]
    expect(toRpcJson(array)[0]).toBe(date)
  })
})
