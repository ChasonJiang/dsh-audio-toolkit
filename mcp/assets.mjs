/**
 * Runtime assets for the toolkit: audio.cpp release, GGUF models, CUDA DLLs.
 *
 * A `github:` / npm install only ships code — `bin/` is git-ignored — so the
 * plugin resolves a per-user asset root and, on first engine start, fills it in
 * itself. Everything here is plain Node: fetch + streaming + a tiny ZIP reader,
 * because the plugin promises no runtime dependencies.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { TOOLKIT_VERSION, isFile } from '../src/config.js'
import { extractTarGz, isTarGz } from './tar.mjs'
import { resolveFfmpeg } from './transcode.mjs'
import { extractZip } from './zip.mjs'

export const USER_AGENT = 'dsh-audio-toolkit'

/** GitHub release API for the upstream audio.cpp build. */
export const RELEASE_API = 'https://api.github.com/repos/0xShug0/audio.cpp/releases/latest'

/** Hugging Face is where the quantized models live. */
export const MODEL_BASE = 'https://huggingface.co'

/**
 * Where to fetch the GGUF files, in order.
 *
 * `HF_ENDPOINT` wins when set (the same variable `huggingface_hub` uses). In
 * mainland China huggingface.co is often unreachable while `hf-mirror.com`
 * works directly, so it is the automatic fallback — Node's built-in `fetch`
 * does not honour `HTTP(S)_PROXY`, which makes a mirror the dependable route.
 */
export function modelBases() {
  if (process.env.HF_ENDPOINT) return [process.env.HF_ENDPOINT.replace(/\/+$/, '')]
  return [MODEL_BASE, 'https://hf-mirror.com']
}

/** GGUF files the tools expect; `local` keeps the engine's model directory layout. */
export const MODELS = [
  {
    repo: 'audio-cpp/audio.cpp-gguf',
    path: 'IndexTTS2.5-GGUF/index-tts2_5-f16.gguf',
    local: 'IndexTTS2.5-GGUF/index-tts2_5-f16.gguf',
  },
  {
    repo: 'FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp',
    path: 'sensevoice-small-q8-audiocpp-v1.gguf',
    local: 'SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf',
  },
  {
    repo: 'audio-cpp/audio.cpp-gguf',
    path: 'PulseVAD-GGUF/pulsevad-2.1k-f32.gguf',
    local: 'PulseVAD-GGUF/pulsevad-2.1k-f32.gguf',
  },
]




/** Files still missing, as human-readable labels. */
export function missingAssets(config) {
  const missing = []
  if (!isFile(config.engine.exePath)) missing.push('audio.cpp 运行时')
  if (!isFile(config.tts.model)) missing.push('TTS 模型')
  if (!isFile(config.asr.model)) missing.push('ASR 模型')
  if (!isFile(config.asr.vadModel)) missing.push('VAD 模型')
  if (!resolveFfmpeg(config)) missing.push('ffmpeg（音频转码）')
  return missing
}

/** True when the engine, all models and the VAD file are present. */
export function assetsReady(config) {
  return missingAssets(config).length === 0
}
/** Host `process.platform` → the token used in release asset names. */
const RELEASE_PLATFORM = { win32: 'windows', linux: 'ubuntu', darwin: 'macos' }

/** Release token for a host platform (`win32` → `windows`). */
export function releasePlatform(value = process.platform) {
  return RELEASE_PLATFORM[value] ?? String(value)
}

/** Backend to use when the caller did not choose one. */
export function defaultBackend(platform) {
  if (platform === 'macos') return 'metal'
  if (platform === 'windows') return 'cuda'
  // The Ubuntu CUDA archive is a Colab build; CPU is the safe default there.
  return 'cpu'
}

/** Backend token of an asset name (`''` when it is not a backend). */
function backendOf(name) {
  return ['cuda', 'rocm', 'vulkan', 'metal', 'cpu'].find((backend) => new RegExp(`-${backend}`, 'i').test(name)) ?? ''
}

/** Backend token of an asset name. */
export function backendOfAsset(asset) {
  return backendOf(String(asset?.name ?? ''))
}

