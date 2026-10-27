import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { caseNames, runCase } from './contract.mjs'

test('logger.required_case_inventory', () => {
  assert.deepEqual([...caseNames].sort(), [
    'logger.core_bridge',
    'logger.error_redaction',
    'logger.explicit_debug',
    'logger.file_contract',
    'logger.instances',
    'logger.shared_key_policy',
    'logger.sinks_levels',
  ])
})

for (const name of caseNames) test(name, () => runCase(name))
