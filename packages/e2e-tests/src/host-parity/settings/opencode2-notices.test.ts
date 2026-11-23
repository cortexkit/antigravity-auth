import { expect, test } from 'bun:test'
import { loadCommonAuthCommands } from '@cortexkit/antigravity-auth-core'
import { placeholderSecret } from '../../../../opencode/src/common-auth-embedded/opencode2/index.js'
import {
  createGaRpcActivation,
  GaRequestOwnership,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from '../../../../opencode/src/ga/server/index.ts'
import {
  createGaRouteBook,
  createGaVaultRequestPipeline,
} from '../../../../opencode/src/plugin/ga-location-services.ts'
import { createVaultAccountPool } from '../../../../opencode/src/plugin/shared/vault-request-credentials.ts'
import { Environment } from '../environment.ts'
import { credential } from '../fixtures.ts'
import { google2 } from '../native-google.ts'
import { openCode2, route } from '../open-code.ts'
import { responseScenarios } from '../scenarios.ts'

const { input, replies } = responseScenarios.find(
  ({ input }) => input.id === 'lasting 403',
)!
const sessionID = 'notice-session'
const scope = { kind: 'session', sessionID } as const
const verificationNotice = {
  command: 'antigravity',
  notify: {
    message:
      "An Antigravity account needs verification. Run 'opencode auth login' and use Verify accounts.",
    kind: 'warning',
  },
} as const

async function notices(
  quiet: boolean,
  toastScope: 'root_only' | 'all',
  parentID?: string,
) {
  const environment = new Environment(() => replies[0]!)
  let readSeq = 0
  const activation = createGaRpcActivation({
    parseApplyRequest: (await loadCommonAuthCommands()).parseApplyRequest,
    state: {
      read: async () => ({
        readSeq: ++readSeq,
        accounts: { kind: 'complete', rows: [] },
        route: null,
        status: {
          checkedAt: null,
          quotaBackoffUntil: null,
          routingAuthoritative: true,
        },
        settings: {
          selectionStrategy: 'sticky',
          killswitch: { enabled: false, minimumRemainingPercent: 10 },
          logLevel: 'info',
          dump: { enabled: false },
        },
      }),
    },
    commands: {
      apply: async () => {
        throw new Error('Unexpected menu action')
      },
    },
  })
  const host = await openCode2(environment, 'vault', input, {
    quiet_mode: quiet,
    toast_scope: toastScope,
  })
  try {
    const options = {
      runtime: host.runtime,
      overrides: {},
      routes: createGaRouteBook(),
      notify: activation.notify,
      pool: createVaultAccountPool({
        source: {
          refresh: async () => {},
          routes: () => [route],
          admit: async () => ({
            ...route,
            ...credential,
            expiresAtMs: null,
            recordVersion: 1,
          }),
          reportServedStatus: async () => false,
          reportCondition: async () => 'reported' as const,
        },
      }),
    }
    const pipeline = await createGaVaultRequestPipeline(options)
    try {
      const bridge = await startGaLoopbackBridge({
        execute: pipeline.execute,
        send: async () => {
          throw new Error('Unexpected bridge transport bypass')
        },
      })
      try {
        const result = await google2(
          input,
          async (request) => {
            const event = {
              sessionID,
              kind: 'primary' as const,
              model: { id: input.model, providerID: 'google' },
              request,
            }
            const rewrite = {
              bridge,
              env: {},
              ownership: new GaRequestOwnership(),
              isRegisteredModel: () => true,
              parentSession: async (id: string) =>
                id === sessionID ? (parentID ?? null) : null,
            }
            await rewriteGaHttpRequest(event, rewrite)
            const response = await fetch(event.request)
            return bridge.adaptResponse(event.request, response) ?? response
          },
          undefined,
          placeholderSecret('google'),
        )
        expect(result.terminal).toEqual(['failure:account_reauthorize'])
        const snapshot = await activation.handlers.state({
          version: 1,
          generation: null,
          scope,
          cursor: 0,
        })
        if (snapshot.kind !== 'snapshot')
          throw new Error('Expected a location snapshot')
        return snapshot.notifications.map(({ payload }) => payload)
      } finally {
        await bridge.dispose()
      }
    } finally {
      await pipeline.dispose()
    }
  } finally {
    await activation.dispose()
    await host.dispose()
    await environment.dispose()
  }
}

test('OpenCode 2 quiet_mode suppresses the engine verification notice in its session queue', async () => {
  expect(await notices(false, 'root_only')).toEqual([verificationNotice])
  expect(await notices(true, 'root_only')).toEqual([])
})

test('OpenCode 2 toast_scope root_only suppresses the engine notice for a host child session', async () => {
  expect(await notices(false, 'all', 'parent-session')).toEqual([
    verificationNotice,
  ])
  expect(await notices(false, 'root_only', 'parent-session')).toEqual([])
})
