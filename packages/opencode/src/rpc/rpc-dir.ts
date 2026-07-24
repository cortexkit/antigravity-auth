import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const RPC_DIR_ENV = 'ANTIGRAVITY_AUTH_RPC_DIR'

// Both processes must resolve the SAME dir from the SAME project directory.
export function getRpcDir(projectDirectory: string): string {
  const override = process.env[RPC_DIR_ENV]?.trim()
  if (override) {
    return isAbsolute(override) ? override : resolve(projectDirectory, override)
  }

  const projectHash = createHash('sha256')
    .update(resolve(projectDirectory))
    .digest('hex')
    .slice(0, 16)
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')

  return join(stateHome, 'cortexkit', 'antigravity-auth', 'rpc', projectHash)
}

export { tmpdir }
