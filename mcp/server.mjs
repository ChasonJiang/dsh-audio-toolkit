#!/usr/bin/env node
/**
 * Dependency-free MCP server (stdio, newline-delimited JSON-RPC 2.0) for
 * audio.cpp TTS + ASR.
 *
 * Design notes:
 *  - stdout is the protocol channel; every diagnostic goes to stderr.
 *  - Each tool call reloads `state/config.json`, so a plugin-panel edit applies
 *    without restarting this process.
 *  - Calls are serialized by default: one audio.cpp process at a time keeps VRAM
 *    use predictable on a single GPU.
 */

import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { TOOLS, findTool } from './tools.mjs'
import { JobQueue } from './jobs.mjs'
import { SlotQueue } from './slots.mjs'
import {
  CONFIG_ENV,
  PACKAGE_ROOT,
  STATE_DIR,
  TOOLKIT_VERSION,
  loadStateConfig,
  prettyPath,
  summarize,
} from '../src/config.js'

/** Async job queue for this server process (created in `start`). */
let jobQueue

/** Protocol versions this server can speak, newest first. */
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

/** Default server identity; `start()` replaces the name with the configured one. */
let serverInfo = {
  name: 'dsh-audio-toolkit',
  title: 'audio.cpp TTS + ASR',
  version: TOOLKIT_VERSION,
}

const INSTRUCTIONS = [
  '本地音频工具：tts_speak 用 IndexTTS2.5 合成语音（需要参考音色 voice_path），asr_transcribe 用 SenseVoice 转写音频。',
  '转写默认只返回输出文件路径；需要正文时传 return_text=true，长转写可以只取路径再按需读取。',
  '工具返回 wav/文本的绝对路径；音频不会进入对话上下文，需要展示时用 present 或把路径告诉用户。',
  'audio_status 可以检查模型与 GPU 是否就绪，tts_list_voices 列出可用参考音色。',
].join('\n')

/** Log a line to stderr (never stdout). */
function log(message) {
  process.stderr.write(`[audio-toolkit] ${message}\n`)
}

/** Write one JSON-RPC message to stdout, honoring backpressure. */
function send(message) {
  return new Promise((resolvePromise) => {
    const ok = process.stdout.write(`${JSON.stringify(message)}\n`)
    if (ok) resolvePromise()
    else process.stdout.once('drain', resolvePromise)
  })
}

function sendResult(id, result) {
  return send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  return send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

/** Cancellation state for in-flight tool calls, keyed by JSON-RPC request id. */
const inflight = new Map()

/** Serialize tool calls so only N handlers run at once, cancellably. */
const slots = new SlotQueue()

/** Choose the protocol version to advertise back to the client. */
function negotiateProtocol(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)) return requested
  return LATEST_PROTOCOL
}

/** Build a tool result with one JSON text block. */
function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
  }
}

/** Build an error tool result the model can read and act on. */
function toolError(message, data) {
  const payload = { error: message, ...(data === undefined ? {} : { details: data }) }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  }
}

/**
 * Execute one `tools/call`.
 * @param {Record<string, any>} params
 * @param {string | number} [requestId] JSON-RPC id, used to pair a later
 *   `notifications/cancelled` with this call.
 */
async function handleToolsCall(params, requestId) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const tool = typeof name === 'string' ? findTool(name) : undefined
  if (!tool) {
    return toolError(`未知工具：${String(name)}`, { available: TOOLS.map((item) => item.name) })
  }
  // Re-read on every call: the plugin rewrites state/config.json on a panel edit.
  const { config, source } = loadStateConfig()
  const controller = new AbortController()
  if (requestId !== undefined) inflight.set(requestId, controller)
  const context = { version: TOOLKIT_VERSION, configSource: source, jobs: jobQueue, signal: controller.signal }
  try {
    const result = await slots.run(
      config.mcp.maxConcurrentCalls,
      () => tool.handler(args, config, context),
      controller.signal,
    )
    log(`${tool.name} ok (config: ${prettyPath(source)})`)
    return toolResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`${tool.name} failed: ${message}`)
    return toolError(message, error?.details)
  } finally {
    if (requestId !== undefined) inflight.delete(requestId)
  }
}

