#!/usr/bin/env node
/**
 * Syntax-check every source file without importing it.
 *
 * The test suite imports most modules, but a typo in an unimported branch (or in
 * a client bundle evaluated only by the browser) would slip through. `node
 * --check` parses each file; this keeps the check cross-platform without shell
 * globs.
 *
 * Usage: node scripts/check_syntax.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const ROOTS = ['src', 'mcp', 'scripts', 'test']
const SKIP_DIRS = new Set(['node_modules', 'state', '.git'])

/** Every .js/.mjs file under `dir`. */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path, out)
      continue
    }
    if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name))) out.push(path)
  }
  return out
}

const files = ROOTS.flatMap((root) => walk(join(PACKAGE_ROOT, root)))
const failures = []
for (const file of files) {
  // `stdio: 'inherit'` keeps the child from needing pipes (blocked in some
  // confined environments) and lets node print the syntax error itself.
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) failures.push(file)
}

console.log(`checked ${files.length} file(s)`)
for (const file of failures) console.error(`FAIL  ${file.replace(PACKAGE_ROOT, '.')}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} file(s) failed the syntax check`)
  process.exitCode = 1
}
