/**
 * Tool implementations exposed through MCP.
 *
 * Every tool resolves the published config, then talks to the resident audio.cpp
 * server over HTTP. The engine is started/stopped by the DSH host plugin, so a
 * tool call never spawns an inference process.
 */

import { writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  ensureDir,
  inspectInstall,
  isDir,
  isFile,
  listFiles,
  resolvePath,
} from '../src/config.js'
import {
  EngineError,
  engineDownMessage,
  engineHealth,
  listModels,
  synthesizeSpeech,
  transcribeAudio,
  waitForEngine,
} from './engine.mjs'
import { runCli } from './audiocpp.mjs'
import { transcribeWithTimestamps } from './segments.mjs'
import { JOB_STATUSES } from './jobs.mjs'
import { installSnapshot, missingAssets } from './assets.mjs'
import { cleanupScratch, isReadyWav, resolveFfmpeg, transcodeTo16kWav } from './transcode.mjs'

/** Limit for one synthesis request; a longer prompt should be split by the caller. */
const MAX_TTS_CHARS = 2000

/**
 * Coerce an optional numeric tool argument.
 *
 * A model can pass `"0.6"`, `null`, or nonsense; the engine would receive `null`
 * for `NaN` after JSON encoding, so clamp here and drop unusable values.
 * @param {unknown} value
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number | undefined}
 */
function optionalNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  let out = n
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

/** Append the default extension when the caller's path has none. */
function withExtension(path, extension) {
  return /\.[A-Za-z0-9]{1,5}$/.test(path) ? path : `${path}${extension}`
}

/** Timestamp suffix that sorts lexicographically and stays filesystem-safe. */
function stamp() {
  const now = new Date()
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3),
  ].join('')
}

/** Slug for a synthesized file name; keeps CJK, drops path separators. */
function slug(text) {
  const cleaned = (text || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
  return cleaned.slice(0, 24) || 'speech'
}

/** Resolve an input path, trying the workspace and reporting near misses. */
function resolveInputFile(input, cfg, label) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new EngineError(`缺少 ${label} 参数`)
  // Session working directory first (what the tool description promises), then the
  // package root (bundled fixtures in a dev install), the output folder and cwd.
  const candidates = [
    resolvePath(raw, cfg.output.baseDir),
    resolvePath(raw),
    resolvePath(raw, cfg.output.dir),
    resolvePath(raw, process.cwd()),
  ]
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (isFile(candidate)) return candidate
  }
  if (isDir(resolvePath(raw))) {
    throw new EngineError(`${label} 指向目录而不是文件：${raw}`)
  }
  throw new EngineError(`找不到${label}：${raw}`, { tried: [...seen] })
}

/**
 * Resolve a requested output path: a bare file name lands in output.dir, a path
 * containing a separator is workspace-relative, and an absolute path is kept.
 */
function resolveOutPath(input, cfg) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  const hasSeparator = /[\\/]/.test(raw)
  return resolvePath(raw, hasSeparator ? cfg.output.baseDir : cfg.output.dir)
}

/**
 * Where an ASR transcription is written.
 *
 * Transcriptions land in the output folder by default, named after the source
 * audio (`asr-<stamp>-<audio name>.txt`). An explicit `output_path` wins: a bare
 * file name stays in the output folder, a path with a separator is
 * workspace-relative, and an absolute path is used as-is.
 * @returns {{textPath: string, segmentsPath: string}}
 */
function asrOutputPaths(params, cfg, audioPath) {
  const outputDir = ensureDir(cfg.output.dir)
  const requested = params.output_path ? resolveOutPath(params.output_path, cfg) : ''
  const base =
    requested ||
    join(outputDir, `asr-${stamp()}-${slug(basename(audioPath).replace(/\.[^.]+$/, ''))}.txt`)
  // The transcript is always plain text: a `.json` request keeps the stem and
  // still gets `.txt`, while the sentence timeline goes to `<stem>.segments.json`.
  const stem = base.replace(/\.(txt|json)$/i, '')
  const textPath = `${stem}.txt`
  ensureDir(dirname(textPath))
  return { textPath, segmentsPath: `${stem}.segments.json` }
}

/**
 * Report a missing model/binary with the exact path that failed.
 *
 * Only the files the requested action needs are required: a transcription must
 * not fail because the TTS weights are absent (and vice versa). The VAD model is
 * checked by the timestamp path itself, where it is actually used.
 *
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {'tts' | 'asr'} task
 */
