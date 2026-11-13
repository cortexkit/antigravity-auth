import { createRequire } from 'node:module'

const fromEsbuild = createRequire(import.meta.resolve('esbuild'))

/** Resolve the native optional dependency from the same esbuild installation as the API. */
export function esbuildBinary(): string {
  const name = `@esbuild/${process.platform}-${process.arch}`
  const manifest = fromEsbuild('esbuild/package.json')
  if (!manifest.optionalDependencies?.[name])
    throw new Error(
      `Native esbuild package unavailable for ${process.platform}-${process.arch}`,
    )
  const native = fromEsbuild(`${name}/package.json`)
  if (native.version !== manifest.version)
    throw new Error(`Native esbuild version mismatch: ${name}`)
  return fromEsbuild.resolve(
    `${name}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
  )
}

export function esbuildBundleArgs(options: {
  entry: string
  outfile: string
  external: readonly string[]
  banner?: string
  sourcemap?: boolean
  metafile?: string
}): string[] {
  return [
    options.entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    ...options.external.map((name) => `--external:${name}`),
    `--outfile=${options.outfile}`,
    ...(options.banner === undefined ? [] : [`--banner:js=${options.banner}`]),
    ...(options.sourcemap ? ['--sourcemap'] : []),
    ...(options.metafile ? [`--metafile=${options.metafile}`] : []),
    '--log-level=warning',
  ]
}
