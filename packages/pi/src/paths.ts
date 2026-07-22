import { homedir } from 'node:os'
import { join } from 'node:path'

export function getPiConfigDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

export function getPiAntigravityAuthFile(): string {
  return (
    process.env.PI_ANTIGRAVITY_AUTH_FILE?.trim() ||
    join(getPiConfigDir(), 'antigravity-accounts.json')
  )
}
