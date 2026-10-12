import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { relative } from 'node:path'

const originalOpen = fs.open
fs.open = async function (path, ...options) {
  const handle = await originalOpen.call(this, path, ...options)
  const originalSync = handle.sync.bind(handle)
  handle.sync = async () => {
    const event = {
      path: relative(process.env.PROBE_PROFILE, String(path)),
      flags: options[0],
    }
    try {
      await originalSync()
      event.outcome = 'ok'
    } catch (error) {
      event.outcome = 'error'
      event.code = error.code
      event.syscall = error.syscall
      event.stack = error.stack
      throw error
    } finally {
      await fs.appendFile(
        process.env.PROBE_SYNC_EVENTS,
        `${JSON.stringify(event)}\n`,
      )
    }
  }
  return handle
}
syncBuiltinESMExports()
globalThis.fetch = async () => {
  throw new Error('Offline migration regression forbids network requests')
}
