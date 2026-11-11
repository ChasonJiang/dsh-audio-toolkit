/**
 * Minimal ZIP reader: enough for GitHub release assets and NVIDIA redist archives.
 *
 * No dependency, no ZIP64 (the archives involved are well under 4 GB) and no
 * encryption. Only `store` (0) and `deflate` (8) are needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Parse the central directory.
 * @param {Buffer} buffer
 * @returns {{name: string, method: number, compressedSize: number, size: number, offset: number}[]}
 */
export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的 ZIP 文件（内容过短）')
  let eocd = -1
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录结尾）')

  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.push({ name, method, compressedSize, size, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** True when every entry shares one leading directory (GitHub tarballs/zipballs do). */
function commonPrefix(names) {
  const parts = names.map((name) => name.replace(/\\/g, '/').split('/'))
  if (parts.some((list) => list.length < 2)) return ''
  const first = parts[0][0]
  return parts.every((list) => list[0] === first) ? `${first}/` : ''
}

/**
 * Extract a ZIP buffer into `destDir`.
 *
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {{stripTopLevel?: boolean, flatten?: boolean, filter?: (name: string) => boolean}} [options]
 *   `filter` receives the path after stripping, so callers can pick a few DLLs.
 * @returns {string[]} absolute paths written
 */
export function extractZip(buffer, destDir, options = {}) {
  const entries = readZipEntries(buffer)
  const files = entries.filter((entry) => !entry.name.endsWith('/') && !entry.name.endsWith('\\'))
  const strip = options.stripTopLevel === false ? '' : commonPrefix(files.map((entry) => entry.name))
  const written = []

  for (const entry of files) {
    const name = entry.name.replace(/\\/g, '/')
    const relative = strip && name.startsWith(strip) ? name.slice(strip.length) : name
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) continue
    if (options.filter && !options.filter(relative)) continue

    if (buffer.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目损坏：${entry.name}`)
    const nameLength = buffer.readUInt16LE(entry.offset + 26)
    const extraLength = buffer.readUInt16LE(entry.offset + 28)
    const start = entry.offset + 30 + nameLength + extraLength
    const raw = buffer.subarray(start, start + entry.compressedSize)
    let data
    if (entry.method === 0) data = raw
    else if (entry.method === 8) data = inflateRawSync(raw)
    else throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`)

    // latten drops the archive's directory structure (CUDA archives nest their DLLs).
    const target = options.flatten ? join(destDir, relative.split('/').pop()) : join(destDir, ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    written.push(target)
  }
  return written
}
