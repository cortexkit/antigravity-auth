#!/usr/bin/env bun
/**
 * Runs a test command with a genuine @cortexkit/common-auth consumer fixture.
 *
 * Usage: bun scripts/prepare-common-auth-tests.ts <command> [args...]
 *
 * The real-store tests in packages/core load common-auth's public `./store`
 * and `./fs` entries the way an installed consumer does, from the directory
 * named by AGY_COMMON_AUTH_STORE_CONSUMER. This script builds that directory
 * once, offline, in a fresh temporary directory:
 * - `node_modules/@cortexkit/common-auth`: the package extracted from the
 *   repository's pinned library archive, after its SHA-256 matches the pin;
 * - `store-bridge.mjs` and `fs-bridge.mjs`: one-line re-exports of the
 *   package's `./store` and `./fs` entries.
 * It then runs the given command with AGY_COMMON_AUTH_STORE_CONSUMER set to
 * that directory, removes the directory afterwards and exits with the
 * command's status. Nothing is fetched and no shared cache or user profile is
 * read or written.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE =
  'tools/common-auth-build/inputs/cortexkit-common-auth-0.11.6.tgz'
const ARCHIVE_SHA256 =
  '2e1cbbdd2c5e75bbeecada6a64b93c29b64c5d3b41d3742312e1390cfaa6d9df'
const PACKAGE_NAME = '@cortexkit/common-auth'
const PACKAGE_VERSION = '0.11.6'
const ENV_NAME = 'AGY_COMMON_AUTH_STORE_CONSUMER'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error(
    'Usage: bun scripts/prepare-common-auth-tests.ts <command> [args...]',
  )
  process.exit(2)
}

const archivePath = join(repoRoot, ARCHIVE)
const archive = readFileSync(archivePath)
const digest = createHash('sha256').update(archive).digest('hex')
if (digest !== ARCHIVE_SHA256) {
  console.error(
    `${ARCHIVE} has SHA-256 ${digest}, not the pinned ${ARCHIVE_SHA256}`,
  )
  process.exit(1)
}

const consumer = mkdtempSync(join(tmpdir(), 'agy-common-auth-consumer-'))
let status = 1
try {
  const packageRoot = join(
    consumer,
    'node_modules',
    '@cortexkit',
    'common-auth',
  )
  mkdirSync(packageRoot, { recursive: true })
  const extracted = spawnSync(
    'tar',
    ['-xzf', archivePath, '-C', packageRoot, '--strip-components=1'],
    { stdio: 'inherit' },
  )
  if (extracted.status !== 0)
    throw new Error(`tar failed to extract ${ARCHIVE}`)
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  )
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION)
    throw new Error(
      `${ARCHIVE} does not contain ${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    )
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'agy-common-auth-consumer', private: true, type: 'module' })}\n`,
  )
  writeFileSync(
    join(consumer, 'store-bridge.mjs'),
    `export * from '${PACKAGE_NAME}/store'\n`,
  )
  writeFileSync(
    join(consumer, 'fs-bridge.mjs'),
    `export * from '${PACKAGE_NAME}/fs'\n`,
  )

  // `bun` runs as the Bun executing this script, so the tests use the same
  // runtime as the caller rather than whichever Bun is first on PATH.
  const executable = command === 'bun' ? process.execPath : command
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, [ENV_NAME]: consumer },
  })
  if (result.error) throw result.error
  status = result.status ?? 1
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
process.exit(status)
