#!/usr/bin/env node
/**
 * Network-level checks for the engine client and the MCP server.
 *
 * Three regressions are covered, all of which used to hang or leak work:
 *  - the request deadline must cover the **response body**, not just the headers
 *    (a server that answers `200` and then stalls used to hang the tool call);
 *  - an already-cancelled caller signal must not open a connection at all;
 *  - `notifications/cancelled` must abort a running `tools/call`, so a cancelled
 *    TTS request stops instead of holding the engine for the full timeout.
 *
 * Everything runs against a local stub engine on an ephemeral port; no models and
 * no real audio.cpp binary are needed.
 *
 * Usage: node test/http.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { transcribeAudio } from '../mcp/engine.mjs'
import { SlotQueue } from '../mcp/slots.mjs'
import { asrTranscribe } from '../mcp/tools.mjs'
import { REPO_ROOT, isFile, resolveConfig } from '../src/config.js'
import { encodeWav } from '../src/wav.js'
import { isReadyWav } from '../mcp/transcode.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const SERVER = join(PACKAGE_ROOT, 'mcp', 'server.mjs')
const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-audio-http-'))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Rejection captured as `{ message, details }` so a test can assert on it. */
async function rejection(promise) {
  try {
    await promise
    return undefined
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), details: error?.details }
  }
}

/**
 * Stub engine that accepts the TCP connection, writes a 200 header plus the first
 * bytes of a body, and then never finishes — the shape of a wedged inference.
 * @param {(req: import('node:http').IncomingMessage) => boolean} [isHealth]
 */
async function stallingEngine(isHealth = () => false) {
  const state = { hits: 0, health: 0 }
  const sockets = new Set()
  const server = createServer((req, res) => {
    state.hits += 1
    // The client aborts mid-body, so both sides can see a dead socket.
    req.on('error', () => {})
    res.on('error', () => {})
    if (isHealth(req)) {
      state.health += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"text":"')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl,
    state,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

/** Minimal JSON-RPC client over the MCP server's stdio. */
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
        return
      }
      const entry = message.id === undefined ? undefined : this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', () => {})
  }

  /** Send one request and return its id beside the pending response promise. */
  send(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    return { id, promise }
  }

  request(method, params = {}) {
    return this.send(method, params).promise
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
}

/** Generate a small WAV fixture; the repository ships no sample audio. */
function fixtureWav(name) {
  mkdirSync(SCRATCH, { recursive: true })
  const path = join(SCRATCH, name)
  writeFileSync(path, encodeWav(new Int16Array(16000), 16000))
  return path
}

/**
 * Whether the audio.cpp release and models are installed.
 *
 * CI has neither (they weigh gigabytes), so engine-backed checks report SKIP.
 * `AUDIO_TOOLKIT_NO_ASSETS=1` forces that mode locally.
 */
function assetsInstalled() {
  if (process.env.AUDIO_TOOLKIT_NO_ASSETS === '1') return false
  const cfg = resolveConfig({})
  return isFile(cfg.engine.exePath) && isFile(cfg.tts.model) && isFile(cfg.asr.model)
}

/**
 * The ASR handler must forward `chunk_mode` / `chunk_seconds` to the engine.
 *
 * A regression here is silent: the tool result reports the handler's own
 * `chunk_mode`, so only the outgoing request proves the value survived. The stub
 * engine records each transcription body and answers with a fixed transcript.
 */
async function chunkingOptionsCheck() {
  // A 16 kHz mono WAV needs no ffmpeg, so this check stays runnable in a sandbox
  // that forbids spawning helpers.
  mkdirSync(SCRATCH, { recursive: true })
  const ready = join(SCRATCH, 'ready-16k.wav')
  writeFileSync(ready, encodeWav(new Int16Array(1600), 16000))
  check('a 16 kHz mono WAV is accepted without transcoding', isReadyWav(ready) === true)

  const recorded = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"ok"}')
        return
      }
      if (req.url === '/v1/audio/transcriptions') {
        recorded.push(body ? JSON.parse(body) : {})
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: 'ok' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const cfg = resolveConfig({ enginePort: server.address().port })
  try {
    await asrTranscribe(
      { audio_path: ready, save_to_file: false, chunk_mode: 'none', chunk_seconds: 7 },
      cfg,
    )
    const sent = recorded[0] ?? {}
    check(
      'asr forwards chunk_mode instead of forcing fixed',
      sent.options?.audio_chunk_mode === 'none',
      JSON.stringify(sent.options ?? null),
    )
    check(
      'asr forwards chunk_seconds',
      sent.options?.audio_chunk_duration_sec === 7,
      String(sent.options?.audio_chunk_duration_sec),
    )


  } finally {
    server.close()
  }
}

async function cancellationCheck(ttsPort) {
  const voiceRef = fixtureWav('cancel-voice.wav')

  const statePath = join(SCRATCH, 'config.json')
  writeFileSync(
    statePath,
    JSON.stringify({
      config: { enginePort: ttsPort, toolCallTimeoutMs: 60_000, outputFolder: 'http-test-out', mcpServerName: 'audio' },
    }),
  )
  let child
  try {
    child = spawn(process.execPath, [SERVER], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AUDIO_TOOLKIT_CONFIG: statePath, AUDIO_TOOLKIT_JOBS: join(SCRATCH, 'jobs.json') },
      windowsHide: true,
    })
  } catch (error) {
    child = undefined
    const code = error?.code ?? ''
    // A confined sandbox forbids spawning with piped stdio; the SlotQueue and
    // engine-client checks above still cover the cancellation logic.
    console.log(`SKIP  cancellation (cannot spawn the MCP server here: ${code || error.message})`)
    return 'skipped'
  }
  if (child === undefined) return 'skipped'
  const client = new Client(child)
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'audio-toolkit-http-test', version: '0.0.0' },
    })
    check('cancellation: MCP server initializes', init?.serverInfo?.name === 'audio', init?.protocolVersion)
    client.notify('notifications/initialized')

    const started = Date.now()
    const call = client.send('tools/call', {
      name: 'tts_speak',
      arguments: { text: '这条请求应该被取消。', voice_path: voiceRef, output_path: 'cancelled.wav' },
    })
    // Give the server time to reach the (stalled) engine request, then cancel.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
    client.notify('notifications/cancelled', { requestId: call.id, reason: 'test cancel' })

    const result = await Promise.race([
      call.promise,
      new Promise((resolvePromise) => setTimeout(() => resolvePromise('timeout'), 8_000)),
    ])
    const elapsed = Date.now() - started
    const text = result === 'timeout' ? '' : (result?.content?.[0]?.text ?? '')
    check('cancellation: tools/call settles instead of waiting for the timeout', elapsed < 5_000, `${elapsed}ms`)
    check('cancellation: the result is an error the model can read', result !== 'timeout' && result?.isError === true, text.slice(0, 80))
    check('cancellation: the error says it was cancelled', text.includes('已取消'), text.slice(0, 80))
    // The queued-slot bookkeeping must be clean enough to serve the next call.
    const next = await client.request('tools/call', { name: 'job_status', arguments: {} })
    check('cancellation: the server still answers afterwards', next?.content?.[0]?.text !== undefined)
  } finally {
    child.kill()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  return 'ran'
}

