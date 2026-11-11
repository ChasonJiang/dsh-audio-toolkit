#!/usr/bin/env node
/**
 * Tests for the asset bootstrap: target selection (platform/backend), download,
 * ZIP/tar.gz extraction, resume and the guards.
 *
 * Everything runs against a local HTTP server with tiny in-memory archives, so
 * the suite is offline and fast — no 6 GB download, no GitHub/Hugging Face.
 *
 * Usage: node test/assets.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  availableTargets,
  defaultBackend,
  ensureAssets,
  ffmpegSourceUrl,
  installFfmpeg,
  missingAssets,
  modelBases,
  pickCudartAsset,
  pickReleaseAsset,
  releasePlatform,
} from '../mcp/assets.mjs'
import { resolveConfig, SERVER_BINARY } from '../src/config.js'
import { extractTarGz, readTarEntries } from '../mcp/tar.mjs'
import { extractZip, readZipEntries } from '../mcp/zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const SCRATCH = join(PACKAGE_ROOT, 'state', 'tmp', 'assets-test')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal store-only ZIP writer (CRC is not verified by the reader). */
function makeZip(files) {
  const locals = []
  const central = []
  let cursor = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(cursor, 42)
    locals.push(local, nameBuf, data)
    central.push(Buffer.concat([entry, nameBuf]))
    cursor += local.length + nameBuf.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(cursor, 16)
  return Buffer.concat([...locals, directory, eocd])
}

/** Minimal ustar writer for tar.gz fixtures. */
function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const makeTarGz = (files) => gzipSync(makeTar(files))

const runtimeZip = makeZip({
  'audio-v0.9.4-bin-windows-x64-cuda13.3/audiocpp_server.exe': 'server-stub',
  'audio-v0.9.4-bin-windows-x64-cuda13.3/audiocpp_cli.exe': 'cli-stub',
  'audio-v0.9.4-bin-windows-x64-cuda13.3/model_specs/index_tts2.json': '{}',
})
const cudartZip = makeZip({
  'cuda/bin/cudart64_13.dll': 'cudart',
  'cuda/bin/cublas64_13.dll': 'cublas',
  'cuda/bin/cublasLt64_13.dll': 'cublaslt',
  'cuda/bin/cufft64_12.dll': 'cufft',
})
const linuxRuntimeTar = makeTarGz({
  'audio-v0.9.4-bin-ubuntu-x64-cpu/audiocpp_server': 'server-stub',
  'audio-v0.9.4-bin-ubuntu-x64-cpu/audiocpp_cli': 'cli-stub',
  'audio-v0.9.4-bin-ubuntu-x64-cpu/model_specs/index_tts2.json': '{}',
})
const macRuntimeTar = makeTarGz({
  'audio-v0.9.4-bin-macos-arm64-metal/audiocpp_server': 'server-stub',
  'audio-v0.9.4-bin-macos-arm64-metal/model_specs/index_tts2.json': '{}',
})
const ffmpegZip = makeZip({
  'ffmpeg-7.1-essentials_build/bin/ffmpeg.exe': 'ffmpeg-stub',
})
const modelPayload = Buffer.alloc(256 * 1024, 7)

