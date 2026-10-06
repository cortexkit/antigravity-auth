import { discoverPortFile as discoverPublicPortFile } from '../common-auth-embedded/rpc/client.js'

export type { PortFileEntry } from '../common-auth-embedded/rpc/client.js'

// Discovery is read-only with respect to directory modes. Only the server
// writer hardens its directory; a client must never choose another live PID.
export function discoverPortFile(dir: string, expectedPid?: number) {
  return discoverPublicPortFile(dir, expectedPid, { exactPid: true })
}