export function requireInstall(cfg, task) {
  const problems = []
  if (!isFile(cfg.engine.exePath)) problems.push(`audiocpp_server 不存在：${cfg.engine.exePath}`)
  if (task === 'tts') {
    if (!isFile(cfg.tts.model)) problems.push(`TTS 模型不存在：${cfg.tts.model}`)
  } else if (task === 'asr') {
    if (!isFile(cfg.asr.model)) problems.push(`ASR 模型不存在：${cfg.asr.model}`)
  }
  if (problems.length) throw new EngineError(problems.join('；'), { binDir: cfg.audioCpp.binDir })
}

/** Ensure the engine answers; give the plugin a few seconds to finish starting it. */
async function requireEngine(cfg) {
  const health = await waitForEngine(cfg.engine.url)
  // The running process is the single source of truth: `engineEnabled` is only
  // the panel's request state and may be false after boot auto-start.
  if (!health) throw new EngineError(engineDownMessage(cfg.engine.url), { url: cfg.engine.url })
  return health
}


/**
 * Synthesize speech with the resident TTS model.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {{signal?: AbortSignal}} context
 */
export async function ttsSpeak(params, cfg, context = {}) {
  requireInstall(cfg, 'tts')
  await requireEngine(cfg)

  const text = typeof params.text === 'string' ? params.text.trim() : ''
  if (!text) throw new EngineError('缺少 text：请提供要合成的文本')
  if (text.length > MAX_TTS_CHARS) {
    throw new EngineError(
      `text 过长（${text.length} 字符，单次上限 ${MAX_TTS_CHARS}）。请拆成多段，分别调用本工具。`,
    )
  }

  const voicePath = params.voice_path
    ? resolveInputFile(params.voice_path, cfg, '参考音色')
    : cfg.tts.defaultVoiceRef
  if (!voicePath) {
    throw new EngineError(
      '缺少参考音色：请传 voice_path（wav 文件路径），或在插件面板的「默认参考音色」里设置。',
    )
  }
  if (!isFile(voicePath)) throw new EngineError(`参考音色文件不存在：${voicePath}`)

  const outputDir = ensureDir(cfg.output.dir)
  const requested = params.output_path ? resolveOutPath(params.output_path, cfg) : ''
  const outPath = requested
    ? withExtension(requested, '.wav')
    : join(outputDir, `tts-${stamp()}-${slug(text)}.wav`)
  ensureDir(dirname(outPath))

  const language = typeof params.language === 'string' && params.language.trim() ? params.language.trim() : cfg.tts.language
  const emotion = typeof params.emotion === 'string' && params.emotion.trim() ? params.emotion.trim() : cfg.tts.emotion

  const options = {}
  if (language && language !== 'auto') options.language = language
  if (emotion) {
    options.use_emotion_text = true
    options.emotion_text = emotion
    const alpha = optionalNumber(params.emotion_alpha, 0, 1)
    if (alpha !== undefined) options.emotion_alpha = alpha
  }
  const durationScale = optionalNumber(params.duration_scale, 0.25, 4)
  if (durationScale !== undefined) options.duration_scale = durationScale

  const seed = optionalNumber(params.seed, 0, 2_147_483_647)
  const workDir = join(cfg.output.tmp, `tts-ref-${Date.now()}-${process.pid}`)
  try {
    // A reference clip may be any container or sample rate. The engine decodes
    // WAV only, so normalize once (16 kHz mono) and keep the caller's path in the
    // result — the copy is deleted in the `finally` below.
    const engineVoice = isReadyWav(voicePath)
      ? voicePath
      : await transcodeTo16kWav({
          inputPath: voicePath,
          cfg,
          workDir,
          timeoutMs: cfg.mcp.toolCallTimeoutMs,
        })
    const { bytes } = await synthesizeSpeech({
      baseUrl: cfg.engine.url,
      model: cfg.tts.id,
      text,
      voiceRef: engineVoice,
      options,
      seed: seed === undefined ? undefined : Math.trunc(seed),
      timeoutMs: cfg.mcp.toolCallTimeoutMs,
      signal: context.signal,
    })
    writeFileSync(outPath, bytes)

    // Only the produced path: the rest of the old payload echoed the request
    // (text, voice, language, engine) or the deployment (family) and cost the
    // model tokens it cannot act on.
    return { audio_path: outPath }
  } finally {
    cleanupScratch(workDir)
  }
}

