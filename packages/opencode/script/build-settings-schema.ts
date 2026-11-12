import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { settingsJsonSchema } from '@cortexkit/antigravity-auth-core/common-auth/settings'
import { ANTIGRAVITY_SETTINGS } from '@cortexkit/antigravity-auth-core/settings'

const output = new URL(
  '../assets/antigravity-auth.schema.json',
  import.meta.url,
)
mkdirSync(fileURLToPath(new URL('.', output)), { recursive: true })
writeFileSync(
  output,
  `${JSON.stringify(settingsJsonSchema(ANTIGRAVITY_SETTINGS), null, 2)}\n`,
)
