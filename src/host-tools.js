/**
 * Native DSH tools (`audio_toolkit_*`).
 *
 * MCP names every bridged tool `mcp__<server>__<raw>`, so exact names are only
 * possible through the host tool registry. These definitions reuse the very same
 * handlers the standalone MCP server exposes (`mcp/tools.mjs`), so both surfaces
 * share one implementation and one engine client.
 *
 * The async trio (`submit_tasks` / `job_status` / `cancel_jobs`) needs a live job
 * queue; the plugin owns one and passes it through the execution context.
 */

import { TOOLKIT_VERSION } from './config.js'
import { TOOLS } from '../mcp/tools.mjs'
import { SlotQueue } from '../mcp/slots.mjs'

/**
 * Raw MCP tool name → model-facing DSH tool name.
 *
 * Every host name ends in a verb (or a precise noun: `engine_status` /
 * `job_status`), so a model never has to guess whether a tool acts or only
 * describes. `audio_toolkit_engine_status` is deliberately longer than
 * `audio_toolkit_job_status` — two bare `..._status` tools invite the wrong call.
 */
export const TOOL_NAMES = {
  tts_speak: 'audio_toolkit_tts_speak',
  asr_transcribe: 'audio_toolkit_asr_transcribe',
  tts_list_voices: 'audio_toolkit_tts_list_voices',
  audio_status: 'audio_toolkit_engine_status',
  submit_tasks: 'audio_toolkit_submit_tasks',
  job_status: 'audio_toolkit_job_status',
  cancel_jobs: 'audio_toolkit_cancel_jobs',
}

/**
 * Tools that hit the engine, and therefore honour `maxConcurrentCalls`.
 *
 * The control tools (`status` / `jobs` / `cancel`) stay outside the limit on
 * purpose: queueing a poll behind two long syntheses would make async polling
 * useless.
 */
const ENGINE_TOOLS = new Set(['tts_speak', 'asr_transcribe'])

/** Output schema shared by every tool: each returns a JSON object. */
const OUTPUT_SCHEMA = { type: 'object' }

/** Extra time the watchdog allows on top of the engine request deadline. */
const WATCHDOG_GRACE_MS = 15_000

/**
 * Run one tool handler under a deadline.
 *
 * The engine client already applies `toolCallTimeoutMs` to every HTTP request,
 * but a handler can still hang outside it (waiting for a slot, a native helper
 * that ignores its abort signal, or a future code path). DSH's tool call would
 * then wait for the definition's 15-minute timeout, which looks exactly like a
 * dead agent. This aborts at the configured deadline + grace and turns the
 * resulting cancellation into a readable tool error.
 *
 * @param {(signal: AbortSignal) => Promise<any>} run
 * @param {number} timeoutMs engine-request deadline from the panel config
 * @param {AbortSignal} [outer] DSH's cancellation signal
 */
