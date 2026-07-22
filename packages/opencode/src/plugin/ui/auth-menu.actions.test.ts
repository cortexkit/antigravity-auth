import { beforeEach, describe, expect, it, mock } from 'bun:test'

const selectMock = mock()

mock.module('./select', () => ({
  select: selectMock,
}))

mock.module('./confirm', () => ({
  confirm: mock(),
}))

describe('showAuthMenu actions', () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it('exposes auth doctor as a top-level action', async () => {
    selectMock.mockResolvedValue({ type: 'cancel' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: { type: string }
    }>
    expect(items).toContainEqual(
      expect.objectContaining({
        label: 'Auth doctor',
        value: { type: 'doctor' },
      }),
    )
  })

  it('exposes repair auth as a top-level action', async () => {
    selectMock.mockResolvedValue({ type: 'cancel' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: { type: string }
    }>
    expect(items).toContainEqual(
      expect.objectContaining({
        label: 'Repair auth',
        value: { type: 'repair' },
      }),
    )
  })

  it('exposes auth current as a top-level action', async () => {
    selectMock.mockResolvedValue({ type: 'cancel' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    await showAuthMenu([])

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: { type: string }
    }>
    expect(items).toContainEqual(
      expect.objectContaining({
        label: 'Auth current',
        value: { type: 'current' },
      }),
    )
  })

  it('repair auth action returns correct type when selected', async () => {
    selectMock.mockResolvedValue({ type: 'repair' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    const result = await showAuthMenu([])
    expect(result).toEqual({ type: 'repair' })
  })

  it('auth current action returns correct type when selected', async () => {
    selectMock.mockResolvedValue({ type: 'current' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    const result = await showAuthMenu([])
    expect(result).toEqual({ type: 'current' })
  })

  it('shows cached quota summary in account hints', async () => {
    selectMock.mockResolvedValue({ type: 'cancel' })
    const { showAuthMenu } = await import('./auth-menu.ts')

    await showAuthMenu([
      {
        email: 'quota@example.com',
        index: 0,
        quotaSummary: 'Claude 80%, Gemini Flash 42%',
      },
    ])

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      hint?: string
    }>
    expect(items).toContainEqual(
      expect.objectContaining({
        label: expect.stringContaining('quota@example.com'),
        hint: 'Claude 80%, Gemini Flash 42%',
      }),
    )
  })
})

describe('showAccountDetails switch account', () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it('shows switch-account option for non-current accounts', async () => {
    selectMock.mockResolvedValue('back')
    const { showAccountDetails } = await import('./auth-menu.ts')

    await showAccountDetails({
      email: 'other@example.com',
      index: 1,
      isCurrentAccount: false,
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: string
    }>
    const switchItem = items.find((item) => item.value === 'switch-account')
    expect(switchItem).toBeDefined()
    expect(switchItem!.label).toBe('Switch to this account')
  })

  it('hides switch-account option for current account', async () => {
    selectMock.mockResolvedValue('back')
    const { showAccountDetails } = await import('./auth-menu.ts')

    await showAccountDetails({
      email: 'current@example.com',
      index: 0,
      isCurrentAccount: true,
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: string
    }>
    const switchItem = items.find((item) => item.value === 'switch-account')
    expect(switchItem).toBeUndefined()
  })

  it('returns switch-account when selected', async () => {
    selectMock.mockResolvedValue('switch-account')
    const { showAccountDetails } = await import('./auth-menu.ts')

    const result = await showAccountDetails({
      email: 'other@example.com',
      index: 1,
      isCurrentAccount: false,
    })

    expect(result).toBe('switch-account')
  })
})

describe('showAccountDetails fingerprint restore', () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it('shows restore fingerprint option when history exists', async () => {
    selectMock.mockResolvedValue('back')
    const { showAccountDetails } = await import('./auth-menu.ts')

    await showAccountDetails({
      email: 'test@example.com',
      index: 0,
      fingerprintHistory: [
        {
          fingerprint: {
            deviceId: 'abcd1234efgh',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now() - 86400000,
          reason: 'regenerated',
        },
      ],
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: string
    }>
    const restoreItem = items.find(
      (item) => item.value === 'restore-fingerprint',
    )
    expect(restoreItem).toBeDefined()
    expect(restoreItem!.label).toContain('Restore fingerprint')
    expect(restoreItem!.label).toContain('1 saved')
  })

  it('hides restore fingerprint option when no history', async () => {
    selectMock.mockResolvedValue('back')
    const { showAccountDetails } = await import('./auth-menu.ts')

    await showAccountDetails({
      email: 'test@example.com',
      index: 0,
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: string
    }>
    const restoreItem = items.find(
      (item) => item.value === 'restore-fingerprint',
    )
    expect(restoreItem).toBeUndefined()
  })

  it('hides restore fingerprint option when history is empty', async () => {
    selectMock.mockResolvedValue('back')
    const { showAccountDetails } = await import('./auth-menu.ts')

    await showAccountDetails({
      email: 'test@example.com',
      index: 0,
      fingerprintHistory: [],
    })

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: string
    }>
    const restoreItem = items.find(
      (item) => item.value === 'restore-fingerprint',
    )
    expect(restoreItem).toBeUndefined()
  })
})

describe('showFingerprintHistory', () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it('displays fingerprint history entries with truncated device IDs', async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now() - 86400000,
          reason: 'regenerated',
        },
        {
          fingerprint: {
            deviceId: '12345678abcdefgh',
            userAgent: 'ua2',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now() - 172800000,
          reason: 'initial',
        },
      ],
      'test@example.com',
    )

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: number | null
    }>
    const entryItems = items.filter((item) => typeof item.value === 'number')
    expect(entryItems).toHaveLength(2)
    expect(entryItems[0]!.label).toContain('abcdef12')
    expect(entryItems[0]!.label).toContain('[regenerated]')
    expect(entryItems[1]!.label).toContain('12345678')
    expect(entryItems[1]!.label).toContain('[initial]')
  })

  it('returns selected history index', async () => {
    selectMock.mockResolvedValue(1)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    const result = await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'regenerated',
        },
        {
          fingerprint: {
            deviceId: '12345678abcdefgh',
            userAgent: 'ua2',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'initial',
        },
      ],
      'test@example.com',
    )

    expect(result).toBe(1)
  })

  it('returns null when user cancels (selects back)', async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    const result = await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'regenerated',
        },
      ],
      'test@example.com',
    )

    expect(result).toBeNull()
  })

  it('returns null when select returns undefined (ESC)', async () => {
    selectMock.mockResolvedValue(undefined)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    const result = await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'regenerated',
        },
      ],
      'test@example.com',
    )

    expect(result).toBeNull()
  })

  it('includes back option and heading in menu', async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'regenerated',
        },
      ],
      'test@example.com',
    )

    const items = selectMock.mock.calls[0]?.[0] as Array<{
      label: string
      value: number | null
      kind?: string
    }>
    expect(items[0]).toEqual(
      expect.objectContaining({ label: 'Back', value: null }),
    )
    const heading = items.find((i) => i.kind === 'heading')
    expect(heading).toBeDefined()
    expect(heading!.label).toBe('Fingerprint history')
  })

  it('passes account label in menu message', async () => {
    selectMock.mockResolvedValue(null)
    const { showFingerprintHistory } = await import('./auth-menu.ts')

    await showFingerprintHistory(
      [
        {
          fingerprint: {
            deviceId: 'abcdef1234567890',
            userAgent: 'ua1',
            sessionToken: 's',
            apiClient: 'a',
            clientMetadata: { ideType: 't', platform: 'p', pluginType: 't' },
            createdAt: 0,
          },
          timestamp: Date.now(),
          reason: 'regenerated',
        },
      ],
      'alice@example.com',
    )

    const options = selectMock.mock.calls[0]?.[1] as { message: string }
    expect(options.message).toContain('alice@example.com')
  })
})
