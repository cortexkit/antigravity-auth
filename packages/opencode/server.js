// Directory forwarder for the `./server` entry. OpenCode 2 resolves a plugin
// directory by importing `<directory>/server` without reading the package's
// export map, so this file re-exports the same compiled hybrid entry that
// `exports["./server"]` names.
export * from './dist/server.js'
export { default } from './dist/server.js'
