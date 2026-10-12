import { expect, it } from 'bun:test'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

it('pins the genuine Pi SDK credential directory inside the test root', () => {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, 'pi-agent'))
  expect(getAgentDir()).toBe(join(root, 'pi-agent'))
  expect(join(getAgentDir(), 'auth.json')).toBe(
    join(root, 'pi-agent', 'auth.json'),
  )
})
