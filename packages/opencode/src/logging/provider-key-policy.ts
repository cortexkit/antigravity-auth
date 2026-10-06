/**
 * Structured provider logs fully mask credential and account-correlating keys.
 * Event IDs and diagnostic fields are intentionally not classified as secrets.
 * The public logger supplies lowercase keys with hyphens/underscores removed.
 * Keeping this policy dependency-free lets the TUI use it without loading any
 * provider state, storage, debug streams or OAuth code.
 */
export function isProviderSecretKey(normalizedKey: string): boolean {
  return /token|refresh|access|project|fingerprint|deviceid|sessionid|sessiontoken|secret|password|apikey|clientsecret/.test(
    normalizedKey,
  )
}
