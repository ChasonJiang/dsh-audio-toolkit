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
        const call = () =>
          tool.handler(args ?? {}, config, {
            signal: exec?.signal,
            version: TOOLKIT_VERSION,
            configSource: 'plugin state',
            jobs,
          })
        const value = ENGINE_TOOLS.has(tool.name)
          ? await slots.run(config.mcp.maxConcurrentCalls, call, exec?.signal)
          : await call()
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
  if (!ctx?.tools?.register) {
    throw new Error('ctx.tools 不可用：无法注册 audio_toolkit_* 工具')
  }
  const registered = []
  for (const definition of buildToolDefinitions(getConfig, options)) {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }
  return registered
}
