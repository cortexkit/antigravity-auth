import { debugLogToFile } from '../../plugin/debug'

const AUTO_UPDATE_LOG_PREFIX = '[auto-update-checker]'

export function formatAutoUpdateLogMessage(message: string): string {
  return `${AUTO_UPDATE_LOG_PREFIX} ${message}`
}

export function logAutoUpdate(message: string): void {
  debugLogToFile(formatAutoUpdateLogMessage(message))
}
