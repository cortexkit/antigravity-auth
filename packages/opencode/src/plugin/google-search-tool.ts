import { tool } from '@opencode-ai/plugin'
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './auth'
import { createLogger } from './logger'
import { executeSearch } from './search'
import { refreshAccessToken } from './token'
import type { GetAuth, PluginClient, PluginTool } from './types'

const log = createLogger('plugin')

type GoogleSearchAuthLoader = () => Promise<
  Awaited<ReturnType<GetAuth>> | null | undefined
>

export function createGoogleSearchTool({
  getAuth,
  client,
  providerId,
}: {
  getAuth: GoogleSearchAuthLoader
  client: PluginClient
  providerId: string
}): PluginTool {
  return tool({
    description:
      "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema
        .string()
        .describe('The search query or question to answer using web search'),
      urls: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
          'List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here.',
        ),
      thinking: tool.schema
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Enable deep thinking for more thorough analysis (default: true)',
        ),
    },
    async execute(args, ctx) {
      log.debug('Google Search tool called', {
        query: args.query,
        urlCount: args.urls?.length ?? 0,
      })

      const auth = await getAuth()
      if (!auth || !isOAuthAuth(auth)) {
        return 'Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.'
      }

      const parts = parseRefreshParts(auth.refresh)
      const projectId = parts.managedProjectId || parts.projectId || 'unknown'

      let accessToken = auth.access
      if (!accessToken || accessTokenExpired(auth)) {
        try {
          const refreshed = await refreshAccessToken(auth, client, providerId)
          accessToken = refreshed?.access
        } catch (error) {
          return `Error: Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      if (!accessToken) {
        return 'Error: No valid access token available. Please run `opencode auth login` to re-authenticate.'
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking,
        },
        accessToken,
        projectId,
        ctx.abort,
      )
    },
  })
}
