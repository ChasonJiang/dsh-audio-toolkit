/**
 * Shared configuration for the DSH audio toolkit.
 *
 * Two consumers:
 *  - the DSH host plugin (`src/index.js`) resolves the panel config, starts and
 *    stops the resident audio.cpp server, and publishes the resolved config to
 *    `state/config.json`;
 *  - the MCP server (`mcp/server.mjs`) reads that file on every call and talks to
 *    the resident server over HTTP.
 *
 * Every Config field is a **top-level** key on purpose: the DSH settings form
 * model addresses form fields by single-segment paths, so nested objects cannot
 * be edited from the plugin panel.
 *
 * The module only uses Node builtins.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Absolute path of the toolkit package root (the repository root). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Directory that owns `bin/` (audio.cpp release + models) and `voices/`.
 *
 * Always the package root: the package *is* the repository root. Do not derive
 * it from the parent directory — on a fresh clone (no `bin/` yet) or under
 * `node_modules` that would point outside the project.
 */
export const ASSET_ROOT = PACKAGE_ROOT

/** Back-compat alias: tests and scripts call the asset root `REPO_ROOT`. */
export const REPO_ROOT = ASSET_ROOT

/** audio.cpp executable names on this platform (udiocpp_server.exe on Windows). */
export const SERVER_BINARY = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server'
export const CLI_BINARY = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli'

/** ffmpeg executable name used when a directory is configured instead of a file. */
export const FFMPEG_BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/**
 * Toolkit version, read from package.json so it is declared exactly once.
 * Falls back to a neutral value only if the manifest is unreadable.
 */
export function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Version of the toolkit, kept in sync with package.json by construction. */
export const TOOLKIT_VERSION = readPackageVersion()

/**
 * Where the resolved config and engine artifacts live.
 *
 * Defaults to `state/` inside the package. Set `AUDIO_TOOLKIT_STATE_DIR` when the
 * package itself is read-only (an npm install under `node_modules`), so the
 * plugin has a writable place for its published config and logs.
 */
export const STATE_DIR = process.env.AUDIO_TOOLKIT_STATE_DIR
  ? resolve(process.env.AUDIO_TOOLKIT_STATE_DIR)
  : join(PACKAGE_ROOT, 'state')
export const STATE_CONFIG_PATH = join(STATE_DIR, 'config.json')
export const STATE_ENGINE_CONFIG_PATH = join(STATE_DIR, 'engine.json')
export const STATE_LOG_PATH = join(STATE_DIR, 'engine.log')

/** Environment override used by tests and by manual MCP runs. */
export const CONFIG_ENV = 'AUDIO_TOOLKIT_CONFIG'

/**
 * Per-user asset root used when the package ships no `bin/` (a git/npm install).
 *
 * `DSH_AUDIO_TOOLKIT_ASSETS` overrides it, which is also how the tests point at
 * a temporary directory.
 */
export function userAssetsDir() {
  const override = process.env.DSH_AUDIO_TOOLKIT_ASSETS
  if (override) return resolve(override)
  return join(homedir(), '.dsh', 'audio-toolkit')
}

/**
 * Where `bin/` lives: an explicit config value first, then the environment, then
 * the package itself (development / `link:` install), then the per-user cache.
 *
 * The last fallback is the *target* for the automatic download, so a fresh
 * `github:` install resolves to a writable path before anything exists there.
 */
export function discoverAssetsRoot(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit) return resolvePath(explicit)
  const env = process.env.DSH_AUDIO_TOOLKIT_ASSETS
  if (env) return resolve(env)
  if (existsSync(join(PACKAGE_ROOT, 'bin', 'audio.cpp'))) return PACKAGE_ROOT
  return userAssetsDir()
}

/** Model file layout under `<assets>/bin/models`. */
const MODEL_LAYOUT = {
  tts: join('IndexTTS2.5-GGUF', 'index-tts2_5-f16.gguf'),
  asr: join('SenseVoice-Small-GGUF', 'sensevoice-small-q8-audiocpp-v1.gguf'),
  vad: join('PulseVAD-GGUF', 'pulsevad-2.1k-f32.gguf'),
}

/**
 * Default configuration, flat and absolute where it matters so the panel form
 * shows real values. Empty path strings mean "derive from the repository".
 * @type {Record<string, any>}
 */
