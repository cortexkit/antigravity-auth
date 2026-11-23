import { expect, test } from 'bun:test'
import {
  createAntigravityCommandMenu,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'
import { createOpenCodeAntigravityMenu } from '../../../../opencode/src/plugin/commands.ts'
import { createGaLocationMenu } from '../../../../opencode/src/plugin/ga-location-services.ts'
import { emptyOperatorSettings } from '../../../../opencode/src/plugin/operator-settings.ts'
import { createPiAntigravityAccountSections } from '../../../../pi/src/commands.ts'
import type { PiVaultSetup } from '../../../../pi/src/vault-setup.ts'
import { conversation, nativeOptions, unrepresentable } from '../cases.ts'
import { Environment } from '../environment.ts'
import { openCode2 } from '../open-code.ts'
import { rows } from './applicability.ts'

const root = new URL('../../../../../', import.meta.url)
const read = (path: string) => Bun.file(new URL(path, root)).text()
const commandsDoc = () => read('packages/opencode/docs/COMMANDS.md')
const invocation = { notify() {} }
const vault = { id: 'vault', title: 'Vault', build: () => ({}) }
const dump = { isEnabled: () => false, setEnabled() {} }
const accounts: Parameters<typeof createGaLocationMenu>[0]['repository'] = {
  read: async () => ({ status: 'ready', rows: [] }),
  setEnabled: async (ref) => ({ ref }),
  remove: async () => {},
  selectAccount: async () => {},
  updateMetadata: async (ref) => ({ ref }),
}

test('the commands guide matches the local menus issued on both OpenCode hosts', async () => {
  const v1 = await createOpenCodeAntigravityMenu({
    accounts,
    selectionStrategy: () => 'hybrid',
    settings: { get: emptyOperatorSettings, update: async () => {} },
    dump,
    applyLogLevel() {},
    signIn: {
      start: async () => {
        throw new Error('Menu display must not start a login')
      },
      finish: async () => {
        throw new Error('Menu display must not finish a login')
      },
    },
    vault,
  })
  const doc = await commandsDoc()
  const v1Sections = (await v1.open(invocation)).menu.sections
  expect(doc).toContain(
    `**OpenCode 1 local:** ${v1Sections.map(({ title }) => title).join(' → ')}`,
  )
  for (const section of v1Sections.filter(
    ({ id }) => id === 'sign-in' || id === 'limits',
  )) {
    for (const { label } of section.actions)
      expect(doc).toContain(`**${label}**`)
  }

  const environment = new Environment()
  try {
    const host = await openCode2(
      environment,
      'local',
      conversation('menu inventory'),
    )
    try {
      const menu = createGaLocationMenu({
        commands: await loadCommonAuthCommands(),
        repository: accounts,
        runtime: host.runtime,
        login: { run: async () => 'unused' },
        vault,
      })
      const issued = (await menu.open(invocation)).menu.sections
      expect(doc).toContain(
        `**OpenCode 2 local:** ${issued.map(({ title }) => title).join(' → ')}`,
      )
      const add = issued[0]?.actions.find(({ id }) => id === 'add')
      expect(add?.label).toBe('Add account')
      expect(doc).toContain(`**${add?.label}**`)
    } finally {
      await host.dispose()
    }
  } finally {
    await environment.dispose()
  }
})

test('the Pi and commands guides match the Pi menu without quota or limits actions', async () => {
  const menu = createAntigravityCommandMenu({
    commands: await loadCommonAuthCommands(),
    source: 'sections',
    sections: createPiAntigravityAccountSections({
      setup: async () =>
        ({
          status: async () => ({
            mode: 'local' as const,
            hostSlot: 'login' as const,
            hosted: false,
            enrollment: { state: 'idle' as const },
          }),
        }) as PiVaultSetup,
      accounts() {
        throw new Error('Local menu must not open the vault')
      },
    }),
    extras: [vault],
  })
  const sections = (await menu.open(invocation)).menu.sections
  const order = sections.map(({ title }) => title).join(' → ')
  expect(await commandsDoc()).toContain(`**Pi:** ${order}`)
  expect(await read('packages/pi/README.md')).toContain(`**${order}**`)
  for (const section of sections.filter(
    ({ id }) => id === 'quota' || id === 'limits',
  )) {
    expect(section.actions).toEqual([])
    expect(section.items).toEqual([])
  }
  expect(await read('README.md')).toContain(
    "Pi's menu shows its credential source and vault choices, not quota readings.",
  )
})

test('the public host limits distinguish native Google ownership, recovery, and XHigh', async () => {
  const gaDoc = await read('packages/opencode/docs/OPENCODE-2.md')
  expect(gaDoc).toContain(
    'Requests carrying a real Google key or native Google OAuth credential pass through untouched',
  )
  for (const key of new Set(
    rows
      .filter(({ proof }) => proof.status === 'host-limited')
      .map(({ key }) => key),
  )) {
    expect(gaDoc).toContain(`\`${key}\``)
  }
  const xhigh = conversation('XHigh host limit', {
    options: { level: 'xhigh' },
  })
  expect(nativeOptions(xhigh, 'opencode1').thinking).toBe(unrepresentable)
  expect(nativeOptions(xhigh, 'opencode2').thinking).not.toBe(unrepresentable)
  expect(nativeOptions(xhigh, 'pi').thinking).not.toBe(unrepresentable)
  expect(await read('README.md')).toContain(
    'OpenCode 1 cannot pass xhigh to the plugin',
  )
  expect(await read('packages/pi/README.md')).toContain(
    'GPT-OSS has a fixed Medium tier',
  )
})