/** Every `platform/backend` combination the release actually ships. */
export function availableTargets(assets) {
  const out = new Set()
  for (const asset of assets ?? []) {
    const name = String(asset.name ?? '')
    const match = name.match(/-bin-([a-z]+)-([a-z0-9]+)-(cuda|rocm|vulkan|metal|cpu)/i)
    if (match && !/cudart|-lib-/i.test(name)) out.add(`${match[1]}/${match[3]}`)
  }
  return [...out].sort()
}

/**
 * Pick the release archive for a platform/backend.
 *
 * @param {{name: string}[]} assets
 * @param {{platform?: string, backend?: string, arch?: string}} [target]
 *   `platform` accepts a host token (`win32`, `linux`, `darwin`) or a release
 *   token; `backend` may be `auto` (the platform's usual one).
 */
export function pickReleaseAsset(assets, target = {}) {
  const platform = releasePlatform(target.platform ?? process.platform)
  const backend = target.backend && target.backend !== 'auto' ? target.backend : defaultBackend(platform)
  const arch = target.arch ?? (platform === 'macos' && process.arch === 'arm64' ? 'arm64' : 'x64')
  const candidates = (assets ?? []).filter((asset) => {
    const name = String(asset.name ?? '')
    return (
      /-bin-/i.test(name) &&
      !/cudart/i.test(name) &&
      !/-lib-/i.test(name) &&
      /\.(zip|tar\.gz)$/i.test(name) &&
      name.includes(`-${platform}-`) &&
      name.includes(`-${arch}-`)
    )
  })
  const pool = candidates.filter((asset) => backendOf(asset.name) === backend)
  // Prefer the regular build over `-portable`, and a newer CUDA minor.
  const rank = (name) => {
    const cuda = Number(name.match(/-cuda(\d+(?:\.\d+)?)/i)?.[1] ?? 0)
    return (/portable/i.test(name) ? -1 : 0) + cuda * 10
  }
  return pool.sort((a, b) => rank(b.name) - rank(a.name))[0]
}

/**
 * The matching `cudart-*` archive for a chosen runtime archive
 * (`...bin-windows-x64-cuda13.3.zip` → `...cudart-windows-x64-cuda13.3.zip`).
 */
export function pickCudartAsset(assets, runtimeName) {
  const match = String(runtimeName ?? '').match(/-bin-([a-z]+)-([a-z0-9]+)-cuda([\d.]+)(?:-[a-z0-9]+)?\.(?:zip|tar\.gz)$/i)
  if (!match) return undefined
  const [, platform, arch, version] = match
  return (assets ?? []).find(
    (asset) => /cudart/i.test(asset.name) && asset.name.includes(`cudart-${platform}-${arch}-cuda${version}`),
  )
}

/** Extract a release archive, choosing the reader by file name. */
function extractArchive(buffer, name, dest, options) {
  return isTarGz(name) ? extractTarGz(buffer, dest, options) : extractZip(buffer, dest, options)
}

/**
 * Download `url` into `target`, resuming a previous `.part` when the server
 * supports ranges. Verifies the byte count before renaming into place.
 */
async function downloadToFile(url, target, options) {
  const { log = () => {}, label = url, fetchImpl = fetch, timeoutMs = 30 * 60_000, onProgress = () => {}, phase = '' } = options
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.part`
  const start = filesize(part)
  const headers = { 'user-agent': USER_AGENT }
  if (start > 0) headers.range = `bytes=${start}-`

  let response
  try {
    response = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`下载 ${label} 失败：${error?.message ?? error}（检查网络或代理）`)
  }
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载 ${label} 失败：HTTP ${response.status}`)
  }

  const resuming = start > 0 && response.status === 206
  if (!resuming && start > 0) rmSync(part, { force: true })
  const already = resuming ? start : 0
  const expected = Number(response.headers.get('content-length') ?? 0) + already
  const total = expected || 0
  let written = already
  let lastLog = Date.now()

  log(`[assets] 下载 ${label}${total ? `（${formatBytes(total)}）` : ''}${resuming ? ' 续传' : ''}`)
  const out = createWriteStream(part, { flags: resuming ? 'a' : 'w' })
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    written += chunk.length
    onProgress({ phase, file: label, done: written, total })
    const now = Date.now()
    if (now - lastLog > 1000) {
      lastLog = now
      const percent = total ? ` ${Math.floor((written / total) * 100)}%` : ''
      log(`[assets] ${label}${percent}（${formatBytes(written)}）`)
    }
  })
  await pipeline(body, out)

  const size = filesize(part)
  if (total && size !== total) throw new Error(`下载 ${label} 不完整：${size} != ${total}`)
  renameSync(part, target)
  log(`[assets] 完成 ${label}（${formatBytes(size)}）`)
  return target
}