export const DEFAULT_CONFIG = {
  mcpServerName: 'audio',
  toolCallTimeoutMs: 900_000,
  maxConcurrentCalls: 2,

  engineEnabled: true,
  engineAutoStart: true,
  engineHost: '127.0.0.1',
  enginePort: 8788,
  engineIdleUnloadSeconds: 300,
  engineMaxLoadedModels: 0,

  // Empty path fields mean "derive from assetsDir"; the panel shows 自动.
  setupChoice: '',
  assetsDir: '',
  assetsAutoDownload: false,
  assetsProxyEnabled: false,
  assetsProxy: '',
  assetsApiPort: 8789,
  binDir: '',
  cliPath: '',
  ffmpegPath: '',
  modelsDir: '',
  backend: 'cuda',
  device: 0,
  threads: 0,
  extraArgs: '',

  ttsFamily: 'index_tts2',
  ttsModel: '',
  ttsDefaultVoiceRef: '',
  ttsVoiceDir: '',
  ttsLanguage: 'auto',
  ttsEmotion: '',
  ttsSessionOptions: '',

  asrFamily: 'sense_asr',
  asrModel: '',
  asrVadModel: '',
  asrChunkMode: 'fixed',
  asrChunkSeconds: 30,
  asrLanguage: 'auto',
  asrEnableItn: true,
  asrSessionOptions: '',
  asrMinSegmentMs: 300,
  asrMergeGapMs: 400,

  outputFolder: 'audio_toolkit_outputs',
}

/** Read a config value that may be a schemastery volatile reference. */
export function readValue(value, fallback) {
  const raw =
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? safeGet(value) : value
  return raw === undefined || raw === null ? fallback : raw
}

function safeGet(ref) {
  try {
    return ref.get()
  } catch {
    return undefined
  }
}

/** Coerce to string, trimming; empty/nullish becomes ''. */
function str(value, fallback = '') {
  const v = readValue(value, fallback)
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? fallback : String(v)
}

/** Read a path-like value where a blank string means "derive the default". */
function pathOr(value, fallback) {
  const configured = str(value, '')
  return configured || fallback
}

/** Coerce to a finite number. */
function num(value, fallback) {
  const v = readValue(value, fallback)
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Coerce to a non-negative integer. */
function int(value, fallback, { min = 0 } = {}) {
  const n = Math.trunc(num(value, fallback))
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

/** Coerce to boolean, accepting the strings a text field would submit. */
function bool(value, fallback) {
  const v = readValue(value, fallback)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(t)) return true
    if (['false', '0', 'no', 'off'].includes(t)) return false
  }
  return fallback
}

/**
 * Split a whitespace-separated option string into tokens, honoring double quotes
 * so values with spaces (emotion text, model paths) survive.
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitTokens(value) {
  const raw = readValue(value, '')
  if (Array.isArray(raw)) return raw.map((item) => str(item)).filter(Boolean)
  const text = str(raw, '')
  if (!text) return []
  const tokens = []
  let current = ''
  let quote = ''
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** Normalize one path entry: absolute stays, relative resolves against `base`. */
export function resolvePath(value, base = REPO_ROOT) {
  const raw = str(value, '')
  if (!raw) return ''
  const expanded = raw.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '')
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

/**
 * Search PATH for an executable (Windows also tries .exe/.cmd/.bat).
 * Used as the ffmpeg fallback when the configured path is absent.
 */
export function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (!directory) continue
    for (const extension of exts) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Well-known ffmpeg locations outside PATH.
 *
 * GUI launches on macOS often inherit a minimal PATH that misses Homebrew, so
 * check the usual prefixes explicitly before giving up.
 */
const FFMPEG_FALLBACK_DIRS =
  process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
    : process.platform === 'linux'
      ? ['/usr/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']
      : []

