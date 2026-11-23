import { rows } from './applicability.ts'

const legend = {
  applied: 'Yes',
  'host-limited': 'Host limit',
  'single account by design': 'One account',
  'not applicable': '—',
} as const

export function renderSettingsDoc(): string {
  const byKey = Map.groupBy(rows, ({ key }) => key)
  return [
    '# Settings by host and credential source',
    '',
    'This table covers plugin-owned Antigravity requests. OpenCode 2 requests using native Google credentials are not affected. **OC1** and **OC2** mean OpenCode 1 and 2. **Local** is the OpenCode pool or Pi’s native Google login, **Vault** is an enrolled vault, and **Hosted** is a vault supplied by Thalamus.',
    '',
    '**Project** means that OpenCode allows an override from a project file. **User-only** settings can only come from the user file. Pi reads supported settings from the user file and never reads project overrides. See [Configuration](CONFIGURATION.md#plugin-configuration) for locations and defaults.',
    '',
    '- **Yes**: a non-default setting has a tested effect when its feature is in use.',
    '- **Host limit**: the OpenCode 2.0.22 plugin API does not provide the needed repair/resume or plugin-update operation.',
    '- **One account**: Pi uses one account at a time, with no pool rotation, health scoring, quota polling, or quota gates.',
    '- **—**: the setting has no effect on this path. For example, buffered empty-response retries do not apply to Pi’s stream, and custody never refreshes a local login. `claude_prompt_auto_caching` is accepted for compatibility but does not change requests.',
    '- **Unverified**: no non-default effect is claimed for this host and credential source.',
    '',
    '| Setting | Scope | OC1 Local | OC1 Vault | OC1 Hosted | OC2 Local | OC2 Vault | OC2 Hosted | Pi Local | Pi Vault | Pi Hosted |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Array.from(byKey, ([key, settings]) => {
      const cells = settings.map(({ proof }) =>
        proof.status === null ? 'Unverified' : legend[proof.status],
      )
      return `| \`${key}\` | ${settings[0]!.scope} | ${cells.join(' | ')} |`
    }),
    '',
    'See [Commands](COMMANDS.md#antigravity-menu) for account and vault actions, and [OpenCode 2](OPENCODE-2.md#ui-and-evidence-limits) for its host limits.',
    '',
  ].join('\n')
}

if (import.meta.main) {
  const output = new URL(
    '../../../../opencode/docs/SETTINGS.md',
    import.meta.url,
  )
  await Bun.write(output, renderSettingsDoc())
}
