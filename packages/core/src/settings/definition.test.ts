import { describe, expect, it } from 'bun:test'
import { ANTIGRAVITY_SETTINGS, RETIRED_SETTINGS } from './definition.ts'

describe('settings declaration', () => {
  it('loads a frozen antigravity-auth declaration with no sidebar or retired keys', () => {
    expect(ANTIGRAVITY_SETTINGS.plugin).toBe('antigravity-auth')
    expect(Object.isFrozen(ANTIGRAVITY_SETTINGS.settings)).toBe(true)
    expect(Object.keys(ANTIGRAVITY_SETTINGS.settings)).toHaveLength(43)
    expect(ANTIGRAVITY_SETTINGS.settings).not.toHaveProperty('sidebar')
    expect(RETIRED_SETTINGS).toEqual([
      'tool_id_recovery',
      'max_backoff_seconds',
    ])
    for (const key of RETIRED_SETTINGS)
      expect(ANTIGRAVITY_SETTINGS.settings).not.toHaveProperty(key)
  })

  it('allows exactly the five reviewed project settings and no overrides', () => {
    const allowed = Object.entries(ANTIGRAVITY_SETTINGS.settings)
      .filter(([, declaration]) => declaration.project === 'allowed')
      .map(([name]) => name)
      .sort()
    expect(allowed).toEqual([
      'claude_prompt_auto_caching',
      'claude_tool_hardening',
      'quiet_mode',
      'session_recovery',
      'toast_scope',
    ])
    for (const declaration of Object.values(ANTIGRAVITY_SETTINGS.settings)) {
      expect(declaration).not.toHaveProperty('overrides')
    }
    expect(ANTIGRAVITY_SETTINGS.settings.account_models.project).toBe(
      'user-only',
    )
    expect(ANTIGRAVITY_SETTINGS.settings.account_models.value).toEqual({
      kind: 'record',
      value: { kind: 'list', item: { kind: 'string' } },
    })
  })
})