/**
 * Transcribe an audio file with the resident ASR model.
 *
 * `timestamps: true` switches to the sentence-timeline path: PulseVAD finds the
 * speech regions (via the audio.cpp CLI), each region is transcribed by the
 * resident engine, and the result carries `start_ms` / `end_ms` per sentence.
 *
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {{signal?: AbortSignal}} context
 */
export async function asrTranscribe(params, cfg, context = {}) {
  requireInstall(cfg, 'asr')
  await requireEngine(cfg)

  const sourcePath = resolveInputFile(params.audio_path, cfg, '音频文件')
  // Chunking defaults to the panel value; a caller may override it for one call,
  // which matters for very long files and for inputs that are already segmented.
  const chunkMode = ['auto', 'fixed', 'vad', 'none'].includes(params.chunk_mode)
    ? params.chunk_mode
    : cfg.asr.chunkMode
  const options = {
    audio_chunk_mode: chunkMode,
    audio_chunk_duration_sec: Number(optionalNumber(params.chunk_seconds, 1, 600) ?? cfg.asr.chunkSeconds),
  }
  const language = typeof params.language === 'string' && params.language.trim() ? params.language.trim() : cfg.asr.language
  if (language && language !== 'auto') options.language = language
  // `normalize_text` is the panel-facing name for the engine's ITN switch.
  options.enable_itn =
    params.normalize_text === undefined ? cfg.asr.enableItn : params.normalize_text !== false
  // Tags (<|event|>/<|emotion|>) are never requested: the toolkit reports plain
  // transcripts, so the engine's `keep_tags` option is left at its default.

  const workDir = join(cfg.output.tmp, `asr-src-${Date.now()}-${process.pid}`)
  try {
    // One normalization step serves both consumers: the engine only decodes WAV,
    // and its VAD chunking wants 16 kHz mono. Anything else (mp3/flac/44.1 kHz…)
    // is converted once, so `timestamps` and `chunk_mode: auto|vad` work on any
    // input instead of failing deep inside the engine.
    const audioPath = isReadyWav(sourcePath)
      ? sourcePath
      : await transcodeTo16kWav({
          inputPath: sourcePath,
          cfg,
          workDir,
          timeoutMs: cfg.mcp.toolCallTimeoutMs,
        })
    // The output file is named after the file the caller gave us.
    const paths = params.save_to_file === false ? undefined : asrOutputPaths(params, cfg, sourcePath)

    /**
     * One engine transcription call.
     *
     * `chunking: 'requested'` (whole-file transcriptions) keeps the caller's
     * `chunk_mode`, which is the whole point of exposing it. Sentence slices must
     * override it: they are already short and self-contained, so asking the engine
     * to chop them again would only add latency.
     * @param {{audioPath: string, chunking?: 'requested' | 'fixed'}} request
     */
    const transcribe = (request) =>
      transcribeAudio({
        baseUrl: cfg.engine.url,
        model: cfg.asr.id,
        audioPath: request.audioPath,
        options:
          request.chunking === 'requested'
            ? options
            : {
                ...options,
                audio_chunk_mode: 'fixed',
                audio_chunk_duration_sec: Math.max(1, cfg.asr.chunkSeconds),
              },
        timeoutMs: cfg.mcp.toolCallTimeoutMs,
        signal: context.signal,
      })

    if (params.timestamps === true) {
      const timeline = await transcribeWithTimestamps({
        audioPath,
        cfg,
        language,
        transcribe,
        signal: context.signal,
      })
      if (paths) {
        writeFileSync(paths.textPath, timeline.text, 'utf8')
        writeFileSync(
          paths.segmentsPath,
          JSON.stringify(
            {
              audio_path: sourcePath,
              language: language || 'auto',
              family: cfg.asr.family,
              duration_ms: Math.round(timeline.durationMs),
              vad_regions: timeline.vadRegions,
              fallback: timeline.fallback,
              text: timeline.text,
              segments: timeline.segments,
            },
            null,
            2,
          ),
          'utf8',
        )
      }
      // Default answer is the produced file path; the transcript itself stays on
      // disk unless the caller asks for it (`return_text: true`).
      const withText = !paths || params.return_text === true
      return {
        text_path: paths?.textPath ?? null,
        segments_path: paths?.segmentsPath ?? null,
        ...(withText ? { text: timeline.text, segments: timeline.segments } : {}),
      }
    }

    const result = await transcribe({ audioPath, chunking: 'requested' })
    const text = String(result.text ?? '')
    if (paths) writeFileSync(paths.textPath, text, 'utf8')

    const withText = !paths || params.return_text === true
    // Paths are the contract; the transcript only when explicitly asked for.
    // Timing/model/engine fields were diagnostics, not something a caller uses.
    return {
      text_path: paths?.textPath ?? null,
      ...(withText ? { text } : {}),
    }
  } finally {
    cleanupScratch(workDir)
  }
}
/**
 * List reference voices available to the TTS tool.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 */
