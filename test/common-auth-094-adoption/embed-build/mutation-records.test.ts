import { expect, test } from 'bun:test'
import {
  classifyMutationResult,
  embedMutationCases,
} from './mutation-records.mjs'

const red = 'embed.inventory'
const unaffected = embedMutationCases.filter((name) => name !== red)
const records = (passes: readonly string[] = unaffected) =>
  [
    `(fail) ${red} [5.25ms]`,
    ...passes.map((name) => `(pass) ${name} [0.50ms]`),
  ].join('\n')
const result = (stderr = records()) => ({
  status: 1,
  signal: null,
  error: undefined,
  stdout: '',
  stderr,
})
const outcome = (stderr: string) =>
  classifyMutationResult(result(stderr), red, embedMutationCases).outcome

test('mutation.records.exact_inventory', () => {
  expect(outcome(records())).toBe('reddened')
  expect(outcome(records([...unaffected].reverse()))).toBe('reddened')
  expect(outcome(records().replaceAll('\n', '\r\n'))).toBe('reddened')
  expect(outcome(records().replace(/ \[[^\]]+\]/g, ''))).toBe('reddened')
})

test('mutation.records.diagnostic_prefixes', () => {
  const fake = records()
    .split('\n')
    .map((line, index) => `${191 + index} | ${line}`)
    .join('\n')
  const parsed = classifyMutationResult(result(fake), red, embedMutationCases)
  expect(parsed).toEqual({ failures: [], passes: [], outcome: 'not_reached' })
  expect(outcome(`${fake}\n${records()}`)).toBe('reddened')
  expect(
    outcome(
      records()
        .split('\n')
        .map((line) => `diagnostic: ${line}`)
        .join('\n'),
    ),
  ).toBe('not_reached')
})

test('mutation.records.missing_pass', () => {
  expect(outcome(records(unaffected.slice(1)))).toBe('not_reached')
  expect(outcome('')).toBe('not_reached')
})

test('mutation.records.duplicate_pass', () => {
  const duplicate = [...unaffected]
  duplicate[0] = duplicate[1]!
  expect(duplicate.length).toBe(6)
  expect(outcome(records(duplicate))).toBe('not_reached')
  expect(outcome(`${records()}\n(pass) ${unaffected[0]} [0.25ms]`)).toBe(
    'not_reached',
  )
})

test('mutation.records.foreign_pass', () => {
  expect(outcome(records(['foreign.case', ...unaffected.slice(1)]))).toBe(
    'not_reached',
  )
  expect(outcome(`${records()}\n(pass) foreign.case [0.25ms]`)).toBe(
    'not_reached',
  )
})

test('mutation.records.wrong_failure', () => {
  expect(
    outcome(records().replace(`(fail) ${red}`, '(fail) embed.integrity')),
  ).toBe('not_reached')
  expect(outcome(`${records()}\n(fail) ${red} [0.25ms]`)).toBe('not_reached')
  expect(outcome(`${records()}\n(fail) foreign.case [0.25ms]`)).toBe(
    'not_reached',
  )
})

test('mutation.records.process_failures', () => {
  for (const status of [0, 7, null]) {
    expect(
      classifyMutationResult({ ...result(), status }, red, embedMutationCases)
        .outcome,
    ).toBe('not_reached')
  }
  expect(
    classifyMutationResult(
      { ...result(), signal: 'SIGTERM' },
      red,
      embedMutationCases,
    ).outcome,
  ).toBe('hung')
  expect(
    classifyMutationResult(
      { ...result(), error: { code: 'ETIMEDOUT' } },
      red,
      embedMutationCases,
    ).outcome,
  ).toBe('hung')
  expect(
    classifyMutationResult(
      { ...result(), error: { code: 'ENOENT' } },
      red,
      embedMutationCases,
    ).outcome,
  ).toBe('not_reached')
  expect(outcome(`${records()}\n# Unhandled error between tests\n`)).toBe(
    'not_reached',
  )
  expect(outcome(`${records()}\n 1 error\n`)).toBe('not_reached')
  expect(
    outcome(
      `${records()}\n  ^ a beforeEach/afterEach hook timed out for this test.\n`,
    ),
  ).toBe('not_reached')
  expect(outcome(`${records()}\n  ^ this test timed out after 5000ms\n`)).toBe(
    'not_reached',
  )
})

test('mutation.records.complete_green_control', () => {
  const green = {
    ...result(),
    status: 0,
    stderr: embedMutationCases
      .map((name) => `(pass) ${name} [0.25ms]`)
      .join('\n'),
  }
  expect(classifyMutationResult(green, red, embedMutationCases).outcome).toBe(
    'undefended',
  )
  expect(
    classifyMutationResult(green, 'foreign.case', embedMutationCases).outcome,
  ).toBe('not_reached')
})
