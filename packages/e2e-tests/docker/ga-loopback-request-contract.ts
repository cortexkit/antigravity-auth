// Only dispatch-affecting fields belong here. Session ownership and response
// adaptation are separate contracts; they must not broaden this URL predicate.
export const GA_LOOPBACK_REQUEST_CONTRACT = Object.freeze({
  hook: 'http.request',
  providerID: 'google',
  pathnamePredicate:
    '^/[^?#]*/models/[^/:]+:(generateContent|streamGenerateContent)$',
  method: 'POST',
  urlPattern: 'http://127.0.0.1:<port>/agy/<job>',
  headers: Object.freeze({
    copied: Object.freeze([] as string[]),
    dropped: 'all original headers',
    replaced: Object.freeze({ 'content-type': 'application/json' }),
  }),
  bodyKind: 'empty JSON object',
  body: '{}',
})

export function matchesGoogleContentPath(pathname: string): boolean {
  return new RegExp(GA_LOOPBACK_REQUEST_CONTRACT.pathnamePredicate).test(
    pathname,
  )
}

export async function normalizedRewrite(request: Request) {
  const url = new URL(request.url)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    !/^\/agy\/[0-9a-f-]{36}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('rewrite is not a loopback job URL')
  return {
    hook: 'http.request',
    method: request.method,
    urlPattern: 'http://127.0.0.1:<port>/agy/<job>',
    headers: Object.fromEntries(request.headers),
    body: await request.clone().text(),
  }
}

export async function assertRewriteConformance(
  request: Request,
): Promise<void> {
  const actual = await normalizedRewrite(request)
  if (
    actual.method !== GA_LOOPBACK_REQUEST_CONTRACT.method ||
    actual.body !== GA_LOOPBACK_REQUEST_CONTRACT.body ||
    JSON.stringify(actual.headers) !==
      JSON.stringify(GA_LOOPBACK_REQUEST_CONTRACT.headers.replaced)
  )
    throw new Error(
      'dispatch fields differ from the measured loopback contract',
    )
}
