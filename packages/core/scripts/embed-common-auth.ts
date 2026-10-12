#!/usr/bin/env bun
/**
 * Writes or checks core's embedded @cortexkit/common-auth entries.
 *
 * Usage: bun packages/core/scripts/embed-common-auth.ts [--check]
 *
 * The repository has one common-auth emitter, the producer's coordinator in
 * packages/opencode/scripts/embed-common-auth.ts. It verifies the pinned
 * library archive and writes each package's fixed profile; core's profile is
 * packages/core/src/common-auth-embedded. This script only invokes that
 * coordinator for the core profile: with --check it fails unless the
 * committed output is byte-identical to what the archive produces, without
 * writing anything. It is build tooling; nothing at runtime imports it.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { embedCommonAuthPackages } from '../../opencode/scripts/embed-common-auth.ts'

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--check')) {
  console.error(
    'Usage: bun packages/core/scripts/embed-common-auth.ts [--check]',
  )
  process.exit(2)
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const check = args.includes('--check')
await embedCommonAuthPackages(['core'], repoRoot, check)
console.log(
  check
    ? 'Core common-auth embedding verified against the pinned archive'
    : 'Core common-auth embedding written from the pinned archive',
)
