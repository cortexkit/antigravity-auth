export const VAULT_ROUTING_PURPOSE_HEADER =
  'x-antigravity-internal-request-purpose'

/** Only known agent turns positively identify primary work; unknown and maintenance agents stay out. */
export function createVaultRoutingHeaders(providerId: string) {
  return async (
    input: { agent: string; model: { providerID: string } },
    output: { headers: Record<string, string> },
  ) => {
    if (input.model.providerID !== providerId) return
    output.headers[VAULT_ROUTING_PURPOSE_HEADER] =
      input.agent === 'build' || input.agent === 'plan'
        ? 'primary'
        : 'auxiliary'
  }
}

export function isPrimaryVaultRequest(
  kind: string | undefined,
  headers?: HeadersInit,
): boolean {
  return kind === undefined
    ? new Headers(headers).get(VAULT_ROUTING_PURPOSE_HEADER) === 'primary'
    : kind === 'primary'
}
