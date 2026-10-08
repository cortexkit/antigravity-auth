// Directory forwarder for the `./tui` entry. OpenCode 2 resolves a plugin
// directory by importing `<directory>/tui` without reading the package's
// export map, so this file re-exports the same entry that `exports["./tui"]`
// names.
export * from './src/tui/entry.mjs'
export { default } from './src/tui/entry.mjs'
