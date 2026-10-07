import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { caseNames, repository } from './fixture.mjs'
import { validateResult } from './result-validator.mjs'
import { admitRuntime } from './run-runtime.mjs'
import { main, parseMatrixArgs } from './runtime-matrix.mjs'

const success = () => ({
  runtime: 'v24.16.0',
  bun: null,
  rows: caseNames.map((name) => ({
    name,
    ok: true,
    observation: { witness: name },
  })),
})

const flags = ['--node20', '--node24', '--bun13', '--bun14']
const args = flags.flatMap((flag) => [
  flag,
  join(
    repository,
    'test/common-auth-094-adoption/rpc/.owned/binaries',
    flag.slice(2),
  ),
])

test('rpc.results.valid_success: complete boolean success agrees with exit zero', () => {
  const value = success()
  const checked = validateResult(value, 0)
  expect(checked.result).toBe(value)
  expect(checked.failures).toEqual([])
})

test('rpc.results.valid_named_red: a complete named failure agrees with exit one', () => {
  const value = {
    ...success(),
    rows: success().rows.map((row, index) =>
      index === 0
        ? { name: row.name, ok: false, error: 'intentional data-only red' }
        : row,
    ),
  }
  const checked = validateResult(value, 1)
  expect(checked.failures.map((row: { name: string }) => row.name)).toEqual([
    'rpc.auth_validation',
  ])
})

test('rpc.results.strict_boolean_refusal: malformed truthy success is not acceptance', () => {
  for (const ok of ['yes', 'true', 1, {}, []]) {
    const value = {
      ...success(),
      rows: success().rows.map((row, index) =>
        index === 0 ? { ...row, ok } : row,
      ),
    }
    // This is the former boundary's predicate, demonstrating the admission bug
    // with data alone rather than a fake runtime or a transport substitution.
    expect(value.rows.filter((row) => !row.ok)).toHaveLength(0)
    expect(() => validateResult(value, 0)).toThrow('row.ok must be a boolean')
  }
  const missing = {
    ...success(),
    rows: success().rows.map((row, index) =>
      index === 0 ? { name: row.name, observation: row.observation } : row,
    ),
  }
  expect(() => validateResult(missing, 0)).toThrow('row.ok must be a boolean')
})

test('rpc.results.inventory_refusal: missing duplicate unknown and reordered rows fail', () => {
  const value = success()
  expect(() =>
    validateResult({ ...value, rows: value.rows.slice(1) }, 0),
  ).toThrow('complete inventory')
  expect(() =>
    validateResult(
      {
        ...value,
        rows: value.rows.map((row, index) => ({
          ...row,
          name: index === 1 ? 'rpc.auth_validation' : row.name,
        })),
      },
      0,
    ),
  ).toThrow('exact ordered inventory')
  expect(() =>
    validateResult(
      {
        ...value,
        rows: value.rows.map((row, index) => ({
          ...row,
          name: index === 0 ? 'unknown' : row.name,
        })),
      },
      0,
    ),
  ).toThrow('exact ordered inventory')
  expect(() =>
    validateResult({ ...value, rows: [...value.rows].reverse() }, 0),
  ).toThrow('exact ordered inventory')
})

test('rpc.results.exit_refusal: unsupported and contradictory exits cannot be green', () => {
  for (const exit of [null, 7, true, '0'])
    expect(() => validateResult(success(), exit)).toThrow('exit must be 0 or 1')
  expect(() => validateResult(success(), 1)).toThrow(
    'contradict the child exit',
  )
  const red = {
    ...success(),
    rows: success().rows.map((row, index) =>
      index === 0 ? { name: row.name, ok: false, error: 'red' } : row,
    ),
  }
  expect(() => validateResult(red, 0)).toThrow('contradict the child exit')
})

test('rpc.results.schema_refusal: malformed empty and contradictory evidence fails', () => {
  for (const value of [null, [], {}, { ...success(), rows: null }])
    expect(() => validateResult(value, 0)).toThrow()
  for (const observation of ['', ' ', [], {}, null]) {
    const value = {
      ...success(),
      rows: success().rows.map((row, index) =>
        index === 0 ? { ...row, observation } : row,
      ),
    }
    expect(() => validateResult(value, 0)).toThrow('must have an observation')
  }
  const both = {
    ...success(),
    rows: success().rows.map((row, index) =>
      index === 0 ? { ...row, error: 'not success' } : row,
    ),
  }
  expect(() => validateResult(both, 0)).toThrow('cannot also report an error')
  const emptyError = {
    ...success(),
    rows: success().rows.map((row, index) =>
      index === 0 ? { name: row.name, ok: false, error: '' } : row,
    ),
  }
  expect(() => validateResult(emptyError, 1)).toThrow('must have an error')
})

test('rpc.matrix.cli: four explicit paths preserve all required exact versions', () => {
  const parsed = parseMatrixArgs([...args.slice(4), ...args.slice(0, 4)])
  expect(
    parsed.map((runtime: { flag: string; version: string }) => [
      runtime.flag,
      runtime.version,
    ]),
  ).toEqual([
    ['--node20', 'v20.0.0'],
    ['--node24', 'v24.16.0'],
    ['--bun13', '1.3.14'],
    ['--bun14', '1.4.2'],
  ])
  expect(parsed.map((runtime: { path: string }) => runtime.path)).toEqual(
    flags.map((flag) =>
      join(
        repository,
        'test/common-auth-094-adoption/rpc/.owned/binaries',
        flag.slice(2),
      ),
    ),
  )
})

test('rpc.matrix.cli_refusal: missing duplicate unknown and valueless flags fail', () => {
  for (let index = 0; index < args.length; index += 2) {
    expect(() =>
      parseMatrixArgs([...args.slice(0, index), ...args.slice(index + 2)]),
    ).toThrow('Missing required RPC matrix flag')
  }
  expect(() =>
    parseMatrixArgs([...args, '--node20', process.execPath]),
  ).toThrow('Duplicate RPC matrix flag')
  expect(() =>
    parseMatrixArgs([...args, '--unknown', process.execPath]),
  ).toThrow('Unknown RPC matrix flag')
  expect(() => parseMatrixArgs(['--node20'])).toThrow('Missing executable path')
  expect(() => parseMatrixArgs(['--node20', '--node24'])).toThrow(
    'Missing executable path',
  )
  expect(() => parseMatrixArgs(['--node20', ' '])).toThrow(
    'Missing executable path',
  )
})

test('rpc.matrix.admission_refusal: missing executables and wrong versions fail before callbacks', async () => {
  const missing = join(
    repository,
    'test/common-auth-094-adoption/rpc/.owned/no-such-executable',
  )
  expect(() =>
    admitRuntime({
      name: 'Missing runtime',
      path: missing,
      version: 'v20.0.0',
    }),
  ).toThrow('executable admission failed')
  const wrong = {
    name: 'Wrong version',
    path: process.execPath,
    version: 'not-a-required-version',
  }
  expect(() => admitRuntime(wrong)).toThrow('wrong exact version')
  await expect(main(['--node20', missing, ...args.slice(2)])).rejects.toThrow(
    'executable admission failed',
  )
  await expect(
    main(flags.flatMap((flag) => [flag, process.execPath])),
  ).rejects.toThrow('wrong exact version')
})
