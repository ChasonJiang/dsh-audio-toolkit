/**
 * ffmpeg-backed audio normalization.
 *
 * The engine only decodes WAV, and its `auto` / `vad` chunking additionally
 * requires 16 kHz mono input. Rather than teaching two decoders every container,
 * every non-ready input (MP3, FLAC, OGG, M4A, 48 kHz WAV, …) is converted once
 * into a 16 kHz mono PCM16 WAV inside the package scratch dir, then deleted.
 *
 * Same arithmetic the engine would apply internally, so the transcript is
 * unchanged — only the container/rate differs.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { EngineError } from './engine.mjs'
import { runCli } from './audiocpp.mjs'
import { readWavFormat, WavError } from '../src/wav.js'

/** Target layout every consumer (engine + sentence timeline) accepts. */
export const TARGET_SAMPLE_RATE = 16000
export const TARGET_CHANNELS = 1

/**
 * Whether a file can be used as-is.
 *
 * A 16 kHz mono WAV needs no conversion; anything else (including a WAV at
 * another rate) does.
 * @param {string} path
 */
export function isReadyWav(path) {
  try {
    const format = readWavFormat(path)
    return format.sampleRate === TARGET_SAMPLE_RATE && format.channels === TARGET_CHANNELS
  } catch (error) {
    if (error instanceof WavError) return false
    throw error
  }
}

/** Search PATH for an executable named `name` (Windows also tries .exe/.cmd/.bat). */
function findOnPath(name) {
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

/** Whether a path is an existing directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the ffmpeg executable.
 *
 * Order: the configured path (a directory means `ffmpeg.exe` inside it), then
 * PATH. Returns undefined when nothing is usable so the caller can produce an
 * actionable message.
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @returns {string | undefined}
 */
export function resolveFfmpeg(cfg) {
  const configured = cfg?.audioCpp?.ffmpegPath
  if (configured) {
    if (isDirectory(configured)) {
      const inside = join(configured, 'ffmpeg.exe')
      if (existsSync(inside)) return inside
    } else if (existsSync(configured)) {
      return configured
    }
  }
  return findOnPath('ffmpeg')
}

/**
 * Convert any input into a 16 kHz mono PCM16 WAV.
 *
 * The caller owns `workDir` and is expected to delete it after use.
 * @param {object} request
 * @param {string} request.inputPath source media file
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} request.cfg
 * @param {string} request.workDir scratch directory for the produced file
 * @param {number} [request.timeoutMs]
 * @returns {Promise<string>} path of the converted WAV
 */
export async function transcodeTo16kWav({ inputPath, cfg, workDir, timeoutMs }) {
  const ffmpeg = resolveFfmpeg(cfg)
  if (!ffmpeg) {
    throw new EngineError(
      `需要 ffmpeg 把 ${basename(inputPath)} 转成 16 kHz 单声道 WAV，但没有找到 ffmpeg。` +
        `请在插件面板把「ffmpeg 路径」指向 ffmpeg.exe（或它所在目录），或把 ffmpeg.exe 放到 ${join(cfg.audioCpp.binDir, '..', 'ffmpeg')}，` +
        '也可以把它加入 PATH。',
      { inputPath, configured: cfg.audioCpp.ffmpegPath },
    )
  }

  mkdirSync(workDir, { recursive: true })
  const stem = basename(inputPath).replace(/\.[^.]+$/, '') || 'audio'
  const outputPath = join(workDir, `${stem}.16k.wav`)
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    String(TARGET_CHANNELS),
    '-ar',
    String(TARGET_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]

  try {
    await runCli({
      cliPath: ffmpeg,
      label: 'ffmpeg',
      cwd: workDir,
      args,
      scratchDir: workDir,
      timeoutMs: timeoutMs ?? 300_000,
    })
  } catch (error) {
    throw new EngineError(`ffmpeg 转码失败：${error.message}`, { inputPath, ffmpeg })
  }

  if (!existsSync(outputPath)) {
    throw new EngineError(`ffmpeg 没有生成转码文件：${outputPath}`, { inputPath, ffmpeg })
  }
  return outputPath
}

/** Remove one scratch directory, ignoring errors. */
export function cleanupScratch(workDir) {
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* scratch only */
  }
}
