import assert from 'node:assert/strict'
import { caseNames } from './fixture.mjs'

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasObservation = (value) =>
  typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0
      : isRecord(value) && Object.keys(value).length > 0

// This is the result boundary shared by unit, matrix and mutation runners.
// Type annotations and truthiness cannot establish a child's success status.
export function validateResult(value, exitCode) {
  assert(isRecord(value), 'RPC result must be a record')
  assert(
    typeof value.runtime === 'string' && value.runtime.trim(),
    'RPC result must name its runtime',
  )
  assert(
    value.bun === null || (typeof value.bun === 'string' && value.bun.trim()),
    'RPC result must identify Bun or use null for Node',
  )
  assert(exitCode === 0 || exitCode === 1, 'RPC result exit must be 0 or 1')
  assert(Array.isArray(value.rows), 'RPC result rows must be an array')
  assert.equal(
    value.rows.length,
    caseNames.length,
    'RPC result must contain the complete inventory',
  )
  const failures = []
  for (const [index, row] of value.rows.entries()) {
    assert(isRecord(row), 'RPC result row must be a record')
    assert.equal(
      row.name,
      caseNames[index],
      'RPC result names must match the exact ordered inventory',
    )
    assert.equal(
      typeof row.ok,
      'boolean',
      `${row.name}: row.ok must be a boolean`,
    )
    if (row.ok === true) {
      assert(
        hasObservation(row.observation),
        `${row.name}: successful row must have an observation`,
      )
      assert(
        !Object.hasOwn(row, 'error'),
        `${row.name}: successful row cannot also report an error`,
      )
    } else {
      assert(
        typeof row.error === 'string' && row.error.trim(),
        `${row.name}: failed row must have an error`,
      )
      assert(
        !Object.hasOwn(row, 'observation'),
        `${row.name}: failed row cannot also report success`,
      )
      failures.push(row)
    }
  }
  assert.equal(
    exitCode,
    failures.length === 0 ? 0 : 1,
    'RPC result rows contradict the child exit',
  )
  return { result: value, failures }
}
