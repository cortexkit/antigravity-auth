import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  GaHostSession,
  GaPaths,
  gaNativeRequest,
  record,
  waitForGaObservation,
} from './opencode-ga-harness.ts'

interface GaInventoryControls {
  gaNativeRequest: typeof gaNativeRequest
  waitForGaObservation: typeof waitForGaObservation
  record: typeof record
  requireCondition: (condition: unknown, message: string) => asserts condition
  startupBudgetMs: number
}

export async function awaitGaGoogleIntegration(
  harness: {
    paths: GaPaths
    host: Pick<GaHostSession, 'url'>
  },
  requireKeyMethod: boolean,
  controls: GaInventoryControls,
): Promise<void> {
  const { gaNativeRequest, waitForGaObservation, record } = controls
  const requireCondition: GaInventoryControls['requireCondition'] =
    controls.requireCondition
  const startupDeadline = performance.now() + controls.startupBudgetMs
  const location = new URLSearchParams({
    'location[directory]': harness.paths.project,
  })
  const plugin = realpathSync(
    resolve('packages/opencode/node_modules/@opencode/plugin'),
  )
  const [integration, pluginSchema, effect] = await Promise.all([
    import(
      pathToFileURL(Bun.resolveSync('@opencode/schema/integration', plugin))
        .href
    ),
    import(
      pathToFileURL(Bun.resolveSync('@opencode/schema/plugin', plugin)).href
    ),
    import(pathToFileURL(Bun.resolveSync('effect', plugin)).href),
  ])
  // Integration lists are current-state reads on newer hosts, not activation
  // barriers. Wait for this location's wrapper, sharing the startup budget.
  const activationDeadline = Math.min(startupDeadline, performance.now() + 5000)
  await waitForGaObservation(
    async () => {
      const response = await gaNativeRequest(
        harness.host.url,
        'GET',
        `/api/plugin?${location}`,
        undefined,
        200,
        false,
        Math.max(1, Math.ceil(activationDeadline - performance.now())),
      )
      let plugins: Record<string, unknown>[]
      try {
        const envelope = record(response)
        requireCondition(
          record(envelope.location).directory === harness.paths.project,
          'Unexpected plugin inventory location',
        )
        const decoded: unknown = effect.Schema.decodeUnknownSync(
          effect.Schema.Array(pluginSchema.Info),
          { onExcessProperty: 'error' },
        )(envelope.data)
        requireCondition(
          Array.isArray(decoded),
          'Expected plugin inventory array',
        )
        plugins = decoded.map(record)
      } catch {
        throw new Error('GA_PLUGIN_INVENTORY_MALFORMED')
      }
      const wrapper = plugins.find(
        (entry) => entry.id === 'antigravity-e2e-wrapper',
      )
      if (!wrapper) return false
      const state = record(wrapper.state)
      if (state.status === 'failed')
        throw new Error(`GA_WRAPPER_PLUGIN_FAILED: ${state.error}`)
      return state.status === 'active'
    },
    'antigravity-e2e-wrapper active',
    Math.max(0, activationDeadline - performance.now()),
  )
  const response = await gaNativeRequest(
    harness.host.url,
    'GET',
    `/api/integration?${location}`,
    undefined,
    200,
    false,
    Math.max(1, Math.ceil(startupDeadline - performance.now())),
  )
  let inventory: Record<string, unknown>[]
  try {
    const envelope = record(response)
    requireCondition(
      record(envelope.location).directory === harness.paths.project,
      'Unexpected inventory location',
    )
    requireCondition(
      Array.isArray(envelope.data),
      'Expected integration inventory array',
    )
    inventory = envelope.data.map((value) => {
      const entry = record(value)
      requireCondition(typeof entry.id === 'string', 'Expected integration ID')
      return entry
    })
  } catch {
    throw new Error('GA_INTEGRATION_INVENTORY_MALFORMED')
  }
  const google = inventory.filter((entry) => entry.id === 'google')
  const match = google[0]
  requireCondition(
    google.length === 1 && match,
    'GA_GOOGLE_INTEGRATION_MISSING_AFTER_ACTIVATION',
  )
  // OpenCode 2.3 added external auth methods to unrelated providers. The schema
  // for the minimum supported version, 2.0.22, cannot decode them, so the smoke
  // strictly decodes only the Google integration it exercises.
  let entry: Record<string, unknown>
  try {
    entry = record(
      effect.Schema.decodeUnknownSync(integration.Info, {
        onExcessProperty: 'error',
      })(match),
    )
  } catch {
    throw new Error('GA_INTEGRATION_INVENTORY_MALFORMED')
  }
  if (requireKeyMethod) {
    requireCondition(
      Array.isArray(entry.methods) &&
        entry.methods.some((method) => record(method).type === 'key'),
      'GA_NATIVE_KEY_METHOD_MISSING_AFTER_ACTIVATION',
    )
  }
}
