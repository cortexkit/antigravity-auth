import { describe, expect, it } from 'bun:test'

import { createDisplayedThinkingRegistry } from './displayed-thinking'

describe('displayed thinking registry', () => {
  it('gives each session its own set and none without a session key', () => {
    const registry = createDisplayedThinkingRegistry()
    registry.forSession('a')?.add('hash')
    expect(registry.forSession('a')?.has('hash')).toBe(true)
    expect(registry.forSession('b')?.has('hash')).toBe(false)
    expect(registry.forSession(undefined)).toBeUndefined()
    expect(registry.forSession('')).toBeUndefined()
  })

  it('bounds the texts kept per session', () => {
    const registry = createDisplayedThinkingRegistry({ perSession: 3 })
    const hashes = registry.forSession('a')!
    for (const hash of ['1', '2', '3', '4']) hashes.add(hash)
    expect([...hashes]).toEqual(['2', '3', '4'])
  })

  it('forgets the least recently used session past the session limit', () => {
    const registry = createDisplayedThinkingRegistry({ sessions: 2 })
    registry.forSession('a')?.add('kept')
    registry.forSession('b')?.add('dropped')
    registry.forSession('a')
    registry.forSession('c')
    expect(registry.sessionCount).toBe(2)
    expect(registry.forSession('a')?.has('kept')).toBe(true)
    expect(registry.forSession('b')?.has('dropped')).toBe(false)
  })
})