/** Fetch a whole response body into memory (release and redist archives). */
async function downloadBuffer(url, options) {
  const { log = () => {}, label = url, fetchImpl = fetch, timeoutMs = 30 * 60_000, onProgress = () => {}, phase = '' } = options
  log(`[assets] 下载 ${label}`)
  let response
  try {
    response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`下载 ${label} 失败：${error?.message ?? error}（检查网络或代理）`)
  }
  if (!response.ok) throw new Error(`下载 ${label} 失败：HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const chunks = []
  let done = 0
  let lastLog = Date.now()
  for await (const chunk of Readable.fromWeb(response.body)) {
    chunks.push(chunk)
    done += chunk.length
    const now = Date.now()
    if (now - lastLog > 250) {
      lastLog = now
      onProgress({ phase, file: label, done, total })
    }
  }
  const buffer = Buffer.concat(chunks)
  onProgress({ phase, file: label, done: buffer.length, total: buffer.length })
  log(`[assets] 完成 ${label}（${formatBytes(buffer.length)}）`)
  return buffer
}

function filesize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Install the audio.cpp release matching the chosen platform/backend. */
async function installRelease(config, options) {
  const dest = config.audioCpp.binDir
  if (isFile(config.engine.exePath)) return
  const { log = () => {}, apiUrl = RELEASE_API } = options
  const target = { platform: options.platform ?? process.platform, backend: options.backend }
  const wanted = `${releasePlatform(target.platform)}/${target.backend || 'auto'}`
  log(`[assets] 查询 audio.cpp 最新 release：${apiUrl}（目标 ${wanted}）`)
  const response = await (options.fetchImpl ?? fetch)(apiUrl, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`查询 audio.cpp release 失败：HTTP ${response.status}（GitHub API 可能限流）`)
  const release = await response.json()
  const asset = pickReleaseAsset(release.assets, target)
  if (!asset) {
    throw new Error(
      `release ${release.tag_name ?? ''} 没有 ${wanted} 的构建。可选：${availableTargets(release.assets).join('、') || '（无）'}`,
    )
  }
  log(`[assets] 选择 ${asset.name}`)
  const buffer = await downloadBuffer(asset.browser_download_url, { ...options, label: asset.name, phase: 'release' })
  const written = extractArchive(buffer, asset.name, dest)
  log(`[assets] 解压 ${written.length} 个文件到 ${dest}`)

  // The runtime archive does not bundle cuBLAS/cuFFT; for CUDA builds the
  // release ships a matching `cudart-*` archive. Flatten its libraries next to
  // the executable (DLLs on Windows, .so on Linux).
  if (backendOfAsset(asset) === 'cuda') {
    const cudart = pickCudartAsset(release.assets, asset.name)
    if (cudart) {
      const archive = await downloadBuffer(cudart.browser_download_url, { ...options, label: cudart.name, phase: 'cuda' })
      const libs = extractArchive(archive, cudart.name, dest, {
        filter: (name) => /\.(dll|so(\.\d+)*)$/i.test(name),
        flatten: true,
      })
      log(`[assets] 解压 ${libs.length} 个 CUDA 运行时库到 ${dest}`)
    }
  }
}

/** Windows ffmpeg build used when the machine has none (≈110 MB). */
export const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

/**
 * Download ffmpeg into the asset root when it is missing.
 *
 * Only the Windows build has a stable direct download; Linux/macOS get a hint to
 * install through the system package manager (the proxy/PATH fallback still
 * applies at runtime).
 */
export async function installFfmpeg(config, options = {}) {
  const { log = () => {} } = options
  const platform = options.platform ?? process.platform
  // The bundled URL is a Windows build; a caller-supplied URL (tests, mirrors)
  // may target any platform.
  if (platform !== 'win32' && !options.ffmpegUrl) return { installed: false, reason: 'platform' }
  const dest = dirname(config.audioCpp.ffmpegPath)
  const target = join(dest, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (isFile(target)) return { installed: false, reason: 'exists' }
  const buffer = await downloadBuffer(options.ffmpegUrl ?? FFMPEG_URL, { ...options, label: 'ffmpeg', phase: 'ffmpeg' })
  const written = extractZip(buffer, dest, { filter: (name) => /(^|\/)ffmpeg(\.exe)?$/i.test(name), flatten: true })
  if (!isFile(target)) {
    const found = written.find((path) => isFile(path))
    if (found) renameSync(found, target)
  }
  if (!isFile(target)) throw new Error('ffmpeg 下载后没有找到可执行文件')
  log(`[assets] ffmpeg 已安装到 ${dest}`)
  return { installed: true }
}

/** Provision ffmpeg when the deployment manages the paths itself. */
async function ensureFfmpeg(config, options = {}) {
  const { log = () => {} } = options
  if (resolveFfmpeg(config)) return
  if (!config.assets.derived) return
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('缺少 ffmpeg：请先用系统包管理器安装（Windows 会自动下载），或设置 ffmpegPath')
  }
  // ffmpeg is required for transcoding: fail the install instead of leaving a
  // half-working deployment.
  await installFfmpeg(config, options)
}

/** Install the three GGUF files. */
async function installModels(config, options) {
  const bases = options.modelBases ?? modelBases()
  for (const model of MODELS) {
    const target = join(config.audioCpp.modelsDir, ...model.local.split('/'))
    if (isFile(target)) continue
    let lastError
    for (const base of bases) {
      try {
        await downloadToFile(`${base}/${model.repo}/resolve/main/${model.path}`, target, { ...options, label: model.local })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        options.log?.(`[assets] ${base} 失败，换下一个源：${error?.message ?? error}`)
      }
    }
    if (lastError) throw lastError
  }
}

/**
 * Make sure every asset exists, downloading into the resolved asset root when
 * allowed. Throws (EngineError-ish message) when assets are missing and
 * downloading is disabled or impossible.
 *
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} config
 * @param {{log?: (message: string) => void, apiUrl?: string, modelBases?: string[], fetchImpl?: typeof fetch}} [options]
 */
/**
 * Download every missing asset into the resolved root. Runs in the provision
 * worker process (or in-process for tests).
 */
export async function provisionAssets(config, options = {}) {
  const log = options.log ?? (() => {})
  mkdirSync(config.assets.root, { recursive: true })
  await installRelease(config, { ...options, log })
  await installModels(config, { ...options, log })
  await ensureFfmpeg(config, { ...options, log })
}

/**
 * Run provisioning in a child Node process.
 *
 * `NODE_USE_ENV_PROXY` is read when Node starts, so a proxy can only apply to a
 * fresh process — and a worker also keeps the multi-hundred-MB archives out of
 * the DSH process heap. Progress lines are forwarded to the plugin log.
 */
/** Live install state shared by the panel API and `audio_status`. */
const install = /** @type {Record<string, any>} */ ({
  running: false,
  phase: '',
  file: '',
  done: 0,
  total: 0,
  error: '',
  startedAt: 0,
  cancelled: false,
})

/** Snapshot for the panel / status tool. */
export function installSnapshot() {
  return { ...install }
}

/** Cancel an in-flight install (kills the worker process). */
export function cancelInstall() {
  if (!activeWorker) return false
  install.cancelled = true
  activeWorker.kill()
  activeWorker = null
  install.running = false
  install.error = '已取消'
  return true
}

let activeWorker = null
let activePromise = null

/** Build the child environment: a proxy needs `NODE_USE_ENV_PROXY` at startup. */
function workerEnv(config, options) {
  const proxy =
    options.proxy || config.assets.proxy || process.env.DSH_AUDIO_TOOLKIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  const env = { ...process.env }
  // The host process is Electron: the same binary only acts as Node with this flag.
  if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1'
  if (proxy) {
    env.NODE_USE_ENV_PROXY = '1'
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
  }
  return env
}

/**
 * Run provisioning in a child Node process.
 *
 * `NODE_USE_ENV_PROXY` is read when Node starts, so a proxy can only apply to a
 * fresh process; the worker also keeps multi-hundred-MB archives out of the DSH
 * heap. Progress arrives as `@@P{json}` lines and feeds `installSnapshot()`.
 */
function runInstall(config, options = {}) {
  if (activePromise) return activePromise
  const log = options.log ?? (() => {})
  install.running = true
  install.phase = 'starting'
  install.file = ''
  install.done = 0
  install.total = 0
  install.error = ''
  install.cancelled = false
  install.startedAt = Date.now()

  // Tests run the same code in-process; the real path uses a worker for the
  // proxy support and to keep the archives out of this heap.
  if (options.inProcess) {
    activePromise = (async () => {
      try {
        await provisionAssets(config, {
          ...options,
          log,
          onProgress: (update) => {
            if (update.phase) install.phase = update.phase
            if (update.file !== undefined) install.file = update.file
            if (update.done !== undefined) install.done = update.done
            if (update.total !== undefined) install.total = update.total
          },
        })
        install.running = false
        install.phase = 'done'
        return { ok: true }
      } catch (error) {
        install.running = false
        install.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        activePromise = null
      }
    })()
    return activePromise
  }

  const payload = JSON.stringify({
    config,
    options: {
      apiUrl: options.apiUrl,
      proxy: options.proxy,
      modelBases: options.modelBases,
      platform: options.platform,
      backend: options.backend,
      ffmpegUrl: options.ffmpegUrl,
    },
  })
  const script = join(dirname(fileURLToPath(import.meta.url)), 'provision.mjs')
  let child
  try {
    child = spawn(process.execPath, [script, payload], {
      env: workerEnv(config, options),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    install.running = false
    install.error = `无法启动下载进程：${error.message}`
    return Promise.reject(new Error(install.error))
  }
  activeWorker = child
  let tail = ''
  const handle = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue
      if (line.startsWith('@@P')) {
        try {
          const update = JSON.parse(line.slice(3))
          if (update.phase) install.phase = update.phase
          if (update.file !== undefined) install.file = update.file
          if (update.done !== undefined) install.done = update.done
          if (update.total !== undefined) install.total = update.total
        } catch {
          /* ignore malformed progress */
        }
        continue
      }
      tail = `${tail}\n${line}`.split('\n').slice(-8).join('\n')
      log(line)
    }
  }
  child.stdout.setEncoding('utf8').on('data', handle)
  child.stderr.setEncoding('utf8').on('data', handle)

  activePromise = new Promise((resolvePromise, rejectPromise) => {
    child.on('error', (error) => {
      install.running = false
      install.error = `无法启动下载进程：${error.message}`
      activePromise = null
      activeWorker = null
      rejectPromise(new Error(install.error))
    })
    child.on('close', (code) => {
      activeWorker = null
      activePromise = null
      install.running = false
      if (install.cancelled) {
        install.phase = 'cancelled'
        resolvePromise({ ok: false, cancelled: true })
        return
      }
      if (code === 0) {
        install.phase = 'done'
        resolvePromise({ ok: true })
        return
      }
      install.error = `资产下载失败（退出码 ${code}）${tail ? `：${tail.trim().split('\n').pop()}` : ''}`
      rejectPromise(new Error(install.error))
    })
  })
  return activePromise
}

/**
 * Make sure every asset exists, downloading into the resolved asset root when
 * allowed (automatic path, used by the engine start).
 *
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} config
 * @param {{log?: (message: string) => void, apiUrl?: string, modelBases?: string[], proxy?: string, platform?: string, inProcess?: boolean}} [options]
 */
export async function ensureAssets(config, options = {}) {
  const log = options.log ?? (() => {})
  const root = config.assets.root
  const missing = missingAssets(config)
  if (missing.length === 0) return { ok: true, root, provisioned: false, missing }
  if (!config.assets.autoDownload) {
    throw new Error(
      `运行时资产不完整（缺少 ${missing.join('、')}）。` +
        `打开插件面板，在「运行时依赖」一栏点「安装依赖」，或把 ${root} 下的 bin/ 放到这台机器上。`,
    )
  }
  assertInstallable(config, options)
  log(`[assets] 资产不完整（缺少 ${missing.join('、')}），开始自动下载到 ${root}`)
  await runInstall(config, { ...options, log })
  const remaining = missingAssets(config)
  if (remaining.length > 0) throw new Error(`资产下载后仍不完整：${remaining.join('、')}`)
  writeMarker(config)
  log('[assets] 自动下载完成')
  return { ok: true, root, provisioned: true, missing: [] }
}

/**
 * Manual install requested from the panel: same guards as the automatic path but
 * independent of `assetsAutoDownload` (the user just clicked the button).
 */
export function startInstall(config, options = {}) {
  assertInstallable(config, options)
  const missing = missingAssets(config)
  if (missing.length === 0) return { started: false, reason: 'already-ready' }
  if (install.running) return { started: false, reason: 'busy' }
  runInstall(config, options).then(
    () => writeMarker(config),
    () => {},
  )
  return { started: true }
}

/** Guards shared by the automatic and the manual install paths. */
function assertInstallable(config, options = {}) {
  const host = process.platform
  const target = options.platform ?? host
  const supported = ['win32', 'linux', 'darwin']
  if (!supported.includes(host)) {
    throw new Error(
      `当前系统 ${host} 没有自动安装支持。请把 audio.cpp 与该平台的模型放到 ${config.assets.root}，` +
        `或在面板设置 assetsDir / binDir / modelsDir。`,
    )
  }
  if (releasePlatform(target) !== releasePlatform(host)) {
    throw new Error(
      `只能为本机（${releasePlatform(host)}）安装；选的是 ${releasePlatform(target)}。` +
        `跨平台资产请手动放置，或用面板的 assetsDir 指向已有目录。`,
    )
  }
  if (!config.assets.derived) {
    throw new Error(
      `binDir / modelsDir 是手动指定的，自动下载只会写入 ${config.assets.root}。` +
        `请把那里补全，或清空这两个字段让插件自动管理。`,
    )
  }
}

/** Record the installed toolkit version next to the assets. */
function writeMarker(config) {
  try {
    writeFileSync(
      join(config.assets.root, 'assets.json'),
      `${JSON.stringify({ toolkit: TOOLKIT_VERSION, installedAt: new Date().toISOString(), platform: process.platform }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    /* marker is informational */
  }
}

/** Remove a partially downloaded archive (tests and manual cleanup). */
export function clearPartial(path) {
  for (const suffix of ['', '.part']) {
    try {
      if (existsSync(path + suffix)) rmSync(path + suffix, { force: true })
    } catch {
      /* ignore */
    }
  }
}
/**
 * Remove the automatically managed runtime assets.
 *
 * Only allowed when `binDir`/`modelsDir` follow `assetsDir` — deleting a
 * hand-configured directory is the user's own business, not ours.
 */
export function deleteAssets(config) {
  assertInstallable(config, { platform: process.platform })
  const removed = []
  for (const dir of [config.audioCpp.binDir, config.audioCpp.modelsDir]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }
  const marker = join(config.assets.root, 'assets.json')
  if (existsSync(marker)) rmSync(marker, { force: true })
  install.running = false
  install.phase = ''
  install.error = ''
  install.progress = { phase: '', file: '', done: 0, total: 0 }
  return { removed, root: config.assets.root }
}