export function ttsListVoices(params, cfg) {
  const dir = params.voice_dir
    ? [resolvePath(params.voice_dir, cfg.output.baseDir), resolvePath(params.voice_dir)].find((path) => isDir(path)) ??
      resolvePath(params.voice_dir, cfg.output.baseDir)
    : cfg.tts.voiceDir
  const files = listFiles(dir, '.wav')
  const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
  // Name and path are what a caller passes back as `voice_path`; sizes and a
  // per-entry default flag were noise (the default is reported once, below).
  const voices = files
    .filter((file) => !query || file.toLowerCase().includes(query))
    .map((file) => ({
      name: basename(file).replace(/\.wav$/i, ''),
      path: file,
    }))
  return {
    voice_dir: dir,
    default_voice_path: cfg.tts.defaultVoiceRef || null,
    voices,
  }
}

/** Cached `--list-devices` result: enumerating devices costs one CLI start. */
const deviceCache = { key: '', at: 0, value: undefined }

/** The job queue injected by the surface (host plugin or standalone MCP server). */
function requireQueue(context) {
  if (!context?.jobs?.submit) {
    throw new EngineError('当前入口不支持异步任务（缺少任务队列）')
  }
  return context.jobs
}

/**
 * Counters a caller acts on.
 *
 * `total` / `active` / `limit` are derivable from these plus the panel setting,
 * and the queue already reports the limit elsewhere when it matters.
 */
function queueCounts(summary) {
  return {
    queued: summary.queued,
    running: summary.running,
    done: summary.done,
    error: summary.error,
    cancelled: summary.cancelled,
  }
}

/** Strip per-job timestamp bookkeeping; only state and payload matter. */
function leanJob(job) {
  return {
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.result === undefined ? {} : { result: job.result }),
  }
}

/** Map a task `kind` to the tool that executes it. */
const TASK_TOOL = { tts: 'tts_speak', asr: 'asr_transcribe' }

/**
 * Queue a batch of tasks and return job ids immediately.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {{jobs?: import('./jobs.mjs').JobQueue}} context
 */
export async function submitTasks(params, cfg, context = {}) {
  const jobs = requireQueue(context)
  const tasks = Array.isArray(params.tasks) ? params.tasks : []
  if (tasks.length === 0) throw new EngineError('缺少 tasks：请提供至少一个任务')
  if (tasks.length > 20) throw new EngineError(`一次最多提交 20 个任务（收到 ${tasks.length} 个）`)
  jobs.setLimit(cfg.mcp.maxConcurrentCalls)

  const submitted = []
  const rejected = []
  for (const task of tasks) {
    const kind = String(task?.kind ?? '').toLowerCase()
    if (!TASK_TOOL[kind]) {
      rejected.push({ kind, reason: 'kind 必须是 tts 或 asr' })
      continue
    }
    const nested = task.params
    let taskParams
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      taskParams = nested
    } else {
      const { kind: _kind, params: _params, ...rest } = task
      taskParams = rest
    }
    submitted.push(jobs.submit({ kind, params: taskParams, cfg }))
  }
  return {
    // job_id + status is all a caller needs to start polling; timestamps and
    // durations of a just-queued job are always empty.
    submitted: submitted.map((job) => ({ job_id: job.job_id, kind: job.kind, status: job.status })),
    rejected,
    queue: queueCounts(jobs.summary()),
  }
}

/**
 * Report job progress and results.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {{jobs?: import('./jobs.mjs').JobQueue}} context
 */
