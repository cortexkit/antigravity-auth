import { describe, expect, it } from 'bun:test'

import * as core from '@cortexkit/antigravity-auth-core'

import * as oauthShim from '../antigravity/oauth'
import * as constantsShim from '../constants'
import * as accountsAdapter from './accounts'
import * as requestMetadataShim from './agy-request-metadata'
import * as transportShim from './agy-transport'
import * as authShim from './auth'
import * as fingerprintShim from './fingerprint'
import * as modelRegistryShim from './model-registry'
import * as projectShim from './project'
import * as quotaAdapter from './quota'
import * as rotationShim from './rotation'
import * as crossModelShim from './transform/cross-model-sanitizer'
import * as transformShim from './transform/index'
import * as modelResolverShim from './transform/model-resolver'
import * as transformTypesShim from './transform/types'
import * as versionShim from './version'

describe('core compatibility re-exports', () => {
  const representativeExports = [
    [constantsShim.ANTIGRAVITY_PROVIDER_ID, core.ANTIGRAVITY_PROVIDER_ID],
    [oauthShim.authorizeAntigravity, core.authorizeAntigravity],
    [
      requestMetadataShim.buildAgyAgentRequestMetadata,
      core.buildAgyAgentRequestMetadata,
    ],
    [transportShim.fetchWithAgyCliTransport, core.fetchWithAgyCliTransport],
    [authShim.accessTokenExpired, core.accessTokenExpired],
    [fingerprintShim.generateFingerprint, core.generateFingerprint],
    [
      modelRegistryShim.OPENCODE_MODEL_DEFINITIONS,
      core.OPENCODE_MODEL_DEFINITIONS,
    ],
    [projectShim.ensureProjectContext, core.ensureProjectContext],
    [rotationShim.calculateBackoffMs, core.calculateBackoffMs],
    [crossModelShim.sanitizeCrossModelPayload, core.sanitizeCrossModelPayload],
    [transformShim.resolveModelWithTier, core.resolveModelWithTier],
    [modelResolverShim.resolveModelWithTier, core.resolveModelWithTier],
    [transformTypesShim.resolveModelWithTier, core.resolveModelWithTier],
    [versionShim.initAntigravityVersion, core.initAntigravityVersion],
  ] as const

  it.each(
    representativeExports,
  )('keeps compatibility path %# bound to its canonical core export', (compatibilityExport, canonicalExport) => {
    expect(compatibilityExport).toBe(canonicalExport)
  })

  it('keeps the accounts adapter based on the core account manager', () => {
    expect(
      Object.getPrototypeOf(accountsAdapter.AccountManager.prototype),
    ).toBe(core.AccountManager.prototype)
    expect(accountsAdapter.resolveQuotaGroup).toBe(core.resolveQuotaGroup)
  })

  it('keeps quota core exports alongside the OpenCode adapter', () => {
    expect(quotaAdapter.createQuotaManager).toBe(core.createQuotaManager)
    expect(quotaAdapter.defaultKeyOf).toBe(core.defaultKeyOf)
    expect(typeof quotaAdapter.createOpenCodeQuotaManager).toBe('function')
  })
})
