#!/usr/bin/env bun
/**
 * Makes emitted declaration files resolvable by NodeNext consumers.
 *
 * Usage: bun scripts/finalize-declaration-specifiers.ts <declarationDir> <sourceRoot>
 *
 * TypeScript copies relative module specifiers into `.d.ts` output as they
 * were written in source: extensionless (`./cache`), directory (`./config`)
 * or `.ts` (`./runtime.ts`). Bundler resolution accepts all three; NodeNext,
 * which follows Node's ESM rules, needs the explicit file a runtime import
 * would load. This script rewrites every relative specifier in
 * `<declarationDir>` to the `.js` path of the declaration it names
 * (`./cache.js`, `./config/index.js`, `./runtime.js`), so the published types
 * mean exactly what they meant before and now resolve under both modes.
 *
 * Declarations that the compiler does not emit, because they are hand-written
 * `.d.ts` inputs (such as the embedded common-auth entries), are copied from
 * the same relative path under `<sourceRoot>` and processed the same way.
 * A specifier that resolves to no declaration fails the build.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const [declarationArg, sourceArg] = process.argv.slice(2)
if (!declarationArg || !sourceArg) {
  console.error(
    'Usage: bun scripts/finalize-declaration-specifiers.ts <declarationDir> <sourceRoot>',
  )
  process.exit(2)
}
const declarationRoot = resolve(declarationArg)
const sourceRoot = resolve(sourceArg)

function declarationFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...declarationFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/** Brings a declaration into the output tree from the source tree if needed. */
function ensureDeclaration(path: string): boolean {
  if (existsSync(path)) return true
  const rel = relative(declarationRoot, path)
  if (rel.startsWith(`..${sep}`)) return false
  const source = join(sourceRoot, rel)
  if (!existsSync(source)) return false
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(source, path)
  pending.push(path)
  return true
}

/** The explicit `.js` specifier for `specifier` as written in `file`. */
function explicitSpecifier(file: string, specifier: string): string {
  const base = specifier.replace(/\.(?:[cm]?ts|[cm]?js)$/, '')
  for (const [declaration, runtime] of [
    [`${base}.d.ts`, `${base}.js`],
    [`${base}/index.d.ts`, `${base}/index.js`],
  ] as const) {
    if (ensureDeclaration(resolve(dirname(file), declaration))) return runtime
  }
  throw new Error(
    `${relative(declarationRoot, file)}: no declaration for '${specifier}'`,
  )
}

function rewrite(file: string): void {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const edits: { start: number; end: number; value: string }[] = []
  const visit = (node: ts.Node): void => {
    let literal: ts.Node | undefined
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      literal = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      literal = node.argument.literal
    if (
      literal &&
      ts.isStringLiteral(literal) &&
      literal.text.startsWith('.')
    ) {
      const value = explicitSpecifier(file, literal.text)
      if (value !== literal.text)
        edits.push({
          start: literal.getStart(source) + 1,
          end: literal.getEnd() - 1,
          value,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (edits.length === 0) return
  let next = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.value + next.slice(edit.end)
  writeFileSync(file, next)
}

const pending = declarationFiles(declarationRoot)
let count = 0
for (let file = pending.shift(); file; file = pending.shift()) {
  rewrite(file)
  count += 1
}
console.log(`Finalized relative specifiers in ${count} declaration files`)