export function jobStatus(params, cfg, context = {}) {
  const jobs = requireQueue(context)
  const ids = Array.isArray(params.job_ids) && params.job_ids.length > 0 ? params.job_ids.map(String) : undefined
  const status = JOB_STATUSES.includes(params.status) ? params.status : undefined
  // Asking for specific ids must return all of them, not the default page size.
  const limit = ids === undefined ? params.limit : Math.max(ids.length, Number(params.limit) || 0)
  const list = jobs.list({ ids, status, limit })
  // A filtered query cannot report which requested ids are absent (they may exist
  // under another status), so absence is only tracked for unfiltered lookups.
  const found = new Set(list.map((job) => job.job_id))
  const missing = ids === undefined || status !== undefined ? [] : ids.filter((id) => !found.has(id))
  const settled = list.every((job) => ['done', 'error', 'cancelled'].includes(job.status))
  return {
    jobs: list.map(leanJob),
    all_settled: settled && missing.length === 0,
    ...(missing.length > 0 ? { missing } : {}),
    summary: queueCounts(jobs.summary()),
  }
}

/**
 * Cancel queued or running jobs.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {{jobs?: import('./jobs.mjs').JobQueue}} context
 */
export function cancelJobs(params, cfg, context = {}) {
  const jobs = requireQueue(context)
  const ids = Array.isArray(params.job_ids) ? params.job_ids.map(String) : []
  if (ids.length === 0) throw new EngineError('缺少 job_ids：请提供至少一个 job_id')
  const result = jobs.cancel(ids)
  return result
}

/** Best-effort backend device list; never fails the status tool. */
async function queryDevices(cfg) {
  const key = `${cfg.audioCpp.cliPath}|${cfg.audioCpp.backend}|${cfg.audioCpp.device}`
  const ttl = deviceCache.value && !deviceCache.value.error ? 60_000 : 5_000
  if (deviceCache.key === key && deviceCache.value !== undefined && Date.now() - deviceCache.at < ttl) {
    return deviceCache.value
  }
  try {
    const result = await runCli({
      cliPath: cfg.audioCpp.cliPath,
      cwd: cfg.audioCpp.binDir,
      scratchDir: cfg.output.tmp,
      args: ['--list-devices', '--json'],
      // A hung CUDA init must not hold up a status call for two minutes.
      timeoutMs: 20_000,
    })
    const output = result.stdout
    const start = output.indexOf('[')
    const end = output.lastIndexOf(']')
    let devices
    if (start >= 0 && end > start) {
      try {
        devices = JSON.parse(output.slice(start, end + 1))
      } catch {
        devices = undefined
      }
    }
    if (devices === undefined) {
      devices = output
        .split(/\r?\n/)
        .filter((line) => /^(CUDA|CPU|VULKAN|METAL|HIP):/.test(line.trim()))
        .map((line) => line.trim())
    }
    deviceCache.key = key
    deviceCache.value = devices
    deviceCache.at = Date.now()
    return devices
  } catch (error) {
    deviceCache.key = key
    deviceCache.value = { error: error instanceof Error ? error.message : String(error) }
    deviceCache.at = Date.now()
    return deviceCache.value
  }
}

/**
 * Report engine state: resident process health, models, config and devices.
 * @param {Record<string, any>} params
 * @param {ReturnType<typeof import('../src/config.js').resolveConfig>} cfg
 * @param {object} context
 */
