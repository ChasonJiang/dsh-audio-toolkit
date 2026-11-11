#!/usr/bin/env node
/**
 * End-to-end smoke test for the resident-engine architecture.
 *
 * Starts a private audio.cpp engine on a scratch port (so it never collides with
 * the one DSH owns), points the MCP server at it through a scratch state file,
 * and exercises every tool with real models.
 *
 * Reference audio defaults to the repository's ./audio_samples (development
 * fixtures only).
 *
 * Usage:
 *   node test/smoke.mjs [--voice-ref <wav>] [--audio <wav>] [--skip-tts] [--skip-asr] [--port 8799]
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { REPO_ROOT, resolveConfig, writeEngineConfig } from '../src/config.js'
import { AudioEngine } from '../src/engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const SERVER = join(PACKAGE_ROOT, 'mcp', 'server.mjs')
const SCRATCH = join(REPO_ROOT, 'out', '.tmp', 'smoke')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const nodePath = process.env.AUDIO_TOOLKIT_NODE || process.execPath
const port = Number(value('port') ?? 8799)

/** First .wav in ./audio_samples, used as a development fixture. */
function sampleAudio() {
  const dir = join(REPO_ROOT, 'audio_samples')
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.wav'))
  if (files.length === 0) return undefined
  return join(dir, files.sort((a, b) => a.length - b.length)[0])
}