async function main() {
  // 1. the deadline covers the response body
  const stalling = await stallingEngine()
  try {
    const started = Date.now()
    const error = await rejection(
      transcribeAudio({ baseUrl: stalling.baseUrl, model: 'asr', audioPath: 'x.wav', timeoutMs: 400 }),
    )
    const elapsed = Date.now() - started
    check('stalled body: the call fails instead of hanging', error !== undefined, error?.message ?? 'resolved')
    check('stalled body: it fails at the deadline', elapsed >= 350 && elapsed < 3_000, `${elapsed}ms`)
    check('stalled body: the failure is reported as a timeout', error?.details?.code === 'TIMEOUT', JSON.stringify(error?.details))
  } finally {
    stalling.close()
  }

  // 2. an already-cancelled signal never reaches the network
  const counting = await stallingEngine()
  try {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const error = await rejection(
      transcribeAudio({ baseUrl: counting.baseUrl, model: 'asr', audioPath: 'x.wav', timeoutMs: 5_000, signal: controller.signal }),
    )
    check('pre-aborted signal: the call is rejected', error?.details?.code === 'ABORTED', error?.message ?? 'resolved')
    check('pre-aborted signal: no request is sent', counting.state.hits === 0, `${counting.state.hits} request(s)`)
  } finally {
    counting.close()
  }

  const hasAssets = assetsInstalled()

  // 3. notifications/cancelled aborts a running tool call
  const engine = await stallingEngine((req) => req.method === 'GET' && req.url === '/health')
  try {
    if (hasAssets) {
      const outcome = await cancellationCheck(Number(new URL(engine.baseUrl).port))
      if (outcome === 'ran') {
        check('cancellation: the stub engine was actually contacted', engine.state.hits > 0, `${engine.state.hits} request(s)`)
      }
    } else {
      console.log('SKIP  cancellation (audio.cpp release / models not installed)')
    }
  } finally {
    engine.close()
    rmSync(SCRATCH, { recursive: true, force: true })
    rmSync(join(REPO_ROOT, 'http-test-out'), { recursive: true, force: true })
  }

  // 4. the limiter behind the cancellation: a queued call must never run
  {
    const slots = new SlotQueue()
    const order = []
    const queueController = new AbortController()
    const running = slots.run(1, async () => {
      order.push('a:start')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
      order.push('a:end')
      return 'a'
    })
    const queued = slots.run(1, async () => {
      order.push('b:start')
      return 'b'
    }, queueController.signal)
    queueController.abort(new Error('queued cancel'))
    const queuedError = await rejection(queued)
    check('slot queue: a queued call is rejected on cancel', queuedError?.message?.includes('已取消') === true, queuedError?.message)
    check('slot queue: a cancelled queued call never runs', order.includes('b:start') === false, order.join(' '))
    check('slot queue: the running call still completes', (await running) === 'a', order.join(' '))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    const after = await slots.run(1, async () => 'c')
    check('slot queue: the freed slot is reused after a cancellation', after === 'c', order.join(' '))

    const runningController = new AbortController()
    const started = Date.now()
    const slow = slots.run(1, async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
      return 'slow'
    }, runningController.signal)
    setTimeout(() => runningController.abort(new Error('running cancel')), 50)
    const slowError = await rejection(slow)
    check(
      'slot queue: a running call is rejected promptly on cancel',
      slowError?.message?.includes('已取消') === true && Date.now() - started < 300,
      `${Date.now() - started}ms — ${slowError?.message}`,
    )
    // Its body still owns the slot until it settles, so the next call must wait.
    const late = await slots.run(1, async () => 'late')
    check('slot queue: the slot is released only when the body settles', late === 'late', `${Date.now() - started}ms`)
  }

  // 5. the ASR handler forwards its chunking options to the engine
  if (hasAssets) await chunkingOptionsCheck()
  else console.log('SKIP  chunking options (audio.cpp release / models not installed)')

  const failed = results.filter((result) => !result.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((result) => result.name).join(', '))
    process.exitCode = 1
  }
  // The stub sockets are destroyed above; nothing should keep the loop alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