export async function audioStatus(params, cfg, context = {}) {
  const install = inspectInstall(cfg)
  const health = await engineHealth(cfg.engine.url)
  const models = health ? await listModels(cfg.engine.url) : undefined
  const devices = await queryDevices(cfg)
  return {
    toolkit_version: context.version,
    config_source: context.configSource,
    engine: {
      url: cfg.engine.url,
      enabled: cfg.engine.enabled,
      running: health !== undefined,
      health: health ? { status: health.status, backend: health.backend, version: health.version } : null,
      models: models?.data?.map((model) => ({ id: model.id, loaded: model.loaded })) ?? null,
      log: cfg.engine.logPath,
    },
    // `install_ok` is the single answer to "are the files there?"; a passing
    // check needs no path (it would just repeat the config), a failing one does.
    install_ok: install.ok,
    checks: install.checks.map((check) =>
      check.ok
        ? { label: check.label, ok: true }
        : { label: check.label, ok: false, path: check.path },
    ),
    audio_cpp: {
      backend: cfg.audioCpp.backend,
      device: cfg.audioCpp.device,
      // What transcoding would actually run (configured path or PATH fallback).
      ffmpeg: resolveFfmpeg(cfg) ?? null,
    },
    // Where the runtime assets live and whether they are complete.
    assets: {
      root: cfg.assets.root,
      auto_download: cfg.assets.autoDownload,
      ready: missingAssets(cfg).length === 0,
      ...(missingAssets(cfg).length > 0 ? { missing: missingAssets(cfg) } : {}),
      ...(installSnapshot().running ? { downloading: true } : {}),
    },
    tts: {
      family: cfg.tts.family,
      model: cfg.tts.model,
      default_voice_path: cfg.tts.defaultVoiceRef || null,
      voices: listFiles(cfg.tts.voiceDir, '.wav').length,
    },
    asr: {
      family: cfg.asr.family,
      model: cfg.asr.model,
      vad_model: cfg.asr.vadModel,
      chunk_mode: cfg.asr.chunkMode,
    },
    output: {
      dir: cfg.output.dir,
      files: listFiles(cfg.output.dir, '.wav').length,
    },
    jobs: context.jobs?.summary ? { ...queueCounts(context.jobs.summary()), limit: context.jobs.summary().limit } : null,
    // Device inventories are large; keep the name and the memory headroom.
    gpu: Array.isArray(devices)
      ? devices.map((entry) => ({
          name: entry.description ?? entry.name ?? 'unknown',
          free_bytes: entry.memory?.free_bytes ?? null,
          total_bytes: entry.memory?.total_bytes ?? null,
        }))
      : devices,
  }
}

