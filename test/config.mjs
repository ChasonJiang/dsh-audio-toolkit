#!/usr/bin/env node
/**
 * Unit checks for the toolkit's config layer, engine config and host plugin.
 *
 * Verifies that:
 *  - the built-in defaults resolve to the shipped fp16 TTS / SenseVoice / VAD files;
 *  - a schemastery-parsed (volatile) flat Config still resolves to plain values;
 *  - the DSH settings helpers can build a panel form from that schema;
 *  - `apply()` publishes state/config.json, writes state/engine.json and registers
 *    the engine lifecycle effect.
 *
 * Usage: node test/config.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_CONFIG,
  FFMPEG_BINARY,
  SERVER_BINARY,
  STATE_CONFIG_PATH,
  STATE_DIR,
  STATE_ENGINE_CONFIG_PATH,
  TOOLKIT_VERSION,
  inspectInstall,
  isFile,
  loadStateConfig,
  resolveConfig,
  toEngineConfig,
  writeEngineConfig,
  writeStateConfig,
} from '../src/config.js'
import { encodeWav } from '../src/wav.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The DSH profile directory that ships schemastery + the settings form helpers. */
function profileDir() {
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop') : undefined,
    join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop'),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1]
}

async function importFromProfile(relative) {
  const candidate = join(profileDir(), 'node_modules', ...relative.split('/'))
  if (!existsSync(candidate)) return undefined
  try {
    return await import(pathToFileURL(candidate).href)
  } catch (error) {
    console.log(`      (${relative} failed to load: ${error.message})`)
    return undefined
  }
}

