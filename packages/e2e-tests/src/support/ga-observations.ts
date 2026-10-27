import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import {
  assertCompleteGaInventory,
  assertGaNoDirectProvider,
  type GaCaseId,
  ownedPath,
} from '../opencode-ga-harness.ts'

export interface GaCaseObservation {
  id: GaCaseId
  state: 'source-prepared' | 'runtime-verified'
  nonce: string
  databaseFile: string
  evidenceFiles: string[]
  primaryRequests: number
  directProviderRequests: number
  elapsedMs: number
}

// Synthetic observation controls are separate from the native driver's
// GaScenarioResult gate; passing these controls is not a native-host result.
export function assertGaObservations(
  root: string,
  observations: readonly GaCaseObservation[],
): void {
  assertCompleteGaInventory(observations.map((observation) => observation.id))
  const nonces = new Set<string>()
  for (const observation of observations) {
    assert(
      observation.state === 'runtime-verified',
      `Source-prepared is not runtime-verified: ${observation.id}`,
    )
    assert(
      /^[a-f0-9]{32}$/.test(observation.nonce) &&
        !nonces.has(observation.nonce),
      `Missing or reused scenario nonce: ${observation.id}`,
    )
    nonces.add(observation.nonce)
    assertGaNoDirectProvider(observation.id, observation.directProviderRequests)
    assert(
      Number.isInteger(observation.primaryRequests) &&
        observation.primaryRequests >= 0,
      `Missing primary request observation: ${observation.id}`,
    )
    assert(
      Number.isFinite(observation.elapsedMs) &&
        observation.elapsedMs > 0 &&
        observation.elapsedMs <= 60_000,
      `Missing or late scenario observation: ${observation.id}`,
    )
    const database = ownedPath(root, observation.databaseFile)
    assert(
      existsSync(database) &&
        statSync(database).isFile() &&
        statSync(database).size > 0,
      `Missing actual scenario DB: ${observation.id}`,
    )
    assert(
      observation.evidenceFiles.length > 0 &&
        new Set(observation.evidenceFiles).size ===
          observation.evidenceFiles.length,
      `Missing actual scenario observations: ${observation.id}`,
    )
    for (const path of observation.evidenceFiles) {
      ownedPath(root, path)
      assert(
        statSync(path).isFile() && statSync(path).size > 0,
        `Empty scenario evidence: ${observation.id}`,
      )
    }
  }
}
