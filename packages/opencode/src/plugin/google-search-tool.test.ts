import { beforeEach, describe, expect, it, mock } from 'bun:test'

const executeSearch = mock(async () => 'search result')
const refreshAccessToken = mock(async () => undefined)

mock.module('./search', () => ({ executeSearch }))
mock.module('./token', () => ({ refreshAccessToken }))

import { createGoogleSearchTool } from './google-search-tool'
import type { AuthDetails } from './types'

type SearchTool = {
  execute: (
    args: { query: string; urls?: string[]; thinking?: boolean },
    context: { abort: AbortSignal },
  ) => Promise<string>
}

function toolWith(
  getAuth: () => Promise<AuthDetails | null | undefined>,
  mayStartLocalWork?: () => Promise<boolean>,
): SearchTool {
  return createGoogleSearchTool({
    getAuth,
    mayStartLocalWork,
    client: { auth: { set: mock(async () => {}) } } as never,
    providerId: 'google',
  }) as unknown as SearchTool
}

beforeEach(() => {
  executeSearch.mockClear()
  refreshAccessToken.mockClear()
})

describe('createGoogleSearchTool', () => {
  it('returns the authentication message when auth is missing', async () => {
    const searchTool = toolWith(async () => undefined)

    await expect(
      searchTool.execute(
        { query: 'current news' },
        { abort: new AbortController().signal },
      ),
    ).resolves.toBe(
      'Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.',
    )
    expect(executeSearch).not.toHaveBeenCalled()
  })

  it('returns the refresh error when access-token refresh fails', async () => {
    refreshAccessToken.mockRejectedValueOnce(new Error('refresh failed'))
    const searchTool = toolWith(async () => ({
      type: 'oauth',
      refresh: 'refresh|project|managed-project',
      access: 'expired',
      expires: 1,
    }))

    await expect(
      searchTool.execute(
        { query: 'current news' },
        { abort: new AbortController().signal },
      ),
    ).resolves.toBe('Error: Failed to refresh access token: refresh failed')
    expect(executeSearch).not.toHaveBeenCalled()
  })

  it('forwards arguments, auth context, and abort signal to search', async () => {
    const abort = new AbortController().signal
    const searchTool = toolWith(async () => ({
      type: 'oauth',
      refresh: 'refresh|project|managed-project',
      access: 'access-token',
      expires: Date.now() + 3_600_000,
    }))

    await expect(
      searchTool.execute(
        {
          query: 'release notes',
          urls: ['https://example.test/docs'],
          thinking: false,
        },
        { abort },
      ),
    ).resolves.toBe('search result')
    expect(executeSearch).toHaveBeenCalledWith(
      {
        query: 'release notes',
        urls: ['https://example.test/docs'],
        thinking: false,
      },
      'access-token',
      'managed-project',
      abort,
    )
  })
})

it('refuses vault or unreadable authority before resolving or refreshing a native login', async () => {
  let nativeReads = 0
  const searchTool = toolWith(
    async () => {
      nativeReads += 1
      throw new Error('native credentials must stay dormant')
    },
    async () => false,
  )
  expect(
    await searchTool.execute(
      { query: 'synthetic query' },
      { abort: new AbortController().signal },
    ),
  ).toBe(
    'Google Search is not available through local credentials while vault custody is active or unreadable.',
  )
  expect(nativeReads).toBe(0)
  expect(refreshAccessToken).not.toHaveBeenCalled()
  expect(executeSearch).not.toHaveBeenCalled()
})