/** Look for ffmpeg in the platform's common install prefixes. */
export function ffmpegFallbackPath() {
  for (const directory of FFMPEG_FALLBACK_DIRS) {
    const candidate = join(directory, 'ffmpeg')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Report whether a path is an existing file. */
export function isFile(path) {
  if (!path) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Report whether a path is an existing directory. */
export function isDir(path) {
  if (!path) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Turn a user-supplied folder name into one safe directory name.
 *
 * The panel only asks for a folder name, so an absolute path or a `..` escape is
 * reduced to its last segment and path separators/invalid characters are
 * replaced. Never returns an empty string.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeFolderName(value) {
  const raw = str(value, '').replace(/[\\/]+$/, '')
  const last = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = last
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .replace(/^\.+$/, '-')
    // Windows silently drops trailing dots and spaces, which would desync the
    // folder the tool reports from the one on disk.
    .replace(/[. ]+$/, '')
    .trim()
  if (!cleaned) return DEFAULT_CONFIG.outputFolder
  // CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are device names — with or without an
  // extension — and mkdir fails on them.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned
}

/**
 * Merge a raw (possibly partial, possibly volatile-ref) flat config over the
 * defaults and normalize every field.
 * @param {Record<string, any>} raw
 * @param {{baseDir?: string}} [options] session working directory the output
 *   folder is resolved against (host tools pass the live session directory)
 */
export function resolveConfig(raw = {}, options = {}) {
  const get = (key) => (raw && typeof raw === 'object' ? raw[key] : undefined)
  const baseDir = resolvePath(options.baseDir || '') || process.cwd()

  // Assets: every path field defaults to "auto". An explicit binDir/modelsDir
  // wins; otherwise both follow the discovered asset root.
  const assetsRoot = discoverAssetsRoot(pathOr(get('assetsDir'), DEFAULT_CONFIG.assetsDir))
  const binOverride = pathOr(get('binDir'), '')
  const modelsOverride = pathOr(get('modelsDir'), '')
  const binDir = resolvePath(binOverride || join(assetsRoot, 'bin', 'audio.cpp'))
  const modelsDir = resolvePath(modelsOverride || join(assetsRoot, 'bin', 'models'))
  const ttsModel = resolvePath(pathOr(get('ttsModel'), '') || join(modelsDir, MODEL_LAYOUT.tts))
  const asrModel = resolvePath(pathOr(get('asrModel'), '') || join(modelsDir, MODEL_LAYOUT.asr))
  const asrVadModel = resolvePath(pathOr(get('asrVadModel'), '') || join(modelsDir, MODEL_LAYOUT.vad))
  // `ffmpegPath` may point at the executable or at the directory holding it.
  const ffmpegConfigured = resolvePath(pathOr(get('ffmpegPath'), '') || join(assetsRoot, 'bin', 'ffmpeg', FFMPEG_BINARY))
  const ffmpegPath = isDir(ffmpegConfigured) ? join(ffmpegConfigured, FFMPEG_BINARY) : ffmpegConfigured
  // Output: a folder *name* under the session working directory. An absolute
  // value is honored as-is for advanced users.
  const folderRaw = pathOr(get('outputFolder'), DEFAULT_CONFIG.outputFolder)
  const outputFolder = sanitizeFolderName(folderRaw)
  const outputDir = isAbsolute(folderRaw) ? resolvePath(folderRaw) : join(baseDir, outputFolder)

  const host = str(get('engineHost'), DEFAULT_CONFIG.engineHost) || '127.0.0.1'
  const port = Math.min(Math.max(int(get('enginePort'), DEFAULT_CONFIG.enginePort, { min: 1 }), 1), 65535)

  const serverName = (str(get('mcpServerName'), DEFAULT_CONFIG.mcpServerName) || 'audio').replace(
    /[^A-Za-z0-9_-]/g,
    '',
  )

  return {
    serverName,
    mcp: {
      serverName,
      toolCallTimeoutMs: Math.min(
        Math.max(int(get('toolCallTimeoutMs'), DEFAULT_CONFIG.toolCallTimeoutMs, { min: 1 }), 1_000),
        3_600_000,
      ),
      maxConcurrentCalls: Math.min(Math.max(int(get('maxConcurrentCalls'), DEFAULT_CONFIG.maxConcurrentCalls, { min: 1 }), 1), 8),
    },
    assets: {
      root: assetsRoot,
      autoDownload: bool(get('assetsAutoDownload'), DEFAULT_CONFIG.assetsAutoDownload),
      // A proxy is only used when the user explicitly enables it.
      proxy: bool(get('assetsProxyEnabled'), false) ? str(get('assetsProxy'), '') : '',
      apiPort: Math.min(Math.max(int(get('assetsApiPort'), DEFAULT_CONFIG.assetsApiPort, { min: 1024 }), 1024), 65535),
      // True when binDir/modelsDir follow the asset root, i.e. the plugin may provision it.
      derived: !binOverride && !modelsOverride,
    },
    engine: {
      enabled: bool(get('engineEnabled'), DEFAULT_CONFIG.engineEnabled),
    idleUnloadMs: Math.max(int(get('engineIdleUnloadSeconds'), DEFAULT_CONFIG.engineIdleUnloadSeconds, { min: 0 }), 0) * 1000,
    maxLoadedModels: Math.max(int(get('engineMaxLoadedModels'), 0, { min: 0 }), 0),
      autoStart: bool(get('engineAutoStart'), DEFAULT_CONFIG.engineAutoStart),
      host,
      port,
      url: `http://${host}:${port}`,
      exePath: join(binDir, SERVER_BINARY),
      configPath: STATE_ENGINE_CONFIG_PATH,
      logPath: STATE_LOG_PATH,
    },
    audioCpp: {
      binDir,
      cliPath: resolvePath(str(get('cliPath'), '')) || join(binDir, CLI_BINARY),
      ffmpegPath,
      modelsDir,
      backend: str(get('backend'), DEFAULT_CONFIG.backend) || 'cuda',
      device: int(get('device'), 0),
      threads: int(get('threads'), 0),
      extraArgs: splitTokens(get('extraArgs')),
    },
    tts: {
      id: 'tts',
      family: str(get('ttsFamily'), DEFAULT_CONFIG.ttsFamily) || 'index_tts2',
      model: ttsModel,
      defaultVoiceRef: resolvePath(str(get('ttsDefaultVoiceRef'), '')),
      voiceDir: resolvePath(pathOr(get('ttsVoiceDir'), '') || join(assetsRoot, 'voices')),
      language: str(get('ttsLanguage'), 'auto') || 'auto',
      emotion: str(get('ttsEmotion'), ''),
      sessionOptions: splitTokens(get('ttsSessionOptions')),
    },
    asr: {
      id: 'asr',
      family: str(get('asrFamily'), DEFAULT_CONFIG.asrFamily) || 'sense_asr',
      model: asrModel,
      vadModel: asrVadModel,
      chunkMode: str(get('asrChunkMode'), DEFAULT_CONFIG.asrChunkMode) || 'fixed',
      chunkSeconds: Math.min(Math.max(num(get('asrChunkSeconds'), DEFAULT_CONFIG.asrChunkSeconds), 1), 600),
      language: str(get('asrLanguage'), 'auto') || 'auto',
      enableItn: bool(get('asrEnableItn'), DEFAULT_CONFIG.asrEnableItn),
      minSegmentMs: Math.min(Math.max(int(get('asrMinSegmentMs'), DEFAULT_CONFIG.asrMinSegmentMs, { min: 50 }), 50), 10000),
      mergeGapMs: Math.min(Math.max(int(get('asrMergeGapMs'), DEFAULT_CONFIG.asrMergeGapMs), 0), 5000),
      sessionOptions: splitTokens(get('asrSessionOptions')),
    },
    output: {
      baseDir,
      folder: outputFolder,
      dir: outputDir,
      // Engine/tool scratch lives in the package state dir: it must always be
      // writable and must never leak audio.cpp's GGUF staging into the user's
      // output folder.
      tmp: join(STATE_DIR, 'tmp'),
    },
  }
}

/**
 * Build the `audiocpp_server` config for the resident engine.
 * @param {ReturnType<typeof resolveConfig>} config
 */
export function toEngineConfig(config) {
  return {
    host: config.engine.host,
    port: config.engine.port,
    backend: config.audioCpp.backend,
    device: config.audioCpp.device,
    ...(config.audioCpp.threads > 0 ? { threads: config.audioCpp.threads } : {}),
    lazy_load: true,
    max_loaded_models: config.engine.maxLoadedModels,
    idle_unload_ms: config.engine.idleUnloadMs,
    models: [
      {
        id: config.tts.id,
        family: config.tts.family,
        path: config.tts.model,
        task: 'tts',
        mode: 'offline',
        ...(config.tts.sessionOptions.length > 0 ? { session_options: toOptionMap(config.tts.sessionOptions) } : {}),
      },
      {
        id: config.asr.id,
        family: config.asr.family,
        path: config.asr.model,
        task: 'asr',
        mode: 'offline',
        default_request_options: {
          audio_chunk_mode: config.asr.chunkMode,
          audio_chunk_duration_sec: config.asr.chunkSeconds,
        },
        session_options: {
          ...(isFile(config.asr.vadModel) ? { [`${config.asr.family}.vad_model_path`]: config.asr.vadModel } : {}),
          ...toOptionMap(config.asr.sessionOptions),
        },
      },
    ],
  }
}

/** `["a.b=1", "a.c=2"]` → `{ "a.b": "1", "a.c": "2" }` for session options. */
function toOptionMap(tokens) {
  const map = {}
  for (const token of tokens) {
    const index = token.indexOf('=')
    if (index <= 0) continue
    map[token.slice(0, index)] = token.slice(index + 1)
  }
  return map
}

/** Write the resolved config atomically for the MCP server to pick up. */
export function writeStateConfig(config, extra = {}, raw) {
  mkdirSync(STATE_DIR, { recursive: true })
  const payload = JSON.stringify(
    {
      version: TOOLKIT_VERSION,
      updatedAt: new Date().toISOString(),
      config,
      // Flat values so a consumer can re-resolve against its own working directory.
      ...(raw === undefined ? {} : { raw }),
      ...extra,
    },
    null,
    2,
  )
  const temp = `${STATE_CONFIG_PATH}.${process.pid}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, STATE_CONFIG_PATH)
  return STATE_CONFIG_PATH
}

/**
 * Write the audio.cpp server config used to boot the resident engine.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {string} [path] target file (tests point it at a scratch path)
 */
export function writeEngineConfig(config, path = config.engine?.configPath ?? STATE_ENGINE_CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true })
  const payload = JSON.stringify(toEngineConfig(config), null, 2)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, path)
  return path
}

/**
 * Load the config the MCP server should use: state file written by the plugin,
 * else the environment override, else the built-in defaults.
 * @returns {{config: ReturnType<typeof resolveConfig>, source: string, engine: Record<string, any>}}
 */
export function loadStateConfig() {
  const override = process.env[CONFIG_ENV]
  const candidates = [
    override ? { path: resolvePath(override), source: 'env' } : undefined,
    { path: STATE_CONFIG_PATH, source: 'state' },
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!candidate.path || !isFile(candidate.path)) continue
    try {
      // Windows editors like to prepend a BOM; JSON.parse would reject it.
      const text = readFileSync(candidate.path, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(text)
      const raw = parsed?.raw ?? parsed?.config ?? parsed
      return { config: resolveConfig(raw), source: candidate.path, engine: parsed?.engine ?? {} }
    } catch {
      // A corrupt state file must not take the MCP server down; fall through.
    }
  }
  return { config: resolveConfig({}), source: 'defaults', engine: {} }
}

/** Absolute paths of files in `dir` whose name ends with `extension`. */
export function listFiles(dir, extension) {
  if (!isDir(dir)) return []
  return readDirectory(dir)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .map((name) => join(dir, name))
    .sort()
}

function readDirectory(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Truthy when the whole toolkit install looks usable. */
export function inspectInstall(config) {
  const checks = [
    { key: 'serverExe', label: 'audiocpp_server', path: config.engine.exePath, ok: isFile(config.engine.exePath) },
    { key: 'cliPath', label: 'audiocpp_cli', path: config.audioCpp.cliPath, ok: isFile(config.audioCpp.cliPath) },
    { key: 'binDir', label: 'audio.cpp 目录', path: config.audioCpp.binDir, ok: isDir(config.audioCpp.binDir) },
    { key: 'ttsModel', label: `${config.tts.family} 模型`, path: config.tts.model, ok: isFile(config.tts.model) },
    { key: 'asrModel', label: `${config.asr.family} 模型`, path: config.asr.model, ok: isFile(config.asr.model) },
    { key: 'vadModel', label: 'VAD 模型', path: config.asr.vadModel, ok: isFile(config.asr.vadModel) },
    {
      key: 'ffmpeg',
      label: 'ffmpeg（音频转码）',
      path: config.audioCpp.ffmpegPath,
      ok: isFile(config.audioCpp.ffmpegPath) || Boolean(findOnPath('ffmpeg')) || Boolean(ffmpegFallbackPath()),
    },
  ]
  if (config.tts.defaultVoiceRef) {
    checks.push({
      key: 'defaultVoiceRef',
      label: '默认音色参考',
      path: config.tts.defaultVoiceRef,
      ok: isFile(config.tts.defaultVoiceRef),
    })
  }
  return { checks, ok: checks.every((check) => check.ok) }
}

/** One-line summary used by logs. */
export function summarize(config) {
  return [
    `bin=${config.audioCpp.binDir}`,
    `backend=${config.audioCpp.backend}:${config.audioCpp.device}`,
    `engine=${config.engine.url} (${config.engine.enabled ? 'enabled' : 'disabled'})`,
    `tts=${config.tts.family}`,
    `asr=${config.asr.family}`,
  ].join(' ')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function prettyPath(path) {
  return path ? path.replace(/\\/g, '/') : ''
}

export { existsSync }
