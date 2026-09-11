import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type AccountSelectionStrategy,
  acquireFencedFileLock,
  writeJsonAtomic,
} from '@cortexkit/antigravity-auth-core'

export interface PiRoutingSettings {
  account_selection_strategy: AccountSelectionStrategy
  pid_offset_enabled: boolean
}

export function isStrategy(value: unknown): value is AccountSelectionStrategy {
  return value === 'sticky' || value === 'hybrid' || value === 'round-robin'
}

export async function readSettings(path: string): Promise<PiRoutingSettings> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { account_selection_strategy: 'hybrid', pid_offset_enabled: true }
    }
    throw new Error(
      'Cannot read Pi Antigravity routing settings; repair the settings file',
    )
  }
  if (!value || typeof value !== 'object')
    throw new Error('Invalid Pi Antigravity settings')
  const config = value as Record<string, unknown>
  const strategy = config.account_selection_strategy ?? 'hybrid'
  const offset = config.pid_offset_enabled ?? true
  if (!isStrategy(strategy) || typeof offset !== 'boolean') {
    throw new Error('Invalid Pi Antigravity routing strategy or PID offset')
  }
  return { account_selection_strategy: strategy, pid_offset_enabled: offset }
}

export async function writeStrategy(
  path: string,
  strategy: AccountSelectionStrategy,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const lock = await acquireFencedFileLock({
    path,
    name: 'pi-routing',
    ttlMs: 10_000,
    renew: true,
  })
  if (!lock)
    throw new Error('Pi Antigravity settings are busy; retry the command')
  try {
    const config = await readSettings(path)
    config.account_selection_strategy = strategy
    await lock.assertOwned()
    await writeJsonAtomic(path, config)
  } finally {
    await lock.release()
  }
}
