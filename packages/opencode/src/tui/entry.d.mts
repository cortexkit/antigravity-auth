/**
 * The `./tui` entry for both hosts. OpenCode 1 calls `tui(api, options,
 * meta)`; OpenCode 2 (GA) calls `setup(context)` and receives the cleanup
 * that stops everything the setup started.
 *
 * Parameters are typed `unknown` so this declaration imports neither host's
 * SDK: each host's own plugin type accepts it (a function taking `unknown`
 * accepts any argument), and a consumer on one host never needs the other
 * host's SDK or renderer declarations.
 */
declare const plugin: {
  readonly id: 'cortexkit.antigravity-auth'
  readonly tui: (api: unknown, options: unknown, meta: unknown) => Promise<void>
  readonly setup: (context: unknown) => Promise<() => Promise<void>>
}

export default plugin
