// Harness-agnostic auth/credential types shared by core and harness packages.

export interface OAuthAuthDetails {
  type: 'oauth'
  refresh: string
  access?: string
  expires?: number
}

export interface ApiKeyAuthDetails {
  type: 'api_key'
  key: string
}

export interface NonOAuthAuthDetails {
  type: string
  [key: string]: unknown
}

export type AuthDetails =
  | OAuthAuthDetails
  | ApiKeyAuthDetails
  | NonOAuthAuthDetails

export type GetAuth = () => Promise<AuthDetails>

export interface RefreshParts {
  refreshToken: string
  projectId?: string
  managedProjectId?: string
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails
  effectiveProjectId: string
}
