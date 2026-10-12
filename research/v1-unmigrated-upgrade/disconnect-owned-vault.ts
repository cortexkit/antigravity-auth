import { createOpenCodeVaultCustody } from '../../packages/opencode/src/plugin/vault-custody.ts'

const custody = createOpenCodeVaultCustody({
  accountFile: process.env.ANTIGRAVITY_ACCOUNTS_PATH!,
  readHostSlot: async () => { throw new Error('Disconnect must not read the dormant Google slot') },
  reporterSource: 'direct',
})
try {
  await custody.useLocal()
  console.log('Owned synthetic vault disconnected without native auth access')
} finally {
  await custody.dispose()
}
