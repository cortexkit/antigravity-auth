import {
  type AntigravityTokenExchangeResult,
  persistAccountPoolAtPath,
} from '@cortexkit/antigravity-auth-core'
import { getStoragePath } from './storage'

export async function persistAccountPool(
  results: Extract<AntigravityTokenExchangeResult, { type: 'success' }>[],
  replaceAll = false,
): Promise<void> {
  await persistAccountPoolAtPath(getStoragePath(), results, replaceAll)
}
