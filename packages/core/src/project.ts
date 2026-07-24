import { fetchWithAgyCliTransport } from './agy-transport.ts'
import { formatRefreshParts, parseRefreshParts } from './auth.ts'
import type { OAuthAuthDetails, ProjectContextResult } from './auth-types.ts'
import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_LOAD_ENDPOINTS,
} from './constants.ts'
import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityLoadCodeAssistMetadata,
} from './fingerprint.ts'
import { createLogger } from './logger.ts'

const log = createLogger('project')

/** TTL for project context cache entries (30 minutes). */
const PROJECT_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000

interface CachedProjectContext {
  result: ProjectContextResult
  cachedAt: number
}

const projectContextResultCache = new Map<string, CachedProjectContext>()
const projectContextPendingCache = new Map<
  string,
  Promise<ProjectContextResult>
>()
const provisionFailedKeys = new Set<string>()
interface AntigravityUserTier {
  id?: string
  isDefault?: boolean
  userDefinedCloudaicompanionProject?: boolean
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: {
    id?: string
  }
  allowedTiers?: AntigravityUserTier[]
}

interface OnboardUserPayload {
  done?: boolean
  response?: {
    cloudaicompanionProject?: {
      id?: string
    }
  }
}

function buildBootstrapRequestBody(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    metadata: buildAntigravityLoadCodeAssistMetadata(),
  }
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(
  allowedTiers?: AntigravityUserTier[],
): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id
    }
  }
  return allowedTiers[0]?.id
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(
  payload: LoadCodeAssistPayload | null,
): string | undefined {
  if (!payload) {
    return undefined
  }
  if (typeof payload.cloudaicompanionProject === 'string') {
    return payload.cloudaicompanionProject
  }
  if (
    payload.cloudaicompanionProject &&
    typeof payload.cloudaicompanionProject.id === 'string'
  ) {
    return payload.cloudaicompanionProject.id
  }
  return undefined
}

/**
 * Generates a stable cache key from the OAuth refresh token itself. Packed
 * project fields may change after discovery, but they still identify the same
 * credential and must hit the same project-context cache entry.
 */
function getCacheKeyFromRefresh(
  refresh: string | undefined,
): string | undefined {
  const packedRefresh = refresh?.trim()
  if (!packedRefresh) return undefined
  return parseRefreshParts(packedRefresh).refreshToken.trim() || packedRefresh
}

function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  return getCacheKeyFromRefresh(auth.refresh)
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear()
    projectContextResultCache.clear()
    provisionFailedKeys.clear()
    return
  }
  const cacheKey = getCacheKeyFromRefresh(refresh)
  if (!cacheKey) return
  projectContextPendingCache.delete(cacheKey)
  projectContextResultCache.delete(cacheKey)
  provisionFailedKeys.delete(cacheKey)
}

export function clearProvisionFailedKeys(): void {
  provisionFailedKeys.clear()
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  _projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  const requestBody = buildBootstrapRequestBody()
  const loadHeaders = buildAntigravityHarnessBootstrapHeaders(accessToken)

  const loadEndpoints = Array.from(
    new Set<string>([
      ...ANTIGRAVITY_LOAD_ENDPOINTS,
      ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]),
  )

  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetchWithAgyCliTransport(
        `${baseEndpoint}/v1internal:loadCodeAssist`,
        {
          method: 'POST',
          headers: loadHeaders,
          body: JSON.stringify(requestBody),
        },
      )

      if (!response.ok) {
        continue
      }

      return (await response.json()) as LoadCodeAssistPayload
    } catch (error) {
      log.debug('Failed to load managed project', {
        endpoint: baseEndpoint,
        error: String(error),
      })
    }
  }

  return null
}

/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const requestBody: Record<string, unknown> = { tierId }
  const onboardEndpoints = Array.from(
    new Set<string>([
      ANTIGRAVITY_ENDPOINT_PROD,
      ...ANTIGRAVITY_LOAD_ENDPOINTS,
      ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]),
  )

  for (const baseEndpoint of onboardEndpoints) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchWithAgyCliTransport(
          `${baseEndpoint}/v1internal:onboardUser`,
          {
            method: 'POST',
            headers: buildAntigravityHarnessBootstrapHeaders(accessToken),
            body: JSON.stringify(requestBody),
          },
        )

        if (!response.ok) {
          log.debug('Onboard request failed', {
            endpoint: baseEndpoint,
            status: response.status,
            statusText: response.statusText,
          })
          break
        }

        const payload = (await response.json()) as OnboardUserPayload
        const managedProjectId = payload.response?.cloudaicompanionProject?.id
        if (payload.done && managedProjectId) {
          return managedProjectId
        }
        if (payload.done && projectId) {
          return projectId
        }
      } catch (error) {
        log.debug('Failed to onboard managed project', {
          endpoint: baseEndpoint,
          error: String(error),
        })
        break
      }

      await wait(delayMs)
    }
  }

  return undefined
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(
  auth: OAuthAuthDetails,
): Promise<ProjectContextResult> {
  const accessToken = auth.access
  if (!accessToken) {
    return { auth, effectiveProjectId: '' }
  }

  const cacheKey = getCacheKey(auth)
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < PROJECT_CONTEXT_CACHE_TTL_MS) {
      return cached.result
    }
    if (cached) {
      // Expired — evict stale entry
      projectContextResultCache.delete(cacheKey)
    }
    const pending = projectContextPendingCache.get(cacheKey)
    if (pending) {
      return pending
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh)
    if (parts.managedProjectId) {
      return { auth, effectiveProjectId: parts.managedProjectId }
    }

    const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID

    if (cacheKey && provisionFailedKeys.has(cacheKey)) {
      const effectiveProjectId = parts.projectId || fallbackProjectId
      return { auth, effectiveProjectId }
    }

    const persistManagedProject = async (
      managedProjectId: string,
    ): Promise<ProjectContextResult> => {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      }

      return { auth: updatedAuth, effectiveProjectId: managedProjectId }
    }

    // Try to resolve a managed project from Antigravity if possible.
    const loadPayload = await loadManagedProject(
      accessToken,
      parts.projectId ?? fallbackProjectId,
    )
    const resolvedManagedProjectId = extractManagedProjectId(loadPayload)

    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId)
    }

    // No managed project found - try to auto-provision one via onboarding.
    // This handles accounts that were added before managed project provisioning was required.
    const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? 'free-tier'
    log.debug('Auto-provisioning managed project', {
      tierId,
      projectId: parts.projectId,
    })

    const provisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      parts.projectId,
    )

    if (provisionedProjectId) {
      log.debug('Successfully provisioned managed project', {
        provisionedProjectId,
      })
      return persistManagedProject(provisionedProjectId)
    }

    log.warn(
      'Failed to provision managed project - account may not work correctly',
      {
        hasProjectId: !!parts.projectId,
      },
    )

    if (cacheKey) {
      provisionFailedKeys.add(cacheKey)
    }

    if (parts.projectId) {
      return { auth, effectiveProjectId: parts.projectId }
    }

    // No project id present in auth; fall back to the hardcoded id for requests.
    return { auth, effectiveProjectId: fallbackProjectId }
  }

  if (!cacheKey) {
    return resolveContext()
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey
      projectContextPendingCache.delete(cacheKey)
      projectContextResultCache.set(nextKey, { result, cachedAt: Date.now() })
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey)
      }
      return result
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey)
      throw error
    })

  projectContextPendingCache.set(cacheKey, promise)
  return promise
}
