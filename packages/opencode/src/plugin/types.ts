import type {
  AuthHook,
  AuthOAuthResult,
  Config,
  Hooks,
  PluginInput,
  ToolDefinition,
} from '@opencode-ai/plugin'
import type { Provider as SDKProvider } from '@opencode-ai/sdk'

export type {
  ApiKeyAuthDetails,
  AuthDetails,
  GetAuth,
  NonOAuthAuthDetails,
  OAuthAuthDetails,
  ProjectContextResult,
  RefreshParts,
} from '@cortexkit/antigravity-auth-core'

export type {
  AuthHook,
  AuthOAuthResult,
  Config,
  Hooks,
  PluginInput,
  ToolDefinition,
}

export type PluginClient = PluginInput['client']
export type PluginContext = PluginInput
export type PluginConfig = Config
export type PluginEventPayload = Parameters<NonNullable<Hooks['event']>>[0]
export type AuthMethod = AuthHook['methods'][number]
export type PluginTool = ToolDefinition

export type ProviderModel = {
  cost?: { input: number; output: number }
  [key: string]: unknown
}

export type Provider = SDKProvider

export interface LoaderResult {
  apiKey: string
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}

type RequiredAuthHook = AuthHook & {
  provider: string
  loader: NonNullable<AuthHook['loader']>
  methods: NonNullable<AuthHook['methods']>
}

export type PluginResult = {
  auth: RequiredAuthHook
  tool: Record<string, ToolDefinition>
  config: NonNullable<Hooks['config']>
  event: NonNullable<Hooks['event']>
  dispose: NonNullable<Hooks['dispose']>
  'command.execute.before': NonNullable<Hooks['command.execute.before']>
}
