import type { GetAuth } from '@cortexkit/antigravity-auth-core'
import type { PluginInput } from '@opencode-ai/plugin'
import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'

export type {
  ApiKeyAuthDetails,
  AuthDetails,
  GetAuth,
  NonOAuthAuthDetails,
  OAuthAuthDetails,
  ProjectContextResult,
  RefreshParts,
} from '@cortexkit/antigravity-auth-core'

export interface ProviderModel {
  cost?: {
    input: number
    output: number
  }
  [key: string]: unknown
}

export interface Provider {
  models?: Record<string, ProviderModel>
}

export interface LoaderResult {
  apiKey: string
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}

export type PluginClient = PluginInput['client']

export interface PluginContext {
  client: PluginClient
  directory: string
}

export type AuthPrompt =
  | {
      type: 'text'
      key: string
      message: string
      placeholder?: string
      validate?: (value: string) => string | undefined
      condition?: (inputs: Record<string, string>) => boolean
    }
  | {
      type: 'select'
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      condition?: (inputs: Record<string, string>) => boolean
    }

export type OAuthAuthorizationResult = { url: string; instructions: string } & (
  | {
      method: 'auto'
      callback: () => Promise<AntigravityTokenExchangeResult>
    }
  | {
      method: 'code'
      callback: (code: string) => Promise<AntigravityTokenExchangeResult>
    }
)

export interface AuthMethod {
  provider?: string
  label: string
  type: 'oauth' | 'api'
  prompts?: AuthPrompt[]
  authorize?: (
    inputs?: Record<string, string>,
  ) => Promise<OAuthAuthorizationResult>
}

export interface PluginEventPayload {
  event: {
    type: string
    properties?: unknown
  }
}

export interface PluginResult {
  config?: (input: Record<string, unknown>) => Promise<void> | void
  'command.execute.before'?: (input: {
    command: string
    arguments: string
    sessionID: string
  }) => Promise<void> | void
  auth: {
    provider: string
    loader: (
      getAuth: GetAuth,
      provider: Provider,
    ) => Promise<LoaderResult | Record<string, unknown>>
    methods: AuthMethod[]
  }
  event?: (payload: PluginEventPayload) => void
  tool?: Record<string, unknown>
}