async function main() {
  console.log(`toolkit: v${TOOLKIT_VERSION} (${PACKAGE_ROOT})\n`)

  // 1. defaults
  const defaults = resolveConfig({})
  check('default TTS model is fp16', defaults.tts.model.endsWith(join('IndexTTS2.5-GGUF', 'index-tts2_5-f16.gguf')), defaults.tts.model)
  check(
    'default ASR model',
    defaults.asr.model.endsWith(join('SenseVoice-Small-GGUF', 'sensevoice-small-q8-audiocpp-v1.gguf')),
    defaults.asr.model,
  )
  check('default engine url', defaults.engine.url === 'http://127.0.0.1:8788', defaults.engine.url)
  check('default engine server exe', defaults.engine.exePath.endsWith(join('audio.cpp', SERVER_BINARY)), defaults.engine.exePath)
  // CI runs without the multi-gigabyte release/models. Asset-dependent checks are
  // reported as SKIP there instead of failing, so a fresh clone stays green.
  const hasAssets =
    process.env.AUDIO_TOOLKIT_NO_ASSETS !== '1' &&
    isFile(defaults.engine.exePath) &&
    isFile(defaults.tts.model) &&
    isFile(defaults.asr.model)
  if (hasAssets) {
    const install = inspectInstall(defaults)
    check('install checks all pass', install.ok, install.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') || 'server + cli + models + vad')
    for (const entry of install.checks) console.log(`        ${entry.ok ? '✓' : '✗'} ${entry.label}: ${entry.path}`)
  } else {
    console.log('SKIP  install checks (bin/ or models/ not installed)')
  }

  // 2. overrides (flat)
  const overridden = resolveConfig({
    engineEnabled: 'false',
    enginePort: 9123,
    backend: 'cpu',
    device: 3,
    threads: 8,
    asrChunkMode: 'none',
    asrChunkSeconds: 12,
    asrEnableItn: false,
    ttsLanguage: 'en',
    ttsEmotion: '平静',
    extraArgs: '--foo "bar baz"',
    outputFolder: 'tmp-out',
  })
  check('override engine flags', overridden.engine.enabled === false && overridden.engine.port === 9123 && overridden.engine.url === 'http://127.0.0.1:9123')
  check('override backend/device/threads', overridden.audioCpp.backend === 'cpu' && overridden.audioCpp.device === 3 && overridden.audioCpp.threads === 8)
  check('override asr', overridden.asr.chunkMode === 'none' && overridden.asr.chunkSeconds === 12 && overridden.asr.enableItn === false)
  check('override tts', overridden.tts.language === 'en' && overridden.tts.emotion === '平静')
  check('tokenized extra args', JSON.stringify(overridden.audioCpp.extraArgs) === JSON.stringify(['--foo', 'bar baz']), JSON.stringify(overridden.audioCpp.extraArgs))
  check(
    'output folder resolves under the session working directory',
    resolveConfig({ outputFolder: 'clips' }, { baseDir: join(resolve(PACKAGE_ROOT, '..'), 'ws') }).output.dir ===
      join(resolve(PACKAGE_ROOT, '..'), 'ws', 'clips'),
  )
  check(
    'output folder name is sanitized',
    resolveConfig({ outputFolder: 'a/b' }).output.folder === 'b' &&
      resolveConfig({ outputFolder: '../../../escape' }).output.folder === 'escape' &&
      resolveConfig({ outputFolder: '' }).output.folder === 'audio_toolkit_outputs',
  )
  check(
    'output folder survives Windows name rules',
    resolveConfig({ outputFolder: 'con' }).output.folder === '_con' &&
      resolveConfig({ outputFolder: 'clips. ' }).output.folder === 'clips' &&
      resolveConfig({ outputFolder: 'lpt1.d' }).output.folder === '_lpt1.d',
    `${resolveConfig({ outputFolder: 'con' }).output.folder} / ${resolveConfig({ outputFolder: 'clips. ' }).output.folder}`,
  )
  check('blank path means auto', resolveConfig({ ttsModel: '' }).tts.model === resolveConfig({}).tts.model)
  check(
    'default ffmpeg lives under bin/ffmpeg',
    defaults.audioCpp.ffmpegPath.endsWith(join('bin', 'ffmpeg', FFMPEG_BINARY)),
    defaults.audioCpp.ffmpegPath,
  )
  // A directory is only recognised as one when it exists, so use a real fixture;
  // CI has no `bin/` at all.
  const ffmpegDir = join(STATE_DIR, 'tmp', 'ffmpeg-dir')
  mkdirSync(ffmpegDir, { recursive: true })
  check(
    'ffmpeg path accepts the directory holding it',
    resolveConfig({ ffmpegPath: ffmpegDir }).audioCpp.ffmpegPath === join(ffmpegDir, FFMPEG_BINARY),
    resolveConfig({ ffmpegPath: ffmpegDir }).audioCpp.ffmpegPath,
  )
  rmSync(ffmpegDir, { recursive: true, force: true })
  check(
    'the toolkit version comes from package.json',
    TOOLKIT_VERSION === JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version,
    TOOLKIT_VERSION,
  )

  // 3. engine config
  const engineConfig = toEngineConfig(defaults)
  check(
    'engine config registers both models',
    engineConfig.models.length === 2 &&
      engineConfig.models[0].id === 'tts' &&
      engineConfig.models[0].family === 'index_tts2' &&
      engineConfig.models[1].id === 'asr' &&
      engineConfig.models[1].family === 'sense_asr',
  )
  check('engine config is lazy', engineConfig.lazy_load === true && engineConfig.max_loaded_models === 0)
  check(
    'asr default chunk mode is fixed',
    engineConfig.models[1].default_request_options.audio_chunk_mode === 'fixed',
    JSON.stringify(engineConfig.models[1].default_request_options),
  )
  // The VAD option is advertised only when the file exists, so point it at a real
  // fixture instead of assuming the models are installed (CI has none).
  const vadFixture = join(STATE_DIR, 'tmp', 'vad-fixture.gguf')
  mkdirSync(dirname(vadFixture), { recursive: true })
  writeFileSync(vadFixture, 'gguf')
  check(
    'asr vad session option points at the VAD model',
    toEngineConfig(resolveConfig({ asrVadModel: vadFixture })).models[1].session_options?.['sense_asr.vad_model_path'] === vadFixture,
    vadFixture,
  )
  rmSync(vadFixture, { force: true })
  check(
    'a missing VAD model is not advertised to the engine',
    toEngineConfig(resolveConfig({ asrVadModel: join(PACKAGE_ROOT, 'missing-vad.gguf') })).models[1].session_options?.[
      'sense_asr.vad_model_path'
    ] === undefined,
  )

  // 4. volatile flat config + DSH form contract
  const Schema = (await importFromProfile('@deepseek-ai/schemastery/lib/index.mjs'))?.default
  const { Config } = await import('../src/index.js')
  if (!Schema) {
    console.log('\nSKIP  schemastery not found under the DSH profile')
  } else {
    check('plugin exports a Config schema', Config !== undefined)
    if (Config) {
      const raw = Config({ ttsModel: 'X:/models/tts.gguf', backend: 'vulkan', engineEnabled: false })
      check('volatile leaf fields parse into refs', typeof raw?.ttsModel?.get === 'function', 'ttsModel.get() present')
      const resolved = resolveConfig(raw)
      check('volatile config resolves', resolved.tts.model.replace(/\\/g, '/').endsWith('models/tts.gguf') && resolved.audioCpp.backend === 'vulkan')
      check('volatile engine flag resolves', resolved.engine.enabled === false)

      const settings = await importFromProfile('@deepseek-ai/dsh-settings/lib/types/schema.js')
      if (!settings) {
        console.log('      (dsh-settings schema.js not available under the profile; form contract skipped)')
      } else {
        const form = settings.volatileForm(Config)
        const paths = []
        const walk = (schema, prefix = '') => {
          if (!schema || schema.type !== 'object') {
            paths.push(prefix)
            return
          }
          for (const [key, child] of Object.entries(schema.dict ?? {})) walk(child, prefix ? `${prefix}.${key}` : key)
        }
        walk(form)
        const flat = paths.filter((path) => !path.includes('.'))
        check(
          'panel form exposes flat fields',
          form !== undefined && flat.length === 38,
          `${flat.length} top-level fields`,
        )
        check('panel form keeps them multi-segment free', paths.length === flat.length, paths.filter((p) => p.includes('.')).slice(0, 3).join(', '))
        check(
          'engineEnabled is a live-editable path',
          settings.isVolatilePath(Config, ['engineEnabled']) === true && settings.isVolatilePath(Config, ['ttsModel']) === true,
        )
      }
    }
  }

  // 5. apply(): publishes state and wires the engine lifecycle
  rmSync(STATE_CONFIG_PATH, { force: true })
  rmSync(STATE_ENGINE_CONFIG_PATH, { force: true })
  const plugin = await import('../src/index.js')
  const effects = []
  const listeners = []
  const fakeCtx = {
    on: (event, handler) => listeners.push({ event, handler }),
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label, disposer })
    },
  }
  // Auto-start is disabled here so the test never boots a GPU process.
  const rawConfig = Schema
    ? Config({ engineAutoStart: false, engineEnabled: false, ttsModel: 'X:/models/tts.gguf' })
    : { engineAutoStart: false, engineEnabled: false }
  plugin.apply(fakeCtx, rawConfig)

  check('apply() registers the engine lifecycle effect', effects.some((effect) => String(effect.label).includes('engine lifecycle')))
  check('apply() listens for panel edits', listeners.some((listener) => listener.event === 'loader/volatile-update'))
  check('state/config.json written', existsSync(STATE_CONFIG_PATH))
  // The engine config is what the host writes before spawning; verify it separately.
  const engineJsonPath = writeEngineConfig(defaults)
  const engineJson = JSON.parse(readFileSync(engineJsonPath, 'utf8'))
  check('state/engine.json is a valid audiocpp_server config', engineJson.models?.length === 2 && engineJson.port === defaults.engine.port, engineJsonPath)
  const state = JSON.parse(readFileSync(STATE_CONFIG_PATH, 'utf8'))
  // Without schemastery the raw config has no model override, so the published
  // value is the default — assert against whichever applies.
  const expectedTtsModel = Schema ? 'tts.gguf' : defaults.tts.model
  check(
    'state carries resolved config + engine block',
    state.config?.tts?.model?.endsWith(expectedTtsModel) && typeof state.engine?.url === 'string',
    state.config?.tts?.model,
  )
  const loaded = loadStateConfig()
  check('MCP loader reads the state file', loaded.source === STATE_CONFIG_PATH && loaded.config.engine.port === 8788)

  const disposer = effects.find((effect) => String(effect.label).includes('engine lifecycle'))?.disposer
  check('engine lifecycle disposer is callable', typeof disposer === 'function')
  if (typeof disposer === 'function') await disposer()

  // 6. native host tools: exact names, JSON-schema parameters, working handler
  const { buildToolDefinitions } = await import('../src/host-tools.js')
  const definitions = buildToolDefinitions(() => resolveConfig({}))
  check(
    'native tools carry the requested names',
    definitions.map((entry) => entry.name).join(',') ===
      [
        'audio_toolkit_tts_speak',
        'audio_toolkit_asr_transcribe',
        'audio_toolkit_tts_list_voices',
        'audio_toolkit_engine_status',
        'audio_toolkit_submit_tasks',
        'audio_toolkit_job_status',
        'audio_toolkit_cancel_jobs',
      ].join(','),
    definitions.map((entry) => entry.name).join(', '),
  )
  check(
    'parameters are JSON object schemas',
    definitions.every((entry) => entry.parameters?.type === 'object' && entry.parameters.properties !== undefined),
  )
  check(
    'required fields survive',
    JSON.stringify(definitions[0].parameters.required) === JSON.stringify(['text']) &&
      JSON.stringify(definitions[1].parameters.required) === JSON.stringify(['audio_path']),
    `${JSON.stringify(definitions[0].parameters.required)} / ${JSON.stringify(definitions[1].parameters.required)}`,
  )
  check(
    'output renders one JSON text block',
    JSON.stringify(definitions[0].output.render({}, { ok: 1 })) === JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: 1 }, null, 2) }]),
  )
  // Self-contained fixture: the repository ships no audio samples, so the voice
  // directory is generated on the fly.
  const fixtureDir = join(STATE_DIR, 'tmp', 'test-voices')
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(join(fixtureDir, 'alpha.wav'), encodeWav(new Int16Array(1600), 16000))
  writeFileSync(join(fixtureDir, 'beta.wav'), encodeWav(new Int16Array(1600), 16000))
  const voices = await definitions[2].execute({ voice_dir: fixtureDir }, {})
  check('tts_list_voices handler executes', voices.voices.length === 2, `${voices.voices.length} voices`)
  rmSync(fixtureDir, { recursive: true, force: true })
  check(
    'asr tool exposes the sentence-timestamp flag',
    definitions[1].parameters.properties.timestamps?.type === 'boolean',
  )
  check(
    'asr tool exposes long-audio chunking again',
    definitions[1].parameters.properties.chunk_mode?.enum?.includes('vad') === true &&
      definitions[1].parameters.properties.chunk_seconds?.type === 'number',
    `${JSON.stringify(definitions[1].parameters.properties.chunk_mode?.enum)} / ${definitions[1].parameters.properties.chunk_seconds?.type}`,
  )
  check(
    'asr tool no longer exposes tag retention',
    definitions[1].parameters.properties.include_tags === undefined,
  )

  // 7. sentence timeline building blocks (pure helpers, no audio hardware)
  const { parseWav, toMono16k, sliceSamples } = await import('../src/wav.js')
  const { buildBlocks } = await import('../mcp/segments.mjs')
  const tone = new Int16Array(16000) // 1 s of silence at 16 kHz
  const roundTrip = parseWav(encodeWav(tone, 16000))
  check('wav round trip keeps format', roundTrip.sampleRate === 16000 && roundTrip.channels === 1 && roundTrip.samples.length === 16000)
  const resampled = toMono16k(new Int16Array(44100 * 2).fill(1000), 2, 44100)
  check('mono 16k resample keeps one second', Math.abs(resampled.length - 16000) <= 1, `${resampled.length} frames`)
  check('slice clamps to bounds', sliceSamples(tone, -100, 999999).length === 16000)

  const regions = [
    { start: 0, end: 8000 },
    { start: 9000, end: 16000 },
    { start: 30000, end: 40000 },
    { start: 55000, end: 55200 },
    { start: 40000, end: 40000 },
  ]
  const blocks = buildBlocks(regions, 60000, { minMs: 300, mergeGapMs: 400 })
  check(
    'vad regions merge into sentence blocks',
    blocks.length === 2 && blocks[0].start === 0 && blocks[0].end === 16000 && blocks[1].start === 30000 && blocks[1].end === 40000,
    JSON.stringify(blocks),
  )

  // 8. async job queue: batching, concurrency bound, cancel, snapshot reload
  const { JobQueue } = await import('../mcp/jobs.mjs')
  const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
  const order = []
  const queue = new JobQueue({
    limit: 2,
    execute: async (kind, params) => {
      order.push(`${kind}:${params.index}:start`)
      await sleep(60)
      order.push(`${kind}:${params.index}:end`)
      return { kind, index: params.index }
    },
  })
  const submitted = [1, 2, 3].map((index) =>
    queue.submit({ kind: 'tts', params: { index }, cfg: {} }),
  )
  check(
    'submit returns immediately with active/queued jobs',
    submitted[0].status === 'running' &&
      submitted[1].status === 'running' &&
      submitted[2].status === 'queued' &&
      submitted.every((job) => job.job_id.startsWith('job-')),
    submitted.map((job) => job.status).join(','),
  )
  await sleep(140)
  let running = 0
  let peak = 0
  for (const entry of order) {
    if (entry.endsWith(':start')) running += 1
    else running -= 1
    peak = Math.max(peak, running)
  }
  check('concurrency limit is respected', peak <= 2, `peak=${peak} (${order.join(' ')})`)
  await sleep(260)
  const finished = queue.list({ limit: 10 })
  check(
    'all submitted jobs finish',
    finished.length === 3 && finished.every((job) => job.status === 'done' && job.result?.index >= 1),
    queue.summary().done + ' done',
  )
  const summary = queue.summary()
  check('summary counts and limit', summary.total === 3 && summary.limit === 2 && summary.active === 0, JSON.stringify(summary))

  const longQueue = new JobQueue({
    limit: 1,
    execute: async (kind, params) => {
      await sleep(120)
      return { kind, index: params.index }
    },
  })
  const first = longQueue.submit({ kind: 'asr', params: { index: 1 }, cfg: {} })
  const second = longQueue.submit({ kind: 'asr', params: { index: 2 }, cfg: {} })
  await sleep(30)
  const cancelled = longQueue.cancel([second.job_id, first.job_id, 'job-missing'])
  check(
    'cancel stops queued and running jobs',
    cancelled.cancelled.includes(second.job_id) && cancelled.cancelled.includes(first.job_id) && cancelled.skipped.length === 1,
    JSON.stringify(cancelled),
  )
  await sleep(150)
  check(
    'cancelled jobs stay cancelled',
    longQueue.list({ limit: 10 }).every((job) => job.status === 'cancelled'),
    longQueue.list({ limit: 10 }).map((job) => job.status).join(','),
  )

  const snapshot = join(resolve(PACKAGE_ROOT, '..'), 'dsh-audio-toolkit', 'state', 'tmp', 'jobs-test.json')
  const persisted = new JobQueue({ limit: 1, persistPath: snapshot, execute: async () => ({ ok: true }) })
  const persistedJob = persisted.submit({ kind: 'tts', params: {}, cfg: {} })
  await sleep(450)
  const reloaded = new JobQueue({ limit: 1, persistPath: snapshot, execute: async () => ({ ok: true }) })
  const restored = reloaded.list({ ids: [persistedJob.job_id] })[0]
  check('finished jobs survive a reload', restored?.status === 'done', JSON.stringify(restored?.status))
  persisted.dispose()
  reloaded.dispose()
  await sleep(50)

  // 9. dispose() must flush the cancellation it just applied
  const disposeSnapshot = join(resolve(PACKAGE_ROOT, '..'), 'dsh-audio-toolkit', 'state', 'tmp', 'jobs-dispose.json')
  rmSync(disposeSnapshot, { force: true })
  const disposing = new JobQueue({
    limit: 1,
    persistPath: disposeSnapshot,
    execute: async () => {
      await sleep(400)
      return { ok: true }
    },
  })
  const interrupted = disposing.submit({ kind: 'tts', params: {}, cfg: {} })
  // Stop before the 300 ms debounce fires: the force-write in dispose() is the
  // only thing that can persist the cancelled state.
  disposing.dispose()
  const flushed = existsSync(disposeSnapshot) ? JSON.parse(readFileSync(disposeSnapshot, 'utf8')) : undefined
  check(
    'dispose() flushes its cancellation to the snapshot',
    flushed?.jobs?.some((job) => job.job_id === interrupted.job_id && job.status === 'cancelled') === true,
    JSON.stringify(flushed?.jobs?.map((job) => `${job.job_id}:${job.status}`)),
  )
  await sleep(450)

  // 10. the engine manager follows the live config (a panel edit must not need a reload)
  {
    const { AudioEngine } = await import('../src/engine.js')
    let live = resolveConfig({ enginePort: 65531, binDir: join(PACKAGE_ROOT, 'nope-a') })
    const managed = new AudioEngine({ getConfig: () => live, log: () => {} })
    check('engine url follows the live config', managed.url === 'http://127.0.0.1:65531', managed.url)
    live = resolveConfig({ enginePort: 65532, binDir: join(PACKAGE_ROOT, 'nope-b') })
    check('engine url follows a later config change', managed.url === 'http://127.0.0.1:65532', managed.url)
    const started = await managed.start()
    check(
      'start() uses the updated binary path',
      String(started.error ?? '').includes('nope-b') && !String(started.error ?? '').includes('nope-a'),
      started.error,
    )
    check('the stale manager still reports not running', managed.running === false)
    const fixed = new AudioEngine({ config: live, log: () => {} })
    check('the legacy config constructor still works', fixed.url === managed.url, fixed.url)
    const { engineSettingsChanged } = await import('../src/engine.js')
    check(
      'a panel edit of engine settings is detected as a restart trigger',
      engineSettingsChanged({ extraArgs: '--x' }, { extraArgs: '--y' }) === true &&
        engineSettingsChanged({ enginePort: 8788 }, { enginePort: 8789 }) === true &&
        engineSettingsChanged({ enginePort: 8788 }, { enginePort: 8788, ttsEmotion: '平静' }) === false,
    )
  }

  // 11. install checks are per action: one model must not block the other tool
  {
    const { requireInstall } = await import('../mcp/tools.mjs')
    // Build the fixtures from files that exist here, so the assertion tests the
    // per-action logic rather than "is the release installed on this machine".
    const fakeBin = join(STATE_DIR, 'tmp', 'test-bin')
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(fakeBin, SERVER_BINARY), 'stub')
    const presentModel = join(STATE_DIR, 'tmp', 'present.gguf')
    writeFileSync(presentModel, 'gguf')
    const missingTts = resolveConfig({
      binDir: fakeBin,
      ttsModel: join(PACKAGE_ROOT, 'missing-tts.gguf'),
      asrModel: presentModel,
    })
    const missingAsr = resolveConfig({
      binDir: fakeBin,
      ttsModel: presentModel,
      asrModel: join(PACKAGE_ROOT, 'missing-asr.gguf'),
    })
    const message = (fn) => {
      try {
        fn()
        return ''
      } catch (error) {
        return error.message
      }
    }
    check('asr install check ignores a missing TTS model', message(() => requireInstall(missingTts, 'asr')) === '')
    check('asr install check reports a missing ASR model', message(() => requireInstall(missingAsr, 'asr')).includes('ASR 模型不存在'))
    check('tts install check ignores a missing ASR model', message(() => requireInstall(missingAsr, 'tts')) === '')
    check('tts install check reports a missing TTS model', message(() => requireInstall(missingTts, 'tts')).includes('TTS 模型不存在'))
    rmSync(fakeBin, { recursive: true, force: true })
    rmSync(presentModel, { force: true })
    // A missing binary still blocks both.
    const missingExe = resolveConfig({ binDir: join(PACKAGE_ROOT, 'nope-bin') })
    check('install checks still require audiocpp_server', message(() => requireInstall(missingExe, 'asr')).includes('audiocpp_server 不存在'))
  }

  // 12. streaming WAV decode: identical output to the buffer path, bounded memory
  {
    const { parseWav, readMono16k, toMono16k } = await import('../src/wav.js')
    const scratch = join(STATE_DIR, 'tmp', 'wav-stream-test')
    mkdirSync(scratch, { recursive: true })

    const mono16k = new Int16Array(16000 * 2)
    for (let i = 0; i < mono16k.length; i += 1) mono16k[i] = ((i * 37) % 2000) - 1000
    const p16 = join(scratch, 'mono-16k.wav')
    writeFileSync(p16, encodeWav(mono16k, 16000))
    const fast = readMono16k(p16)
    check(
      'streamed 16 kHz read matches the samples on disk',
      fast.length === mono16k.length && fast.every((value, index) => value === mono16k[index]),
      `${fast.length} frames`,
    )

    // 44.1 kHz mono, 10 s: more than one 65 536-frame block, so the block
    // boundaries (and the interpolation neighbour) are exercised.
    const mono44k = new Int16Array(44100 * 10)
    for (let i = 0; i < mono44k.length; i += 1) mono44k[i] = Math.round(Math.sin(i / 20) * 8000)
    const p44 = join(scratch, 'mono-44k.wav')
    writeFileSync(p44, encodeWav(mono44k, 44100))
    const streamed = readMono16k(p44)
    const reference = toMono16k(parseWav(readFileSync(p44)).samples, 1, 44100)
    check(
      'streamed resample equals the in-memory resample across blocks',
      streamed.length === reference.length && streamed.every((value, index) => value === reference[index]),
      `${streamed.length} vs ${reference.length} frames`,
    )

    // 48 kHz stereo, 10 s: the down-mix indexing must also survive block splits.
    const buildStereo = (left, right, sampleRate) => {
      const dataSize = left.length * 4
      const buffer = Buffer.alloc(44 + dataSize)
      buffer.write('RIFF', 0, 'ascii')
      buffer.writeUInt32LE(36 + dataSize, 4)
      buffer.write('WAVE', 8, 'ascii')
      buffer.write('fmt ', 12, 'ascii')
      buffer.writeUInt32LE(16, 16)
      buffer.writeUInt16LE(1, 20)
      buffer.writeUInt16LE(2, 22)
      buffer.writeUInt32LE(sampleRate, 24)
      buffer.writeUInt32LE(sampleRate * 4, 28)
      buffer.writeUInt16LE(4, 32)
      buffer.writeUInt16LE(16, 34)
      buffer.write('data', 36, 'ascii')
      buffer.writeUInt32LE(dataSize, 40)
      for (let i = 0; i < left.length; i += 1) {
        buffer.writeInt16LE(left[i], 44 + i * 4)
        buffer.writeInt16LE(right[i], 46 + i * 4)
      }
      return buffer
    }
    const left = new Int16Array(48000 * 10)
    const right = new Int16Array(48000 * 10)
    for (let i = 0; i < left.length; i += 1) {
      left[i] = Math.round(Math.sin(i / 30) * 6000)
      right[i] = Math.round(Math.cos(i / 17) * 3000)
    }
    const pStereo = join(scratch, 'stereo-48k.wav')
    writeFileSync(pStereo, buildStereo(left, right, 48000))
    const streamedStereo = readMono16k(pStereo)
    const referenceStereo = toMono16k(parseWav(readFileSync(pStereo)).samples, 2, 48000)
    check(
      'streamed stereo down-mix equals the in-memory down-mix',
      streamedStereo.length === referenceStereo.length &&
        streamedStereo.every((value, index) => value === referenceStereo[index]),
      `${streamedStereo.length} vs ${referenceStereo.length} frames`,
    )

    // Bit depths and WAVE_FORMAT_EXTENSIBLE: ffmpeg writes 24/32-bit PCM as
    // extensible, and that used to be rejected outright.
    const buildWav = ({ samples, sampleRate, bits, float = false, extensible = false }) => {
      const bytesPerSample = bits / 8
      const fmtSize = extensible ? 40 : 16
      const dataSize = samples.length * bytesPerSample
      const dataStart = 28 + fmtSize
      const buffer = Buffer.alloc(dataStart + dataSize)
      buffer.write('RIFF', 0, 'ascii')
      buffer.writeUInt32LE(dataStart + dataSize - 8, 4)
      buffer.write('WAVE', 8, 'ascii')
      buffer.write('fmt ', 12, 'ascii')
      buffer.writeUInt32LE(fmtSize, 16)
      buffer.writeUInt16LE(extensible ? 0xfffe : float ? 3 : 1, 20)
      buffer.writeUInt16LE(1, 22)
      buffer.writeUInt32LE(sampleRate, 24)
      buffer.writeUInt32LE(sampleRate * bytesPerSample, 28)
      buffer.writeUInt16LE(bytesPerSample, 32)
      buffer.writeUInt16LE(bits, 34)
      if (extensible) {
        buffer.writeUInt16LE(22, 36)
        buffer.writeUInt16LE(bits, 38)
        buffer.writeUInt32LE(0, 40)
        buffer.writeUInt16LE(float ? 3 : 1, 44)
        Buffer.from([0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(buffer, 46)
      }
      buffer.write('data', dataStart - 8, 'ascii')
      buffer.writeUInt32LE(dataSize, dataStart - 4)
      const clamp = (value) => Math.max(-32768, Math.min(32767, Math.round(value)))
      for (let i = 0; i < samples.length; i += 1) {
        const value = clamp(samples[i])
        const offset = dataStart + i * bytesPerSample
        if (float) buffer.writeFloatLE(value / 32768, offset)
        else if (bits === 8) buffer.writeUInt8(Math.round(value / 256) + 128, offset)
        else if (bits === 16) buffer.writeInt16LE(value, offset)
        else if (bits === 32) buffer.writeInt32LE(value * 65536, offset)
        else {
          const wide = value * 256
          buffer.writeUInt8(wide & 0xff, offset)
          buffer.writeUInt8((wide >> 8) & 0xff, offset + 1)
          buffer.writeUInt8((wide >> 16) & 0xff, offset + 2)
        }
      }
      return buffer
    }
    const tone = new Int16Array(16000)
    for (let i = 0; i < tone.length; i += 1) tone[i] = Math.round(Math.sin(i / 40) * 9000)

    for (const variant of [
      { name: '24-bit', bits: 24, float: false, extensible: false },
      { name: '32-bit int', bits: 32, float: false, extensible: false },
      { name: '32-bit float', bits: 32, float: true, extensible: false },
      { name: '24-bit extensible', bits: 24, float: false, extensible: true },
      { name: 'float extensible', bits: 32, float: true, extensible: true },
    ]) {
      const file = join(scratch, `variant-${variant.bits}-${variant.float ? 'f' : 'i'}-${variant.extensible ? 'ext' : 'plain'}.wav`)
      writeFileSync(file, buildWav({ samples: tone, sampleRate: 16000, ...variant }))
      const decoded = readMono16k(file)
      const expected = toMono16k(parseWav(readFileSync(file)).samples, 1, 16000)
      check(
        `streamed ${variant.name} WAV decodes like the in-memory path`,
        decoded.length === expected.length && decoded.every((value, index) => value === expected[index]),
        `${decoded.length} frames`,
      )
    }
    rmSync(scratch, { recursive: true, force: true })
  }

  // 13. job_status: requested ids that no longer exist must not look settled
  {
    const { jobStatus } = await import('../mcp/tools.mjs')
    const queue = new JobQueue({ limit: 1, execute: async () => ({ ok: true }) })
    const finished = queue.submit({ kind: 'tts', params: {}, cfg: {} })
    await sleep(30)
    const context = { jobs: queue }
    const known = jobStatus({ job_ids: [finished.job_id] }, resolveConfig({}), context)
    check(
      'job_status settles a known id',
      known.all_settled === true && known.jobs.length === 1 && known.missing === undefined,
      JSON.stringify(known.jobs.map((job) => job.status)),
    )
    const mixed = jobStatus({ job_ids: [finished.job_id, 'job-does-not-exist'] }, resolveConfig({}), context)
    check(
      'job_status reports unknown ids instead of claiming completion',
      mixed.all_settled === false && JSON.stringify(mixed.missing) === JSON.stringify(['job-does-not-exist']),
      JSON.stringify(mixed.missing),
    )
    queue.dispose()
  }

  // 14. sentence timeline: no usable speech must fall back to the whole file
  {
    let spawnWorks = false
    try {
      const probe = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      probe.kill()
      spawnWorks = true
    } catch {
      spawnWorks = false
    }
    if (!spawnWorks) {
      console.log('SKIP  vad fallback (spawn with piped stdio is blocked in this sandbox)')
    } else {
      try {
        const { transcribeWithTimestamps } = await import('../mcp/segments.mjs')
        const workDir = join(STATE_DIR, 'tmp', 'vad-fallback-test')
        mkdirSync(workDir, { recursive: true })
        const silent = join(workDir, 'silence.wav')
        writeFileSync(silent, encodeWav(new Int16Array(16000 * 3), 16000))
        const cfg = resolveConfig({ asrMinSegmentMs: 10000 })
        cfg.output.tmp = workDir
        let calls = 0
        const timeline = await transcribeWithTimestamps({
          audioPath: silent,
          cfg,
          language: 'zh',
          transcribe: async () => {
            calls += 1
            return { text: '整段回退' }
          },
        })
        check(
          'empty VAD result falls back to one whole-file transcript',
          timeline.fallback === true && timeline.text === '整段回退' && timeline.segments.length === 1 && calls === 1,
          `fallback=${timeline.fallback} calls=${calls} segments=${timeline.segments.length}`,
        )
        rmSync(workDir, { recursive: true, force: true })
      } catch (error) {
        console.log(`SKIP  vad fallback (${String(error?.message ?? error).slice(0, 100)})`)
      }
    }
  }

  // restore a state file that matches the shipped defaults
  writeStateConfig(defaults, { engine: { enabled: true, autoStart: true, url: defaults.engine.url } }, DEFAULT_CONFIG)

  const failed = results.filter((result) => !result.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((result) => result.name).join(', '))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
