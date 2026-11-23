/**
 * Only the default HTTPS Google origin supports Antigravity request preparation.
 * The OpenCode 2 hook shares this check to reject custom origins before bridging
 * a request into the account pool's credential and transport pipeline.
 */
export function isCanonicalGoogleOrigin(url: string): boolean {
  try {
    return new URL(url).origin === 'https://generativelanguage.googleapis.com'
  } catch {
    return false
  }
}