/** Tool registry: name → { description, inputSchema, handler }. */
export const TOOLS = [
  {
    name: 'tts_speak',
    title: '文本转语音（IndexTTS2.5 fp16）',
    description:
      '把文本合成为语音，返回生成的 wav 文件路径。音色由 voice_path 指向的参考音频决定；省略时使用部署配置的默认音色，两者都没有会报错。支持情绪、语速（duration_scale，大于 1 更慢）与固定随机种子。单次上限 2000 字符，更长的文本请拆成多次调用。引擎常驻，连续调用很快。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的文本；单次上限 2000 字符，超出会报错，请分段调用。' },
        voice_path: {
          type: 'string',
          description: '参考音色的音频文件路径（绝对路径或相对会话工作目录），决定合成音色；省略时用部署的默认音色。任意格式（wav / mp3 / flac / ogg / m4a …），不是 16 kHz 单声道 WAV 时会先用 ffmpeg 自动转码。',
        },
        language: {
          type: 'string',
          enum: ['auto', 'zh', 'en', 'ja', 'es', 'ar'],
          description: '语言提示；auto 表示按文本自动推断。',
        },
        emotion: { type: 'string', description: '情绪描述，例如「平静但开心」；可省略。' },
        emotion_alpha: { type: 'number', description: '情绪强度，0-1，仅在提供 emotion 时生效。' },
        duration_scale: { type: 'number', description: '时长/语速缩放：大于 1 更慢，小于 1 更快，默认 1。' },
        seed: { type: 'integer', description: '随机种子；固定同一个值可复现同一句话。' },
        output_path: {
          type: 'string',
          description: '输出 wav 路径；省略时写入输出文件夹并自动命名。只给文件名时保存在输出文件夹。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: ttsSpeak,
  },
  {
    name: 'asr_transcribe',
    title: '语音转文字（SenseVoice）',
    description:
      '把音频文件转写成文本（SenseVoice，输出纯文本，不含事件/情绪标签）。默认写入输出文件、返回值只给路径（text_path）；需要正文时传 return_text=true。timestamps=true 时改用 VAD（语音活动检测）切句：先把音频切成句子，再逐句识别，时间戳是句级 start_ms/end_ms——不是词级，也不是模型原生输出；更慢，且切片上下文变短可能略降低准确率。长音频分块默认用面板配置，可用 chunk_mode / chunk_seconds 单次覆盖。输入可以是任意音频格式，内部先统一转成 16 kHz 单声道 WAV；支持中/英/粤/日/韩等 20+ 语言。',
    inputSchema: {
      type: 'object',
      properties: {
        audio_path: {
          type: 'string',
          description: '音频文件路径（绝对路径或相对会话工作目录）。任意格式（wav / mp3 / flac / ogg / m4a …）；不是 16 kHz 单声道 WAV 时会先用 ffmpeg 自动转码，转码失败会给出原因。',
        },
        output_path: {
          type: 'string',
          description: '转写文本的输出路径；省略时写入输出文件夹并自动命名 asr-<时间>-<音频名>.txt。句级模式另写同名 .segments.json。',
        },
        save_to_file: {
          type: 'boolean',
          description: 'false 时不写任何文件、直接在返回值里给出正文（此时 return_text 无意义）；默认 true。',
        },
        return_text: {
          type: 'boolean',
          description: 'true 时在返回值里附带正文与分段；默认 false，只给路径（长转写更省上下文）。',
        },
        language: {
          type: 'string',
          description: '识别语言：auto，或 zh / en / yue / ja / ko 等语言代码；默认 auto。',
        },
        timestamps: {
          type: 'boolean',
          description: 'true 时用 VAD 切句后逐句识别，返回句级时间轴（每段 start_ms/end_ms，不是词级）；更慢。未检出语音时会退化为整段转写，此时返回的 timestamps 为 whole-file。',
        },
        normalize_text: {
          type: 'boolean',
          description: 'true（默认）把数字、日期、标点规整成书面形式（例如「三点」写成「3点」）；false 保留模型原始输出。',
        },
        chunk_mode: {
          type: 'string',
          enum: ['auto', 'fixed', 'vad', 'none'],
          description: '高级选项：长音频分块方式，默认沿用面板配置（fixed）。auto / vad 需要 VAD 模型与 16 kHz 单声道输入。',
        },
        chunk_seconds: {
          type: 'number',
          description: '高级选项：分块时长（秒，1-600），默认沿用面板配置（30）。fixed 时是每段时长，auto / vad 时是单段上限。',
        },
      },
      required: ['audio_path'],
      additionalProperties: false,
    },
    handler: asrTranscribe,
  },
  {
    name: 'tts_list_voices',
    title: '列出可用参考音色',
    description:
      '列出参考音色目录里的 wav 文件，返回名称与路径。把返回的 path 作为文本转语音工具的 voice_path 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按文件名子串过滤，例如「三月」。' },
        voice_dir: { type: 'string', description: '覆盖默认音色目录，例如指向 audio_samples 目录。' },
      },
      additionalProperties: false,
    },
    handler: ttsListVoices,
  },
  {
    name: 'audio_status',
    title: '查看音频引擎状态',
    description:
      '检查常驻语音引擎：是否在运行、哪些模型已加载、模型/VAD/可执行文件是否就绪、GPU 设备与当前配置。排障或不确定参数时先调用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: audioStatus,
  },
  {
    name: 'submit_tasks',
    title: '批量提交音频任务（异步）',
    description:
      '批量提交语音任务（文本转语音 / 语音转文字），立即返回 job_id，不阻塞等待。每个任务的字段与对应工具的参数一致：文本转语音任务给 text（可选 voice_path 等），语音转文字任务给 audio_path；也可以把字段放进 params 对象。提交后用任务查询工具按 job_ids 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description:
            '任务列表（一次最多 20 个）。每项必须含 kind，其余字段同该工具参数，例如 {"kind":"tts","text":"…","voice_path":"…"} 或 {"kind":"asr","audio_path":"…"}；也可写成 {"kind":"tts","params":{…}}。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['tts', 'asr'], description: 'tts（文本转语音）或 asr（语音转文字）' },
            },
            required: ['kind'],
            additionalProperties: true,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    handler: submitTasks,
  },
  {
    name: 'job_status',
    title: '查询异步任务进度',
    description:
      '按 job_ids 查询任务状态与结果（done 时 result 里是音频/文本路径）；不传 job_ids 则列出最近的作业。用 all_settled 判断是否全部结束，summary 给出各状态计数。',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要查询的 job_id 列表；省略则列出最近作业。',
        },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'done', 'error', 'cancelled'],
          description: '只看某个状态的任务。',
        },
        limit: { type: 'number', description: '最多返回多少条（默认 20，上限 100）。' },
      },
      additionalProperties: false,
    },
    handler: jobStatus,
  },
  {
    name: 'cancel_jobs',
    title: '取消异步任务',
    description: '取消排队中或运行中的任务；已结束的任务不会被改动。返回 cancelled / skipped 列表。',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' }, description: '要取消的 job_id 列表。' },
      },
      required: ['job_ids'],
      additionalProperties: false,
    },
    handler: cancelJobs,
  },
]

/** Look up a tool by name. */export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name)
}