const release = {
  tag_name: 'v0.9.4-test',
  assets: [
    { name: 'audio-v0.9.4-bin-windows-x64-cuda13.3.zip', browser_download_url: 'BASE/windows-cuda.zip', size: runtimeZip.length },
    { name: 'audio-v0.9.4-bin-windows-x64-cpu.zip', browser_download_url: 'BASE/windows-cpu.zip', size: runtimeZip.length },
    { name: 'audio-v0.9.4-bin-windows-x64-cpu-portable.zip', browser_download_url: 'BASE/windows-cpu-portable.zip', size: runtimeZip.length },
    { name: 'audio-v0.9.4-bin-windows-x64-vulkan.zip', browser_download_url: 'BASE/windows-vulkan.zip', size: runtimeZip.length },
    { name: 'audio-v0.9.4-bin-ubuntu-x64-cpu.tar.gz', browser_download_url: 'BASE/ubuntu-cpu.tar.gz', size: linuxRuntimeTar.length },
    { name: 'audio-v0.9.4-bin-ubuntu-x64-vulkan.tar.gz', browser_download_url: 'BASE/ubuntu-vulkan.tar.gz', size: linuxRuntimeTar.length },
    { name: 'audio-v0.9.4-bin-macos-arm64-metal.tar.gz', browser_download_url: 'BASE/macos-arm64-metal.tar.gz', size: macRuntimeTar.length },
    { name: 'audio-v0.9.4-bin-macos-x64-metal.tar.gz', browser_download_url: 'BASE/macos-x64-metal.tar.gz', size: macRuntimeTar.length },
    { name: 'audio-v0.9.4-cudart-windows-x64-cuda13.3.zip', browser_download_url: 'BASE/cudart.zip', size: cudartZip.length },
    { name: 'audio-v0.9.4-cudart-ubuntu-x64-cuda13.3.tar.gz', browser_download_url: 'BASE/cudart-linux.tar.gz', size: linuxRuntimeTar.length },
    { name: 'audio-v0.9.4-lib-windows-x64-cuda13.3.zip', browser_download_url: 'BASE/lib.zip', size: 1 },
  ],
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (body, headers = {}) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, ...headers })
      res.end(body)
    }
    if (url.pathname === '/api/release') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(release).replaceAll('BASE', `http://127.0.0.1:${server.address().port}`))
      return
    }
    if (url.pathname === '/windows-cuda.zip' || url.pathname === '/windows-cpu.zip' || url.pathname === '/windows-cpu-portable.zip' || url.pathname === '/windows-vulkan.zip') return send(runtimeZip)
    if (url.pathname === '/cudart.zip') return send(cudartZip)
    if (url.pathname === '/ffmpeg.zip') return send(ffmpegZip)
    if (url.pathname === '/ubuntu-cpu.tar.gz' || url.pathname === '/ubuntu-vulkan.tar.gz') return send(linuxRuntimeTar)
    if (url.pathname === '/macos-arm64-metal.tar.gz' || url.pathname === '/macos-x64-metal.tar.gz') return send(macRuntimeTar)
    if (url.pathname === '/cudart-linux.tar.gz') return send(linuxRuntimeTar)
    if (url.pathname.startsWith('/broken/')) {
      res.writeHead(500)
      res.end('nope')
      return
    }
    if (url.pathname.includes('/resolve/main/')) {
      const range = req.headers.range
      let start = 0
      if (range) start = Number(range.replace(/bytes=(\d+)-.*/, '$1'))
      const slice = modelPayload.subarray(start)
      res.writeHead(start > 0 ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': slice.length,
        ...(start > 0 ? { 'content-range': `bytes ${start}-${modelPayload.length - 1}/${modelPayload.length}` } : {}),
      })
      res.end(slice)
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise(server)))
}

function freshConfig(assetsDir, overrides = {}) {
  return resolveConfig({ assetsDir, assetsAutoDownload: true, ...overrides })
}

