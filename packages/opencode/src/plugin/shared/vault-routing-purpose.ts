export const VAULT_ROUTING_PURPOSE_HEADER =
  'x-antigravity-internal-request-purpose'

/** The legacy host passes the title agent's name through its chat.headers hook. */
export function createVaultRoutingHeaders(providerId: string) {
  return async (
    input: { agent: string; model: { providerID: string } },
    output: { headers: Record<string, string> },
  ) => {
    if (input.model.providerID !== providerId) return
    output.headers[VAULT_ROUTING_PURPOSE_HEADER] =
      input.agent === 'title'
        ? 'title'
        : input.agent === 'build' || input.agent === 'plan'
          ? 'primary'
          : 'auxiliary'
  }
}

export function isTitleVaultRequest(
  kind: string | undefined,
  headers?: HeadersInit,
): boolean {
  return kind === undefined
    ? new Headers(headers).get(VAULT_ROUTING_PURPOSE_HEADER) === 'title'
    : kind === 'title'
}
