import { describe, expect, it } from 'bun:test'
import {
  ANTIGRAVITY_MENU_COMMAND,
  ANTIGRAVITY_MENU_TITLE,
  getRandomizedHeaders,
  type HeaderSet,
  MENU_SECTION_SLOTS,
} from './constants.ts'
import * as hostApi from './tui/host-api.ts'

describe('getRandomizedHeaders', () => {
  describe('antigravity style', () => {
    it('returns only the captured agy CLI User-Agent', () => {
      const headers = getRandomizedHeaders()
      expect(headers['User-Agent']).toMatch(
        /^antigravity\/cli\/1\.3\.5 \(aidev_client; os_type=.+; arch=.+; cl=998863838; auth_method=consumer\)$/,
      )
      expect(headers['X-Goog-Api-Client']).toBeUndefined()
      expect(headers['Client-Metadata']).toBeUndefined()
    })

    it('uses normalized runtime platform/arch in User-Agent', () => {
      const headers = getRandomizedHeaders()
      const platform =
        process.platform === 'win32' ? 'windows' : process.platform
      const arch =
        process.arch === 'x64'
          ? 'amd64'
          : process.arch === 'ia32'
            ? '386'
            : process.arch
      expect(headers['User-Agent']).toContain(
        `os_type=${platform}; arch=${arch}`,
      )
    })
  })
})

// Typechecking preserves optional-header assignability without runtime assertions on literals.
void ({ 'User-Agent': 'test' } satisfies HeaderSet)
void ({
  'User-Agent': 'test',
  'X-Goog-Api-Client': 'test-client',
  'Client-Metadata': 'test-metadata',
} satisfies HeaderSet)

describe('/antigravity menu constants', () => {
  it('names one slash command, without the slash', () => {
    expect(ANTIGRAVITY_MENU_COMMAND).toBe('antigravity')
    expect(ANTIGRAVITY_MENU_TITLE).toBe('Antigravity')
  })

  it('keeps the shared command menu slot order', () => {
    expect(MENU_SECTION_SLOTS).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'cache',
      'diagnostics',
      'extra',
    ])
  })

  it('re-exports the TUI values rather than a second copy', () => {
    expect(ANTIGRAVITY_MENU_COMMAND).toBe(hostApi.ANTIGRAVITY_MENU_COMMAND)
    expect(MENU_SECTION_SLOTS).toBe(hostApi.MENU_SECTION_SLOTS)
  })
})