async function main() {
  console.log('toolkit: assets bootstrap\n')

  // 1. target selection
  const pick = (platform, backend, arch) => pickReleaseAsset(release.assets, { platform, backend, arch })?.name
  check('windows/cuda picks the newest CUDA build', pick('windows', 'cuda') === 'audio-v0.9.4-bin-windows-x64-cuda13.3.zip', pick('windows', 'cuda'))
  check('windows/cpu prefers the non-portable build', pick('windows', 'cpu') === 'audio-v0.9.4-bin-windows-x64-cpu.zip', pick('windows', 'cpu'))
  check('windows/vulkan is available', pick('windows', 'vulkan') === 'audio-v0.9.4-bin-windows-x64-vulkan.zip', pick('windows', 'vulkan'))
  check('linux/cpu picks the tar.gz build', pick('linux', 'cpu') === 'audio-v0.9.4-bin-ubuntu-x64-cpu.tar.gz', pick('linux', 'cpu'))
  check('linux/vulkan is available', pick('linux', 'vulkan') === 'audio-v0.9.4-bin-ubuntu-x64-vulkan.tar.gz', pick('linux', 'vulkan'))
  check('macos/metal uses the arm64 build', pick('darwin', 'metal', 'arm64') === 'audio-v0.9.4-bin-macos-arm64-metal.tar.gz', pick('darwin', 'metal', 'arm64'))
  check('unknown backend has no build', pick('windows', 'metal') === undefined)
  check('auto backend follows the platform', pick('darwin', 'auto', 'arm64') === 'audio-v0.9.4-bin-macos-arm64-metal.tar.gz', pick('darwin', 'auto', 'arm64'))
  check('availableTargets lists the shipped combinations', availableTargets(release.assets).length >= 6, availableTargets(release.assets).join(' '))
  check(
    'cudart follows the chosen runtime',
    pickCudartAsset(release.assets, 'audio-v0.9.4-bin-windows-x64-cuda13.3.zip')?.name === 'audio-v0.9.4-cudart-windows-x64-cuda13.3.zip',
    pickCudartAsset(release.assets, 'audio-v0.9.4-bin-windows-x64-cuda13.3.zip')?.name,
  )

  // 2. archive readers
  check('zip: reads central directory', readZipEntries(runtimeZip).length === 3, `${readZipEntries(runtimeZip).length} entries`)
  const stripDir = join(SCRATCH, 'zip-strip')
  extractZip(runtimeZip, stripDir)
  check('zip: strips the common top-level directory', existsSync(join(stripDir, 'audiocpp_server.exe')))
  check('zip: flattens selected entries', (() => {
    const flatDir = join(SCRATCH, 'zip-flat')
    extractZip(cudartZip, flatDir, { filter: (name) => name.endsWith('.dll'), flatten: true })
    return existsSync(join(flatDir, 'cublas64_13.dll')) && !existsSync(join(flatDir, 'cuda'))
  })())
  check('tar: reads entries', readTarEntries(makeTar({ 'a/b.txt': 'x', 'a/c.txt': 'y' })).length === 2)
  const tarDir = join(SCRATCH, 'tar-strip')
  extractTarGz(linuxRuntimeTar, tarDir)
  check('tar: strips the common top-level directory', existsSync(join(tarDir, 'audiocpp_server')))
  check(
    'tar: honours an extension filter',
    (() => {
      const only = join(SCRATCH, 'tar-filter')
      extractTarGz(linuxRuntimeTar, only, { filter: (name) => name.endsWith('.json') })
      return existsSync(join(only, 'model_specs', 'index_tts2.json')) && !existsSync(join(only, 'audiocpp_server'))
    })(),
  )

  // 3. end-to-end provisioning for the host platform
  const server = await startServer()
  const base = `http://127.0.0.1:${server.address().port}`
  const host = releasePlatform(process.platform)
  const backend = defaultBackend(host)
  const assetsDir = join(SCRATCH, 'install')
  const config = freshConfig(assetsDir)
  const logs = []
  try {
    // ffmpeg may already be satisfied by PATH; the four files are always missing.
    const initialMissing = missingAssets(config)
    check(
      'fresh root reports the missing assets',
      ['audio.cpp 运行时', 'TTS 模型', 'ASR 模型', 'VAD 模型'].every((label) => initialMissing.includes(label)),
      initialMissing.join(', '),
    )

    const first = await ensureAssets(config, {
      apiUrl: `${base}/api/release`,
      modelBases: [base],
      ffmpegUrl: `${base}/ffmpeg.zip`,
      platform: process.platform,
      backend,
      inProcess: true,
      log: (line) => logs.push(line),
    })
    check('provisioning reports success', first.ok === true && first.provisioned === true, `${first.root}`)
    check(`engine binary installed (${host})`, existsSync(join(assetsDir, 'bin', 'audio.cpp', SERVER_BINARY)))
    check('release model specs installed', existsSync(join(assetsDir, 'bin', 'audio.cpp', 'model_specs', 'index_tts2.json')))
    check(
      'all three models installed',
      existsSync(join(assetsDir, 'bin', 'models', 'IndexTTS2.5-GGUF', 'index-tts2_5-f16.gguf')) &&
        existsSync(join(assetsDir, 'bin', 'models', 'SenseVoice-Small-GGUF', 'sensevoice-small-q8-audiocpp-v1.gguf')) &&
        existsSync(join(assetsDir, 'bin', 'models', 'PulseVAD-GGUF', 'pulsevad-2.1k-f32.gguf')),
    )
    check('marker written', existsSync(join(assetsDir, 'assets.json')))
    check('assets now complete', missingAssets(freshConfig(assetsDir)).length === 0)
    check('progress is logged', logs.some((line) => line.includes('[assets]')), `${logs.length} lines`)

    // ffmpeg ships with the assets on Windows (skipped when PATH already has one).
    const ffmpegDir = join(SCRATCH, 'ffmpeg-install')
    const ffmpegCfg = resolveConfig({
      assetsDir: ffmpegDir,
      ffmpegPath: join(ffmpegDir, 'bin', 'ffmpeg', 'ffmpeg.exe'),
    })
    const seeded = await installFfmpeg(ffmpegCfg, { ffmpegUrl: `${base}/ffmpeg.zip`, platform: 'win32' })
    check(
      'ffmpeg is installed with the assets',
      seeded.installed === true && existsSync(join(ffmpegDir, 'bin', 'ffmpeg', 'ffmpeg.exe')),
      JSON.stringify(seeded),
    )
    const again = await installFfmpeg(ffmpegCfg, { ffmpegUrl: `${base}/ffmpeg.zip`, platform: 'win32' })
    check('ffmpeg install is a no-op when present', again.installed === false && again.reason === 'exists', JSON.stringify(again))

    // Linux uses `ffmpeg` (no .exe) and only accepts a custom URL, not the
    // bundled Windows build. This mirrors what CI exercises on ubuntu.
    const linuxDir = join(SCRATCH, 'ffmpeg-linux')
    const linuxCfg = resolveConfig({
      assetsDir: linuxDir,
      ffmpegPath: join(linuxDir, 'bin', 'ffmpeg', 'ffmpeg'),
    })
    const linuxInstall = await installFfmpeg(linuxCfg, { ffmpegUrl: `${base}/ffmpeg.zip`, platform: 'linux' })
    check(
      'ffmpeg fixture installs on linux',
      linuxInstall.installed === true && existsSync(join(linuxDir, 'bin', 'ffmpeg', 'ffmpeg')),
      JSON.stringify(linuxInstall),
    )

    // macOS has its own static builds; the bundled URL follows the CPU arch.
    check(
      'ffmpeg sources follow platform and arch',
      ffmpegSourceUrl('darwin', 'arm64').includes('arm') &&
        ffmpegSourceUrl('darwin', 'x64').includes('intel') &&
        ffmpegSourceUrl('linux') === '' &&
        ffmpegSourceUrl('win32').includes('gyan'),
      ffmpegSourceUrl('darwin', 'arm64'),
    )
    const macDir = join(SCRATCH, 'ffmpeg-macos')
    const macCfg = resolveConfig({
      assetsDir: macDir,
      ffmpegPath: join(macDir, 'bin', 'ffmpeg', 'ffmpeg'),
    })
    const macInstall = await installFfmpeg(macCfg, { ffmpegUrl: `${base}/ffmpeg.zip`, platform: 'darwin' })
    check(
      'ffmpeg fixture installs on macos',
      macInstall.installed === true && existsSync(join(macDir, 'bin', 'ffmpeg', 'ffmpeg')),
      JSON.stringify(macInstall),
    )

    const second = await ensureAssets(freshConfig(assetsDir), { platform: process.platform, backend, inProcess: true })
    check('second call is a no-op', second.provisioned === false)

    // ffmpeg is required: a failed download must fail the install with a reason.
    {
      const saved = { PATH: process.env.PATH, Path: process.env.Path }
      process.env.PATH = ''
      process.env.Path = ''
      let failed
      try {
        const tolerantDir = join(SCRATCH, 'ffmpeg-fail')
        await ensureAssets(resolveConfig({ assetsDir: tolerantDir, assetsAutoDownload: true }), {
          apiUrl: `${base}/api/release`,
          modelBases: [base],
          ffmpegUrl: `${base}/nope.zip`,
          platform: process.platform,
          backend,
          inProcess: true,
        })
      } catch (error) {
        failed = error.message
      } finally {
        process.env.PATH = saved.PATH
        process.env.Path = saved.Path
      }
      check('a failed ffmpeg download fails the install', String(failed).includes('ffmpeg'), failed)
    }

    // 4. resume: a .part file must continue instead of restarting
    const resumeDir = join(SCRATCH, 'resume')
    const resumeConfig = freshConfig(resumeDir)
    const modelPath = join(resumeDir, 'bin', 'models', 'PulseVAD-GGUF', 'pulsevad-2.1k-f32.gguf')
    mkdirSync(dirname(modelPath), { recursive: true })
    writeFileSync(`${modelPath}.part`, modelPayload.subarray(0, 100 * 1024))
    await ensureAssets(resumeConfig, {
      apiUrl: `${base}/api/release`,
      modelBases: [base],
      ffmpegUrl: `${base}/ffmpeg.zip`,
      platform: process.platform,
      backend,
      inProcess: true,
    })
    check('resumed file is byte-identical', readFileSync(modelPath).equals(modelPayload), `${statSync(modelPath).size} bytes`)

    // 5. mirror fallback: the first base fails, the second serves the file
    const fallbackDir = join(SCRATCH, 'fallback')
    await ensureAssets(freshConfig(fallbackDir), {
      apiUrl: `${base}/api/release`,
      modelBases: [`${base}/broken`, base],
      ffmpegUrl: `${base}/ffmpeg.zip`,
      platform: process.platform,
      backend,
      inProcess: true,
    })
    check('falls back to the next model mirror', existsSync(join(fallbackDir, 'bin', 'models', 'PulseVAD-GGUF', 'pulsevad-2.1k-f32.gguf')))

    // 6. guards
    let disabled
    try {
      await ensureAssets(resolveConfig({ assetsDir: join(SCRATCH, 'off'), assetsAutoDownload: false }), { inProcess: true })
    } catch (error) {
      disabled = error.message
    }
    check('auto-download can be turned off', String(disabled).includes('运行时依赖'), disabled)

    let manual
    try {
      await ensureAssets(
        resolveConfig({
          assetsDir: join(SCRATCH, 'manual'),
          assetsAutoDownload: true,
          binDir: join(SCRATCH, 'manual', 'bin', 'audio.cpp'),
        }),
        { platform: process.platform, inProcess: true },
      )
    } catch (error) {
      manual = error.message
    }
    check('manual binDir is never overwritten', String(manual).includes('手动指定'), manual)

    const otherPlatform = host === 'windows' ? 'linux' : 'win32'
    let crossPlatform
    try {
      await ensureAssets(resolveConfig({ assetsDir: join(SCRATCH, 'cross'), assetsAutoDownload: true }), {
        platform: otherPlatform,
        inProcess: true,
      })
    } catch (error) {
      crossPlatform = error.message
    }
    check('cross-platform install is refused', String(crossPlatform).includes('只能为本机'), crossPlatform)

    // 7. HF_ENDPOINT override
    const previous = process.env.HF_ENDPOINT
    process.env.HF_ENDPOINT = 'https://hf-mirror.example/'
    check('HF_ENDPOINT replaces the mirror list', modelBases().length === 1 && modelBases()[0] === 'https://hf-mirror.example')
    if (previous === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = previous
  } finally {
    server.close()
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((result) => result.name).join(', ')}`)
    process.exitCode = 1
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
await main()
rmSync(SCRATCH, { recursive: true, force: true })
