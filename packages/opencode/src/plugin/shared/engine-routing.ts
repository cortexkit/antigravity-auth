import type { RequestRouting } from '@cortexkit/antigravity-auth-core/engine'
import { hasVaultHost } from '../../common-auth-embedded/claustrum/host.js'
import {
  askRouting,
  askRoutingUntilCapacity,
  reportRouting,
} from '../../common-auth-embedded/routing-accessor/index.js'

/** The bridge may arrive or disappear after plugin load; never cache its presence. */
export function hasVaultRoutingAccessor(): boolean {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

export const openCodeRouting: RequestRouting = {
  hasAccessor: hasVaultRoutingAccessor,
  hasVaultHost,
  ask: askRouting,
  askUntilCapacity: askRoutingUntilCapacity,
  report: reportRouting,
}