const voiceRef = value('voice-ref') || sampleAudio()
const audio = value('audio') || sampleAudio()
const TTS_TEXT = '今天下午三点，我们在会议室过一遍常驻引擎的音频工具链联调结果。'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal JSON-RPC client over the server's stdio. */
class Client {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        console.log(`  <unparsed stdout> ${line.slice(0, 200)}`)
        return
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`))
        else done(message.result)
      }
    })
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => console.log(`  [stderr] ${line}`))
  }

  request(method, params = {}, timeoutMs = 900_000) {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolvePromise(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rejectPromise(e)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async callTool(name, toolArgs = {}) {
    const result = await this.request('tools/call', { name, arguments: toolArgs })
    const text = result?.content?.[0]?.text ?? ''
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
    return { isError: result?.isError === true, payload }
  }
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true })

  // 1. private engine on a scratch port
  const config = resolveConfig(
    {
      enginePort: port,
      engineEnabled: true,
      engineAutoStart: false,
      outputFolder: 'out',
    },
    { baseDir: SCRATCH },
  )
  config.engine.configPath = join(SCRATCH, 'engine.json')
  config.engine.logPath = join(SCRATCH, 'engine.log')
  config.output.tmp = join(SCRATCH, 'tmp')
  writeEngineConfig(config, config.engine.configPath)

  const log = (message) => console.log(`  [engine] ${message}`)
  const engine = new AudioEngine({ config, log })
  const started = await engine.start()
  record(
    'engine start',
    started.started || started.reused,
    started.error ?? `${config.engine.url} pid=${engine.child?.pid}`,
  )
  if (!started.started && !started.reused) {
    console.log(`\nengine log: ${config.engine.logPath}`)
    process.exitCode = 1
    return
  }

  // A second start must reuse the running engine instead of spawning another one.
  const again = await engine.start()
  record('engine reuse (no second process)', again.reused === true, `started=${again.started}`)

  // 2. MCP server pointed at the scratch state file
  const statePath = join(SCRATCH, 'config.json')
  writeFileSync(
    statePath,
    JSON.stringify(
      // maxConcurrentCalls=1 so a batch leaves one job queued for the cancel test.
      {
        version: 'test',
        config: { enginePort: port, outputFolder: 'out', maxConcurrentCalls: 1, mcpServerName: 'audio' },
      },
      null,
      2,
    ),
  )
  const child = spawn(nodePath, [SERVER], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AUDIO_TOOLKIT_CONFIG: statePath, AUDIO_TOOLKIT_JOBS: join(SCRATCH, 'jobs.json') },
    windowsHide: true,
  })
  const client = new Client(child)

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'audio-toolkit-smoke', version: '0.0.0' },
    })
    record(
      'initialize',
      typeof init.protocolVersion === 'string' && init.serverInfo?.name === 'audio',
      `protocol=${init.protocolVersion} v${init.serverInfo?.version} name=${init.serverInfo?.name}`,
    )
    client.notify('notifications/initialized')

    const list = await client.request('tools/list')
    const names = (list.tools ?? []).map((tool) => tool.name).sort()
    const expectedTools = ['asr_transcribe', 'audio_status', 'cancel_jobs', 'job_status', 'submit_tasks', 'tts_list_voices', 'tts_speak']
    record('tools/list', JSON.stringify(names) === JSON.stringify(expectedTools), names.join(', '))

    const status = await client.callTool('audio_status')
    record(
      'audio_status (engine running)',
      !status.isError && status.payload?.engine?.running === true,
      JSON.stringify(status.payload?.engine?.models?.map((m) => `${m.id}:${m.loaded}`) ?? []),
    )

    const voices = await client.callTool('tts_list_voices')
    record('tts_list_voices', !voices.isError && Array.isArray(voices.payload?.voices), `count=${voices.payload?.voices?.length ?? 0}`)
    if (existsSync(join(REPO_ROOT, 'audio_samples'))) {
      const sample = await client.callTool('tts_list_voices', { voice_dir: join(REPO_ROOT, 'audio_samples') })
      record('tts_list_voices (audio_samples)', !sample.isError && (sample.payload?.voices?.length ?? 0) > 0, `count=${sample.payload?.voices?.length ?? 0}`)
    }

    let transcript
    let timeline
    let ttsOut
    if (!flag('skip-asr') && audio) {
      const asr = await client.callTool('asr_transcribe', { audio_path: audio, language: 'zh' })
      const textPath = asr.payload?.text_path
      const saved = typeof textPath === 'string' && existsSync(textPath) ? readFileSync(textPath, 'utf8').trim() : ''
      transcript = saved
      record(
        'asr_transcribe returns the transcript path only',
        !asr.isError && asr.payload?.text === undefined && asr.payload?.segments === undefined,
        `text_path=${String(textPath ?? '(none)').replace(/\\/g, '/').split('/').slice(-1)[0]}`,
      )
      record(
        'asr_transcribe writes the transcript into the output folder',
        saved.length > 0,
        `${saved.length} chars • ${String(textPath ?? '')}`,
      )
      const verbose = await client.callTool('asr_transcribe', { audio_path: audio, language: 'zh', return_text: true })
      record(
        'return_text: true returns the transcript inline',
        !verbose.isError && typeof verbose.payload?.text === 'string' && verbose.payload.text.length > 0,
        String(verbose.payload?.text ?? '').slice(0, 40),
      )
    }

    if (!flag('skip-asr') && audio) {
      const stamped = await client.callTool('asr_transcribe', { audio_path: audio, language: 'zh', timestamps: true })
      const segmentsPath = stamped.payload?.segments_path
      const parsed = typeof segmentsPath === 'string' && existsSync(segmentsPath) ? JSON.parse(readFileSync(segmentsPath, 'utf8')) : undefined
      timeline = parsed?.segments
      const ok =
        !stamped.isError &&
        Array.isArray(timeline) &&
        timeline.length > 0 &&
        timeline.every((segment) => segment.start_ms < segment.end_ms && typeof segment.text === 'string')
      const preview = (timeline ?? [])
        .slice(0, 2)
        .map((segment) => `${segment.start_ms}-${segment.end_ms}ms`)
        .join(', ')
      record(
        'asr_transcribe (sentence timestamps)',
        ok && stamped.payload?.segments === undefined,
        `${timeline?.length ?? 0} segments • ${preview}`,
      )
      record(
        'timeline writes .txt and .segments.json',
        existsSync(stamped.payload?.text_path ?? '') && existsSync(segmentsPath ?? ''),
        String(segmentsPath ?? '').replace(/\\/g, '/').split('/').slice(-1)[0],
      )
    }

    // Async: submit a batch, poll for completion, then cancel a queued job.
    if (!flag('skip-tts') && voiceRef && !flag('skip-asr') && audio) {
      const batch = await client.callTool('submit_tasks', {
        tasks: [
          { kind: 'tts', text: '异步任务一：合成这一句。', voice_path: voiceRef, language: 'zh', output_path: 'async-1.wav' },
          { kind: 'asr', audio_path: audio, language: 'zh' },
        ],
      })
      const ids = (batch.payload?.submitted ?? []).map((job) => job.job_id)
      record('submit_tasks queues a batch', !batch.isError && ids.length === 2, ids.join(', '))

      let polled
      for (let attempt = 0; attempt < 80; attempt += 1) {
        polled = await client.callTool('job_status', { job_ids: ids })
        if (polled.payload?.all_settled) break
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
      }
      const jobs = polled.payload?.jobs ?? []
      record(
        'job_status reports completion',
        polled.payload?.all_settled === true && jobs.every((job) => job.status === 'done'),
        jobs.map((job) => `${job.kind}:${job.status}`).join(', '),
      )
      record(
        'async results carry output paths',
        jobs.some((job) => typeof job.result?.audio_path === 'string') &&
          jobs.some((job) => typeof job.result?.text_path === 'string'),
        `${jobs.filter((job) => job.result?.audio_path).length} audio / ${jobs.filter((job) => job.result?.text_path).length} text`,
      )

      const cancellable = await client.callTool('submit_tasks', {
        tasks: [
          { kind: 'tts', text: '取消测试第一段。', voice_path: voiceRef, language: 'zh', output_path: 'cancel-a.wav' },
          { kind: 'tts', text: '取消测试第二段。', voice_path: voiceRef, language: 'zh', output_path: 'cancel-b.wav' },
        ],
      })
      const cancelIds = (cancellable.payload?.submitted ?? []).map((job) => job.job_id)
      // Cancel right away: the limiter is 1, so the second task is still queued.
      const cancelled = await client.callTool('cancel_jobs', { job_ids: [cancelIds[1]] })
      record(
        'cancel_jobs cancels a queued job',
        !cancelled.isError && (cancelled.payload?.cancelled ?? []).includes(cancelIds[1]),
        JSON.stringify(cancelled.payload?.cancelled ?? []),
      )
      const afterCancel = await client.callTool('job_status', { job_ids: cancelIds })
      record(
        'cancelled job reports cancelled',
        (afterCancel.payload?.jobs ?? []).some((job) => job.job_id === cancelIds[1] && job.status === 'cancelled'),
        (afterCancel.payload?.jobs ?? []).map((job) => `${job.kind}:${job.status}`).join(', '),
      )
    }

    if (!flag('skip-tts') && voiceRef) {
      const first = Date.now()
      const tts = await client.callTool('tts_speak', {
        text: TTS_TEXT,
        voice_path: voiceRef,
        language: 'zh',
        output_path: 'smoke-tts.wav',
        seed: 20261111,
      })
      ttsOut = tts.payload?.audio_path
      record(
        'tts_speak (fp16, cold)',
        !tts.isError && Boolean(ttsOut) && existsSync(ttsOut),
        `${Date.now() - first}ms 墙钟 • ${ttsOut}`,
      )

      const warmStart = Date.now()
      const warm = await client.callTool('tts_speak', {
        text: '第二次调用复用常驻模型。',
        voice_path: voiceRef,
        language: 'zh',
        output_path: 'smoke-tts-warm.wav',
      })
      record(
        'tts_speak (warm)',
        !warm.isError && existsSync(warm.payload?.audio_path ?? ''),
        `${Date.now() - warmStart}ms 墙钟（常驻模型应明显更快）`,
      )

      if (ttsOut && !flag('skip-asr')) {
        const back = await client.callTool('asr_transcribe', { audio_path: ttsOut, language: 'zh', return_text: true })
        const text = String(back.payload?.text ?? '')
        const overlap = text.includes('音频') || text.includes('会议') || text.includes('工具')
        record('tts→asr round trip', !back.isError && overlap, text.slice(0, 70))
      }
    }

    if (flag('extended') && voiceRef) {
      const longText =
        '第一段，验证长文本与情绪控制：请把这句话读得平静一些，语速稍微放慢。' +
        '第二段，验证多句连读和标点停顿，数字 2026 年 11 月 11 日，百分比 37.5%。'
      const tts = await client.callTool('tts_speak', {
        text: longText,
        voice_path: voiceRef,
        language: 'zh',
        emotion: '平静',
        emotion_alpha: 0.6,
        duration_scale: 1.05,
        output_path: 'extended-tts.wav',
      })
      record('tts_speak (emotion + long text)', !tts.isError && existsSync(tts.payload?.audio_path ?? ''), `${longText.length} 字`)
      if (audio) {
        const plain = await client.callTool('asr_transcribe', {
          audio_path: audio,
          language: 'zh',
          normalize_text: false,
          return_text: true,
        })
        const plainText = String(plain.payload?.text ?? '')
        // Tags are never requested any more: the transcript must stay plain.
        record(
          'asr_transcribe (plain text, tags stripped, no ITN)',
          !plain.isError && plainText.length > 0 && !plainText.includes('<|'),
          plainText.slice(0, 60),
        )
      }
    }

    const unknown = await client.callTool('does_not_exist')
    record('unknown tool → isError', unknown.isError === true)

    // 3. stopped engine must produce an actionable tool error, not a crash
    await engine.stop()
    const down = await client.callTool('tts_speak', { text: '引擎停止后的调用', voice_path: voiceRef ?? '' })
    record(
      'tool error when engine is stopped',
      down.isError === true && String(down.payload?.error ?? '').includes('引擎未运行'),
      String(down.payload?.error ?? '').slice(0, 60),
    )

    const failed = results.filter((result) => !result.ok)
    console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length > 0) {
      console.log('failed:', failed.map((result) => result.name).join(', '))
      process.exitCode = 1
    }
  } finally {
    child.kill()
    await engine.stop()
  }
}

main().catch(async (error) => {
  console.error(`\n[FATAL] ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
})
