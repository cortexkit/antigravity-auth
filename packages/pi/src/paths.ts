import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function getPiConfigDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

export function getPiAntigravityAuthFile(): string {
  return (
    process.env.PI_ANTIGRAVITY_AUTH_FILE?.trim() ||
    join(getPiConfigDir(), 'antigravity-accounts.json')
  )
}

/**
 * Directory for Pi's Claustrum vault files (enrollment token and ceremony
 * state, the vault roster, the custody mode file). It sits next to the
 * account file in its own subdirectory so common-auth can restrict
 * its permissions without changing Pi's configuration directory.
 */
export function getPiAntigravityVaultDir(): string {
  return join(dirname(getPiAntigravityAuthFile()), 'antigravity-auth-vault')
}

/** Non-secret settings file selecting local or vault credentials for Pi requests. */
export function getPiAntigravityVaultModeFile(): string {
  return join(getPiAntigravityVaultDir(), 'pi-mode.json')
}

/** List of vault accounts Pi may use; contains account references, never tokens. */
export function getPiAntigravityVaultRosterFile(): string {
  return join(getPiAntigravityVaultDir(), 'pi-roster.json')
}
