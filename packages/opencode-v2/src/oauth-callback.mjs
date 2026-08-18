// Loopback OAuth callback listener for the Antigravity login flow.
// Google redirects to http://localhost:51121/oauth-callback (the redirect URI
// registered for the Antigravity OAuth client), so the port is fixed.

import { createServer } from 'node:http'

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/oauth-callback'
const CALLBACK_PORT = 51121
const CALLBACK_TIMEOUT_MS = 10 * 60_000

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Antigravity login complete</title>
<body style="font-family:system-ui;padding:2rem"><h2>Login complete</h2><p>The account was added to OpenCode. You can close this tab.</p></body>`
const PAGE_FAIL = `<!doctype html><meta charset="utf-8"><title>Antigravity login failed</title>
<body style="font-family:system-ui;padding:2rem"><h2>Login failed</h2><p>Return to OpenCode and try again.</p></body>`

function respond(response, status, page) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-type': 'text/html; charset=utf-8',
  })
  response.end(page)
}

/**
 * Starts listening immediately and resolves with the authorization code once
 * Google redirects back with the matching state.
 */
export function waitForAntigravityCode(expectedState, options = {}) {
  if (!expectedState) throw new Error('OAuth state is empty')
  const port = options.port ?? CALLBACK_PORT
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let settled = false
    let timer

    const server = createServer((request, response) => {
      let url
      try {
        url = new URL(request.url ?? '/', `http://${CALLBACK_HOST}:${port}`)
      } catch {
        respond(response, 400, PAGE_FAIL)
        return
      }
      if (url.pathname !== CALLBACK_PATH) {
        respond(response, 404, PAGE_FAIL)
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        respond(response, 400, PAGE_FAIL)
        return
      }
      if (url.searchParams.has('error')) {
        respond(response, 400, PAGE_FAIL)
        finish(
          undefined,
          new Error(
            `Google authorization failed: ${url.searchParams.get('error')}`,
          ),
        )
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        respond(response, 400, PAGE_FAIL)
        return
      }
      respond(response, 200, PAGE_OK)
      finish(code)
    })

    function finish(code, error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close(() => {})
      if (error) reject(error)
      else resolve(code)
    }

    server.once('error', (error) => finish(undefined, error))
    server.listen(port, CALLBACK_HOST, () => {
      timer = setTimeout(
        () =>
          finish(undefined, new Error('Antigravity authorization timed out')),
        timeoutMs,
      )
    })
  })
}
