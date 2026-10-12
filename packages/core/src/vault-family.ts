export type AntigravityVaultHost = 'opencode' | 'pi'

export const ANTIGRAVITY_VAULT_FAMILY = Object.freeze({
  refreshAdapter: 'antigravity',
  category: 'antigravity-native',
  apiKeys: false,
} as const)

export const ANTIGRAVITY_VAULT_REQUIRE_ASSERTION = true as const

export type AntigravityVaultEnrollmentName =
  `antigravity-auth-${AntigravityVaultHost}`

export const ANTIGRAVITY_VAULT_ENROLLMENT_NAMES: Readonly<
  Record<AntigravityVaultHost, AntigravityVaultEnrollmentName>
> = Object.freeze({
  opencode: 'antigravity-auth-opencode',
  pi: 'antigravity-auth-pi',
})

function assertNeverHost(host: never): never {
  throw new TypeError(`Unsupported Antigravity vault host: ${String(host)}`)
}

export function getAntigravityVaultEnrollmentName(
  host: AntigravityVaultHost,
): AntigravityVaultEnrollmentName {
  switch (host) {
    case 'opencode':
      return ANTIGRAVITY_VAULT_ENROLLMENT_NAMES.opencode
    case 'pi':
      return ANTIGRAVITY_VAULT_ENROLLMENT_NAMES.pi
    default:
      return assertNeverHost(host)
  }
}
