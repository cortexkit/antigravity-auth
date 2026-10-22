import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { OPENCODE_VAULT_ENROLLMENT_NAME } from '../vault-custody'

type FrameHeader = {
  channel: number
  epoch: number
  corr: unknown
}

export function expectedInsulaReset(
  insulaRoute: boolean,
  switchingToLocal: boolean,
  code: unknown,
): boolean {
  return insulaRoute && switchingToLocal && code === 'ECONNRESET'
}

/** A loopback vault using the installed client's wire protocol and real enrollment flow. */
export async function startMenuVaultFixture(
  root: string,
  credential?: { accessToken: string; projectId: string },
  options: { unsupportedEnrollment?: boolean } = {},
) {
  // Node needs --experimental-import-meta-resolve to honor the client as the parent.
  const clientEntry =
    typeof Bun === 'undefined'
      ? import.meta.resolve('@cortexkit/claustrum-client')
      : Bun.resolveSync('@cortexkit/claustrum-client', import.meta.dir)
  const subc = await import(
    typeof Bun === 'undefined'
      ? import.meta.resolve('@cortexkit/subc-client', clientEntry)
      : Bun.resolveSync('@cortexkit/subc-client', dirname(clientEntry))
  )
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)
  const token = 'ab'.repeat(32)
  const sockets = new Set<Socket>()
  const usageSockets = new Set<Socket>()
  const usage = { watches: 0, closedWatches: 0, cancels: 0, resets: 0 }
  let switchingToLocal = false
  const errors: string[] = []
  const calls: string[] = []
  let approved = false
  let requestSecretHash: unknown
  const respond = (
    socket: Socket,
    header: FrameHeader,
    body: unknown,
    type: number = subc.FrameType.Response,
  ) => {
    socket.write(
      Buffer.from(
        subc.encodeFrame(
          subc.buildFrame(
            type,
            subc.buildFlags(false, subc.Priority.Interactive, false),
            header.channel,
            header.epoch,
            header.corr,
            new TextEncoder().encode(JSON.stringify(body)),
          ),
        ),
      ),
    )
  }
  const handle = (
    method: string | undefined,
    params: Record<string, unknown>,
    insulaRoute: boolean,
  ) => {
    if (method) calls.push(method)
    if (
      method === 'auth.enroll_propose' &&
      params.proposed_name === OPENCODE_VAULT_ENROLLMENT_NAME
    ) {
      requestSecretHash = params.request_secret_hash
      return { result: { request_id: 'synthetic-menu-request' } }
    }
    if (
      method === 'auth.enroll_poll' &&
      params.request_id === 'synthetic-menu-request'
    ) {
      if (
        typeof params.request_secret !== 'string' ||
        createHash('sha256')
          .update(Buffer.from(params.request_secret, 'hex'))
          .digest('hex') !== requestSecretHash
      ) {
        errors.push('Enrollment poll did not prove the request secret')
        return { error: { code: 'invalid_request_secret', class: 'permanent' } }
      }
      return {
        result: {
          status: approved ? 'approved' : 'pending',
          name: OPENCODE_VAULT_ENROLLMENT_NAME,
          token,
          token_generation: 1,
        },
      }
    }
    if (
      method === 'credential.list_scoped' &&
      params.enrollment_token === token
    )
      return {
        result: {
          view: 'synthetic-menu-view',
          credentials: [
            {
              id: 'synthetic-vault-credential',
              type: 'oauth',
              state: 'active',
              record_version: 1,
              categories: ['antigravity-native'],
              serves: ['google'],
              provider_ids: ['google'],
              operations: ['read'],
              refresh_adapter: 'antigravity',
              account_id: 'synthetic-vault-account',
            },
          ],
        },
      }
    if (method === 'auth.watch_scoped' && params.enrollment_token === token)
      // This fixture models an older vault server: reject watches so the
      // client confirms the roster and falls back to its polling interval.
      return { error: { code: 'unknown_method', class: 'permanent' } }
    if (insulaRoute && method === 'usage.get')
      return { result: [], completeProviders: ['antigravity'] }
    if (
      method === 'credential.get_scoped' &&
      params.enrollment_token === token &&
      params.credential_id === 'synthetic-vault-credential'
    )
      return {
        result: {
          // Callers may supply the served credential; otherwise a fixed
          // synthetic one is served.
          payload: Array.from(
            new TextEncoder().encode(
              credential?.accessToken ?? 'synthetic-vault-access',
            ),
          ),
          credential_id: 'synthetic-vault-credential',
          project_id: credential?.projectId ?? 'synthetic-vault-project',
          account_id: 'synthetic-vault-account',
          record_version: 1,
          expires_at_ms: Date.now() + 3_600_000,
        },
      }
    errors.push(`Unexpected vault method: ${method}`)
    return { error: { code: 'unexpected_method', class: 'permanent' } }
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    let insulaRoute = false
    let watchingUsage = false
    socket.once('close', () => {
      sockets.delete(socket)
      usageSockets.delete(socket)
      if (watchingUsage) usage.closedWatches++
    })
    socket.on('error', (error) => {
      // Stopping the consumer on a custody switch cancels its private usage
      // connections. No other route, error code or lifecycle permits a reset.
      if (
        expectedInsulaReset(
          insulaRoute,
          switchingToLocal,
          (error as NodeJS.ErrnoException).code,
        )
      )
        usage.resets++
      else errors.push(error.message)
    })
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let routeChannel: number | undefined
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        for (;;) {
          if (phase !== 'frames') {
            if (buffer.length < 4) return
            const length = buffer.readUInt32LE(0)
            if (length > 1048576) throw new Error('Oversized vault handshake')
            if (buffer.length < 4 + length) return
            const body = JSON.parse(
              buffer.subarray(4, 4 + length).toString(),
            ) as {
              client_nonce: number[]
            }
            buffer = buffer.subarray(4 + length)
            if (phase === 'hello') {
              const serverNonce = Uint8Array.from(
                { length: 32 },
                (_, index) => 100 + index,
              )
              const reply = Buffer.from(
                JSON.stringify({
                  daemon_id: Array.from(daemonId),
                  server_nonce: Array.from(serverNonce),
                  daemon_ver: 'synthetic-menu-vault',
                  server_proof: Array.from(
                    subc.computeProof(
                      key,
                      subc.SERVER_PROOF_DOMAIN,
                      Uint8Array.from(body.client_nonce),
                      serverNonce,
                      daemonId,
                    ),
                  ),
                }),
              )
              const prefix = Buffer.alloc(4)
              prefix.writeUInt32LE(reply.length)
              socket.write(Buffer.concat([prefix, reply]))
              phase = 'auth'
            } else {
              phase = 'frames'
            }
            continue
          }
          if (buffer.length < subc.HEADER_LEN) return
          const header = subc.decodeHeader(buffer.subarray(0, subc.HEADER_LEN))
          if (header.len > 1048576) throw new Error('Oversized vault frame')
          if (buffer.length < subc.HEADER_LEN + header.len) return
          const body = buffer.subarray(
            subc.HEADER_LEN,
            subc.HEADER_LEN + header.len,
          )
          buffer = buffer.subarray(subc.HEADER_LEN + header.len)
          if (header.ty === subc.FrameType.Cancel && insulaRoute)
            usage.cancels++
          if (header.ty !== subc.FrameType.Request) continue
          const request = JSON.parse(body.toString()) as {
            op?: string
            method?: string
            params?: Record<string, unknown>
            target?: { kind?: string; module_id?: string }
          }
          if (header.channel === 0) {
            if (request.op === 'route.open') {
              routeChannel = 7
              insulaRoute =
                request.target?.kind === 'management_surface' &&
                request.target.module_id === 'insula'
              if (insulaRoute) usageSockets.add(socket)
            }
            respond(socket, header, { route_channel: 7, route_epoch: 1 })
            continue
          }
          if (header.channel !== routeChannel) {
            respond(
              socket,
              header,
              { code: 'unknown_channel' },
              subc.FrameType.Error,
            )
            continue
          }
          if (insulaRoute && request.method === 'usage.watch') {
            calls.push(request.method)
            watchingUsage = true
            usage.watches++
            // Keep the stream open so the switch test must observe the client's
            // cancellation, rather than a server-ended or never-opened watch.
            respond(
              socket,
              header,
              { kind: 'changed', epoch: 'owned-usage', seq: 1 },
              subc.FrameType.StreamData,
            )
            continue
          }
          if (
            options.unsupportedEnrollment &&
            request.method?.startsWith('auth.enroll_')
          ) {
            if (request.method) calls.push(request.method)
            respond(
              socket,
              header,
              { code: 'unknown_method', class: 'permanent' },
              subc.FrameType.Error,
            )
            continue
          }
          respond(
            socket,
            header,
            handle(request.method, request.params ?? {}, insulaRoute),
          )
        }
      } catch (error) {
        errors.push(String(error))
        socket.destroy()
      }
    })
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Vault fixture has no TCP address')
  const connectionFile = join(root, 'claustrum-connection.json')
  writeFileSync(
    connectionFile,
    JSON.stringify({
      schema: 1,
      wire_version: subc.PROTOCOL_VERSION,
      endpoints: [{ host: '127.0.0.1', port: address.port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'synthetic-menu-vault',
    }),
    { mode: 0o600 },
  )
  return {
    connectionFile,
    calls,
    errors,
    usage,
    get activeUsageConnections() {
      return usageSockets.size
    },
    expectUsageCancellation() {
      switchingToLocal = true
    },
    async waitForUsage(watching: boolean) {
      const deadline = Date.now() + 3_000
      while (watching ? usage.watches === 0 : usageSockets.size > 0) {
        if (Date.now() >= deadline)
          throw new Error(
            'Usage connection did not reach the expected lifecycle state',
          )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    approve() {
      approved = true
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      )
    },
  }
}
