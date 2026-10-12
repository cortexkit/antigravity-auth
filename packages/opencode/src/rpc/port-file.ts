import { discoverPortFile as discoverPublicPortFile } from '../common-auth-embedded/rpc/client.js'

export type { PortFileEntry } from '../common-auth-embedded/rpc/client.js'

// Discovery reads directory modes without changing them. Only the server writer
// changes directory permissions; clients discover only the expected PID.
export function discoverPortFile(dir: string, expectedPid?: number) {
  return discoverPublicPortFile(dir, expectedPid, { exactPid: true })
}
