/**
 * E2E workspace test preload.
 *
 * Per-test isolation only — no fetch guard is installed here because
 * the bun-test isolated runtime proved fragile when wrapping
 * `globalThis.fetch` (the wrap would hang or return undefined for
 * loopback targets). The e2e tests rely on the plugin's
 * `dependencies.agyTransport` and `dependencies.fetchImpl`
 * overrides to route every outbound call through the mock — a
 * regression that re-introduces a live URL is caught by the mock
 * server's request recorder.
 *
 * Responsibilities:
 *   1. Allocate a per-test `mkdtemp` root with HOME / XDG_*
 *      overrides so tests never touch the host filesystem.
 *   2. Tear down the root in `afterEach` so cross-test pollution
 *      cannot leak.
 *   3. Defensive final sweep in `afterAll` to reap any temp roots
 *      left behind by crashed tests.
 */

import { afterAll, afterEach, beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test name tag attached to deny records so a regression points at
 * the offending scenario. Currently unused — the network guard is
 * disabled because it interfered with the loopback mock in this
 * harness — but kept exported so future iterations can re-enable
 * it without churning call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _setCurrentTestName = (_name: string): void => undefined

beforeEach(() => {
  // Per-test temp root + env reset. Tests must not touch the host HOME.
  const root = fs.mkdtempSync(join(tmpdir(), 'agy-e2e-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const cache = join(root, 'cache')
  const data = join(root, 'data')
  const state = join(root, 'state')
  const pi = join(root, 'pi-agent')
  for (const path of [home, config, cache, data, state, pi]) {
    fs.mkdirSync(path, { recursive: true })
  }
  process.env.ANTIGRAVITY_TEST_ROOT = root
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = config
  process.env.XDG_CACHE_HOME = cache
  process.env.XDG_DATA_HOME = data
  process.env.XDG_STATE_HOME = state
  process.env.APPDATA = config
  process.env.LOCALAPPDATA = cache
  process.env.OPENCODE_CONFIG_DIR = join(config, 'opencode')
  process.env.PI_AGENT_DIR = pi
  process.env.PI_ANTIGRAVITY_AUTH_FILE = join(pi, 'antigravity-accounts.json')
  process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = join(root, 'gemini-dumps')
  process.env.ANTIGRAVITY_AUTH_RPC_DIR = join(state, 'cortexkit', 'rpc')
  process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE = join(
    state,
    'cortexkit',
    'sidebar.json',
  )
})

afterEach(() => {
  // Tear down the temp root — even on assertion failure. We use the
  // `force` flag because some child files (sockets, fifos) may be
  // unreadable on platforms that hold advisory locks.
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (root) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup; the afterAll pass will retry if anything
      // is left behind.
    }
    delete process.env.ANTIGRAVITY_TEST_ROOT
  }
})

afterAll(() => {
  // Defensive final sweep — the per-test rmSync should have handled
  // everything, but a crashed test may have left a child root alive.
  // We match by prefix to avoid touching the host's tmpdir.
  const entries = fs.readdirSync(tmpdir())
  for (const entry of entries) {
    if (entry.startsWith('agy-e2e-')) {
      try {
        fs.rmSync(join(tmpdir(), entry), { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
  }
})
void _setCurrentTestName