/** Abort the call behind one JSON-RPC request id, if it is still running. */
function cancelRequest(params) {
  const requestId = params?.requestId
  const controller = requestId === undefined ? undefined : inflight.get(requestId)
  if (controller === undefined) return
  controller.abort(new Error(typeof params?.reason === 'string' ? params.reason : 'client cancelled'))
  log(`cancel requested for ${String(requestId)}`)
}

/** Dispatch one decoded JSON-RPC message. */
async function dispatch(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  if (method === 'initialize') {
    const version = negotiateProtocol(params?.protocolVersion)
    const result = {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: INSTRUCTIONS,
    }
    if (isRequest) await sendResult(id, result)
    return
  }

  if (method === 'notifications/initialized' || method === 'initialized') return

  if (method === 'tools/list') {
    if (!isRequest) return
    await sendResult(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
    return
  }

  if (method === 'tools/call') {
    if (!isRequest) return
    await sendResult(id, await handleToolsCall(params, id))
    return
  }

  if (method === 'ping') {
    if (isRequest) await sendResult(id, {})
    return
  }

  // Optional resource/prompt surfaces: answer empty instead of erroring, so a
  // client that probes them is never confused.
  if (method === 'resources/list') {
    if (isRequest) await sendResult(id, { resources: [] })
    return
  }
  if (method === 'resources/templates/list') {
    if (isRequest) await sendResult(id, { resourceTemplates: [] })
    return
  }
  if (method === 'prompts/list') {
    if (isRequest) await sendResult(id, { prompts: [] })
    return
  }
  if (method === 'logging/setLevel') {
    if (isRequest) await sendResult(id, {})
    return
  }

  if (method === 'notifications/cancelled' || method === '$/cancelRequest') {
    cancelRequest(params)
    return
  }
  if (method === 'notifications/roots/list_changed') return

  if (isRequest) await sendError(id, -32601, `Method not found: ${String(method)}`)
}

/** Read one line of JSON-RPC from stdin. */
function start() {
  const { config, source } = loadStateConfig()
  // The panel's `mcpServerName` names this service for standalone MCP clients.
  serverInfo = { ...serverInfo, name: config.mcp.serverName || serverInfo.name }
  log(`v${TOOLKIT_VERSION} ready — config: ${prettyPath(source)} (${CONFIG_ENV} override supported)`)
  log(`engine: ${summarize(config)}`)
  log(`package: ${PACKAGE_ROOT}`)

  // One in-process queue for this server; jobs are independent of the RPC calls
  // that created them, so the client can poll instead of waiting.
  jobQueue = new JobQueue({
    limit: config.mcp.maxConcurrentCalls,
    // A separate snapshot from the host plugin's queue: two processes must not
    // overwrite each other's job registry.
    persistPath: process.env.AUDIO_TOOLKIT_JOBS || join(STATE_DIR, 'jobs.mcp.json'),
    execute: (kind, params, jobConfig, signal) => {
      const tool = findTool(kind === 'tts' ? 'tts_speak' : 'asr_transcribe')
      if (!tool) throw new Error(`未知任务类型：${kind}`)
      return tool.handler(params, jobConfig, { signal, version: TOOLKIT_VERSION, configSource: 'job', jobs: jobQueue })
    },
  })

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      log(`dropped malformed JSON-RPC line (${trimmed.length} bytes)`)
      return
    }
    // Dispatch independently: JSON-RPC correlates responses by id, and the
    // per-call queue above is what actually bounds concurrency.
    dispatch(message).catch((error) => {
      log(`dispatch error: ${error instanceof Error ? error.stack : String(error)}`)
    })
  })

  const shutdown = () => {
    log('stdin closed, exiting')
    try {
      jobQueue?.dispose()
    } catch {
      /* best effort */
    }
    process.exit(0)
  }
  rl.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start()
