import {
  type AntigravityRequestExecutor,
  createRequestExecutor as createEngineExecutor,
  type RequestServicesDeps as EngineDeps,
  type RequestAccountRow,
} from '@cortexkit/antigravity-auth-core/engine'
import { noteGeminiDumpResponse } from '../gemini-dump'
import { AUTH_COMMAND } from '../request-helper-effects'
import { extractOpenCodeSessionIdentity } from '../session-context'
import { openCodeRouting } from './engine-routing'
import { isTitleVaultRequest } from './vault-routing-purpose'

export type RequestServicesDeps<A extends RequestAccountRow> = Omit<
  EngineDeps<A>,
  'readSession' | 'isTitleRoutingRequest' | 'routing' | 'authCommand' | 'dump'
> & {
  readonly dump: Pick<EngineDeps<A>['dump'], 'dumpRequest'>
}

/** Supplies the host bindings shared by the fetch interceptor and loopback bridge. */
export function createRequestExecutor<A extends RequestAccountRow>(
  deps: RequestServicesDeps<A>,
): AntigravityRequestExecutor {
  return createEngineExecutor({
    ...deps,
    readSession: extractOpenCodeSessionIdentity,
    isTitleRoutingRequest: isTitleVaultRequest,
    routing: openCodeRouting,
    authCommand: AUTH_COMMAND,
    dump: {
      dumpRequest: (input) => deps.dump.dumpRequest(input),
      noteResponse: noteGeminiDumpResponse,
    },
  })
}
