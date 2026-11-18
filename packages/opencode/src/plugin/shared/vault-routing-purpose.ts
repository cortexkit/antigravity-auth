export const VAULT_ROUTING_PURPOSE_HEADER =
  'x-antigravity-internal-request-purpose'

/**
 * OpenCode 1 sends no request kind, so its chat.headers hook marks the
 * purpose from the agent name: the host's `title` agent, the `build` and
 * `plan` turns, and everything else as auxiliary.
 */
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