function runWithDeadline(run, timeoutMs, outer) {
  const controller = new AbortController()
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const deadline = Math.max(1, Number(timeoutMs) || 1) + WATCHDOG_GRACE_MS
  let timedOut = false
  let rejectDeadline
  // Racing the handler (rather than only aborting it) is what guarantees a
  // response: a control tool that never settles cannot hold the agent forever.
  const deadlineHit = new Promise((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timer = setTimeout(() => {
    timedOut = true
    const error = new Error(
      `工具调用超过 ${Math.round(deadline / 1000)}s 仍未返回（可能引擎未启动、模型仍在加载或请求排队过久）。` +
        '请查看 state/host.log 与 state/engine.log；确认引擎已启动后可重试。',
    )
    abort(error)
    rejectDeadline(error)
  }, deadline)
  timer.unref?.()

  let onOuterAbort
  if (outer) {
    const outerReason = () => (outer.reason instanceof Error ? outer.reason : new Error('调用已取消'))
    if (outer.aborted) {
      abort(outerReason())
      rejectDeadline(outerReason())
    } else {
      onOuterAbort = () => {
        abort(outerReason())
        rejectDeadline(outerReason())
      }
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  // `run` may be synchronous (a control tool or a test stub); normalize first.
  const body = Promise.resolve().then(() => run(controller.signal))
  return Promise.race([body, deadlineHit])
    .catch((error) => {
      // SlotQueue reports aborts as `AbortError`, which a tool runtime may treat
      // as a silent cancellation. Our own deadline has to stay a visible error.
      if (timedOut && error?.name === 'AbortError') {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      throw error
    })
    .finally(() => {
      clearTimeout(timer)
      if (outer && onOuterAbort) outer.removeEventListener('abort', onOuterAbort)
    })
}

/** Render a tool result as one pretty JSON text block. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Convert a handler result into lossless JSON.
 *
 * The registry rejects results that JSON cannot round-trip (`undefined` fields are
 * the usual culprit), so normalize before returning.
 * @param {unknown} value
 */
function toLosslessJson(value) {
  const text = JSON.stringify(value ?? null)
  return text === undefined ? null : JSON.parse(text)
}

/**
 * Build the registry-ready definitions.
 * @param {(exec?: unknown) => ReturnType<typeof import('./config.js').resolveConfig>} getConfig
 * @param {{jobs?: import('../mcp/jobs.mjs').JobQueue}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function buildToolDefinitions(getConfig, { jobs } = {}) {
  // One limiter per registry: the panel's `maxConcurrentCalls` used to govern only
  // the job queue, so parallel tool calls could pile onto a single GPU.
  const slots = new SlotQueue()
  return TOOLS.map((tool) => {
    const name = TOOL_NAMES[tool.name]
    if (!name) throw new Error(`host tool mapping missing for ${tool.name}`)
    return {
      name,
      description: tool.description,
      // The MCP input schema is already JSON Schema, which is what the tool
      // registry stores and validates arguments against.
      parameters: tool.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      // Declarative only: the registry does not enforce deadlines, and the real
      // bound on one call is the panel's `toolCallTimeoutMs` on the engine request.
      timeoutMs: 900_000,
      async execute(args, exec) {
        const config = getConfig(exec)
        const call = (signal) =>
          tool.handler(args ?? {}, config, {
            signal,
            version: TOOLKIT_VERSION,
            configSource: 'plugin state',
            jobs,
          })
        const value = await runWithDeadline(
          (signal) =>
            ENGINE_TOOLS.has(tool.name)
              ? slots.run(config.mcp.maxConcurrentCalls, () => call(signal), signal)
              : call(signal),
          config.mcp.toolCallTimeoutMs,
          exec?.signal,
        )
        return toLosslessJson(value)
      },
    }
  })
}

/**
 * Register the audio tools on the calling plugin's `ctx.tools`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(exec?: unknown) => ReturnType<typeof import('./config.js').resolveConfig>} getConfig
 * @param {{jobs?: import('../mcp/jobs.mjs').JobQueue}} [options]
 * @returns {string[]} registered tool names
 */
export function registerHostTools(ctx, getConfig, options = {}) {
  // `ctx.tools` is guarded by Cordis' inject check. The plugin declares
  // `inject: ['tools']`, but a loader/build that drops named exports (observed
  // with some third-party bundle paths) leaves the getter throwing even though
  // the service exists. `ctx.get()` is the inject-free read and keeps the tools
  // registerable in that case.
  let tools
  try {
    tools = ctx?.tools
  } catch {
    tools = undefined
  }
  if (!tools?.register && typeof ctx?.get === 'function') {
    try {
      tools = ctx.get('tools')
    } catch {
      tools = undefined
    }
  }
  if (!tools?.register) {
    throw new Error('ctx.tools 不可用：无法注册 audio_toolkit_* 工具')
  }
  const registered = []
  for (const definition of buildToolDefinitions(getConfig, options)) {
    tools.register(definition)
    registered.push(definition.name)
  }
  return registered
}
