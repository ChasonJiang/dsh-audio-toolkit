/**
 * Minimal tar.gz reader: enough for the audio.cpp release archives.
 *
 * Supports ustar headers (including the 155-byte `prefix`), regular files and
 * directories; skips PAX/GNU extension headers and link entries. No dependency:
 * `node:zlib` gunzips, the rest is a 512-byte block walk.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return (end < 0 ? slice : slice.subarray(0, end)).toString('utf8').trim()
}

/** Parse a tar buffer into `{name, data}` entries (regular files only). */
export function readTarEntries(tar) {
  const entries = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = Number.parseInt(readString(header, 124, 12) || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const dataStart = offset + 512
    const data = tar.subarray(dataStart, dataStart + size)
    const full = prefix ? `${prefix}/${name}` : name
    // '0' / '\0' are regular files; '5' dirs, 'x'/'g' pax, '2' links are skipped.
    if ((type === '0' || type === '\0') && full && !full.endsWith('/')) entries.push({ name: full, data })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** True when every entry shares one leading directory. */
function commonPrefix(names) {
  const parts = names.map((name) => name.split('/'))
  if (parts.some((list) => list.length < 2)) return ''
  const first = parts[0][0]
  return parts.every((list) => list[0] === first) ? `${first}/` : ''
}

/**
 * Extract a `.tar.gz` buffer into `destDir` (same options as `extractZip`).
 *
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {{stripTopLevel?: boolean, flatten?: boolean, filter?: (name: string) => boolean}} [options]
 * @returns {string[]} absolute paths written
 */
export function extractTarGz(buffer, destDir, options = {}) {
  const entries = readTarEntries(gunzipSync(buffer))
  const strip = options.stripTopLevel === false ? '' : commonPrefix(entries.map((entry) => entry.name))
  const written = []
  for (const entry of entries) {
    const relative = strip && entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) continue
    if (options.filter && !options.filter(relative)) continue
    const target = options.flatten ? join(destDir, relative.split('/').pop()) : join(destDir, ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    written.push(target)
  }
  return written
}

/** True when the file name looks like a gzipped tarball. */
export function isTarGz(name) {
  return /\.tar\.gz$/i.test(String(name ?? ''))
}
