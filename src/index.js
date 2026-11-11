/**
 * dsh-audio-toolkit — DeepSeek Harness host plugin.
 *
 * Responsibilities:
 *  1. declare the plugin Config schema rendered in the DSH plugin panel
 *     (every field is `.volatile()`, so a panel edit applies live);
 *  2. own the **resident** audio.cpp engine: start it with DSH, stop it when the
 *     plugin unloads or DSH exits, and start/stop it on the `engineEnabled` switch;
 *  3. self-check the install and publish the resolved config to
 *     `state/config.json` for the MCP server.
 *
 * The TTS/ASR tools are mounted by the sibling `@deepseek-ai/dsh-mcp-client` row
 * declared in `cordis.patch.yml`; the browser half (`src/client.js`) renders the
 * panel page.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_CONFIG,
  STATE_CONFIG_PATH,
  STATE_DIR,
  TOOLKIT_VERSION,
  readValue,
  resolveConfig,
  summarize,
  writeStateConfig,
} from './config.js'
import { AudioEngine, engineSettingsChanged } from './engine.js'
import { registerHostTools } from './host-tools.js'
import { JobQueue } from '../mcp/jobs.mjs'
import { findTool } from '../mcp/tools.mjs'

/**
 * Append one line to `state/host.log` and stdout.
 *
 * The desktop app does not expose the host console, so panel/tool problems would
 * otherwise be undiagnosable from the outside.
 * @param {string} message
 */
function hostLog(message) {
  console.log(`[dsh-audio-toolkit] ${message}`)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(join(STATE_DIR, 'host.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    /* logging must never break the plugin */
  }
}

/** Same destination, marked as a warning. */
function hostLogWarn(message) {
  hostLog(`WARN ${message}`)
}

/** Plugin display name used by the Loader diagnostics. */
export const name = 'dsh-audio-toolkit'

/**
 * Services this plugin needs before it activates.
 *
 * `tools` must be declared here: Cordis refuses to read `ctx.tools` from a plugin
 * that does not inject it ("cannot get property \"tools\" without inject").
 */
export const inject = ['tools']

/** Toolkit version (single source of truth: package.json). */
export const PLUGIN_VERSION = TOOLKIT_VERSION

/**
 * Resolve the schemastery package.
 *
 * Under the DSH Loader the bare specifier resolves through the profile /
 * installation package scopes. A `link:` install or a plain `node` run can lose
 * that resolution, so fall back to the copies shipped inside the DSH profile.
 */
async function importSchemastery() {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch (primaryError) {
    const roots = [
      process.env.DSH_PROFILE_DIR,
      process.env.DSH_HOME
        ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')
        : undefined,
      join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop'),
    ].filter(Boolean)
    for (const root of roots) {
      const candidate = join(root, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
      if (!existsSync(candidate)) continue
      try {
        return (await import(pathToFileURL(candidate).href)).default
      } catch {
        // try the next candidate
      }
    }
    throw primaryError
  }
}

let Schema
try {
  Schema = await importSchemastery()
} catch (error) {
  Schema = undefined
  hostLogWarn(
    `[dsh-audio-toolkit] schemastery 不可用，插件仍会加载但插件面板里没有配置表单：${
      error instanceof Error ? error.message : String(error)
    }`,
  )
}

/**
 * The panel form. Fields are **flat**: the DSH settings form model addresses
 * fields by single-segment paths, so nested objects cannot be edited.
 */
function buildConfig() {
  if (!Schema) return undefined
  return Schema.object({
    mcpServerName: Schema.string()
      .default('audio')
      .description('独立 MCP 服务的 serverInfo 名称（原生工具名固定为 audio_toolkit_*）。')
      .volatile(),
    toolCallTimeoutMs: Schema.natural()
      .min(1000)
      .max(3600000)
      .default(900000)
      .description('单次工具调用超时（毫秒）。')
      .volatile(),
    maxConcurrentCalls: Schema.natural()
      .min(1)
      .max(8)
      .default(2)
      .description('同时进行的请求数上限（引擎是常驻服务，通常 1-2 即可）。')
      .volatile(),

    engineEnabled: Schema.boolean()
      .default(true)
      .description('引擎总开关：true=启用/启动，false=停止。这就是面板上的手动启停。')
      .volatile(),
    engineAutoStart: Schema.boolean()
      .default(true)
      .description('DSH 启动时自动拉起引擎（懒加载权重，首次请求才占显存）。')
      .volatile(),
    engineHost: Schema.string().default('127.0.0.1').description('引擎监听地址，保持 127.0.0.1 即可。').volatile(),
    enginePort: Schema.natural().min(1).max(65535).default(8788).description('引擎端口；被占用时改这里。').volatile(),

    binDir: Schema.string()
      .default(DEFAULT_CONFIG.binDir)
      .description('audio.cpp 可执行文件目录。留空 = <仓库>/bin/audio.cpp。')
      .volatile(),
    cliPath: Schema.string()
      .default('')
      .description('audiocpp_cli 路径（仅 audio_status 查设备用）。留空 = <binDir>/audiocpp_cli.exe。')
      .volatile(),
    ffmpegPath: Schema.string()
      .default(DEFAULT_CONFIG.ffmpegPath)
      .description(
        'ffmpeg 可执行文件或所在目录。留空 = <仓库>/bin/ffmpeg/ffmpeg.exe；找不到时回退到 PATH。用来把任意音频转成 16 kHz 单声道 WAV。',
      )
      .volatile(),
    modelsDir: Schema.string().default(DEFAULT_CONFIG.modelsDir).description('模型根目录。').volatile(),
    backend: Schema.union(['cuda', 'cpu', 'vulkan'])
      .default('cuda')
      .description('推理后端：cuda / cpu / vulkan（改后引擎自动重启）。')
      .volatile(),
    device: Schema.natural().default(0).description('后端设备序号。').volatile(),
    threads: Schema.natural().default(0).description('CPU 线程数，0 = 自动。').volatile(),
    extraArgs: Schema.string()
      .default('')
      .description('追加给 audiocpp_server 的启动参数（空格分隔；一般留空，写错会导致引擎起不来）。')
      .volatile(),

    ttsFamily: Schema.string().default('index_tts2').description('TTS 模型家族（--family）。').volatile(),
    ttsModel: Schema.string()
      .default(DEFAULT_CONFIG.ttsModel)
      .description('TTS 模型路径。留空 = <modelsDir>/IndexTTS2.5-GGUF/index-tts2_5-f16.gguf。')
      .volatile(),
    ttsDefaultVoiceRef: Schema.string()
      .default('')
      .description('默认参考音色 wav。IndexTTS2.5 必须给参考音色；留空时调用工具需传 voice_path。')
      .volatile(),
    ttsVoiceDir: Schema.string().default(DEFAULT_CONFIG.ttsVoiceDir).description('参考音色目录。').volatile(),
    ttsLanguage: Schema.union(['auto', 'zh', 'en', 'ja', 'es', 'ar'])
      .default('auto')
      .description('默认语言提示。')
      .volatile(),
    ttsEmotion: Schema.string().default('').description('默认情绪文本（可留空）。').volatile(),
    ttsSessionOptions: Schema.string()
      .default('')
      .description('额外 session option，空格分隔，形如 index_tts2.mem_saver=true。')
      .volatile(),

    asrFamily: Schema.string().default('sense_asr').description('ASR 模型家族（--family）。').volatile(),
    asrModel: Schema.string()
      .default(DEFAULT_CONFIG.asrModel)
      .description('ASR 模型路径。留空 = <modelsDir>/SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf。')
      .volatile(),
    asrVadModel: Schema.string()
      .default(DEFAULT_CONFIG.asrVadModel)
      .description('VAD 模型路径（auto/vad 分块用）。留空 = <modelsDir>/PulseVAD-GGUF/pulsevad-2.1k-f32.gguf。')
      .volatile(),
    asrChunkMode: Schema.union(['auto', 'fixed', 'vad', 'none'])
      .default('fixed')
      .description('长音频分块：fixed 最稳（无需 16k 输入）；auto/vad 需要 VAD 且要求 16k 单声道。')
      .volatile(),
    asrChunkSeconds: Schema.number().min(1).max(600).default(30).description('fixed 分块秒数。').volatile(),
    asrLanguage: Schema.string().default('auto').description('默认识别语言。').volatile(),
    asrEnableItn: Schema.boolean()
      .default(true)
      .description('逆文本规整（数字/标点）；对应工具参数 normalize_text 的默认值。')
      .volatile(),
    asrSessionOptions: Schema.string()
      .default('')
      .description('额外 session option，空格分隔。')
      .volatile(),
    asrMinSegmentMs: Schema.natural()
      .min(50)
      .max(10000)
      .default(300)
      .description('句级时间戳：短于该时长的 VAD 段会被丢弃。')
      .volatile(),
    asrMergeGapMs: Schema.natural()
      .min(0)
      .max(5000)
      .default(400)
      .description('句级时间戳：间隔小于该值的相邻语音段合并成一句。')
      .volatile(),

    outputFolder: Schema.string()
      .default(DEFAULT_CONFIG.outputFolder)
      .description('输出文件夹名（位于当前会话工作目录下，只填名称，默认 audio_toolkit_outputs）。')
      .volatile(),
  }).description('audio.cpp TTS/ASR 工具链（常驻引擎）')
}

/** Exported for the DSH plugin panel form. */
export const Config = buildConfig()

/** Every flat Config key, used to snapshot volatile values. */
const CONFIG_KEYS = [
  'mcpServerName',
  'toolCallTimeoutMs',
  'maxConcurrentCalls',
  'engineEnabled',
  'engineAutoStart',
  'engineHost',
  'enginePort',
  'binDir',
  'cliPath',
  'ffmpegPath',
  'modelsDir',
  'backend',
  'device',
  'threads',
  'extraArgs',
  'ttsFamily',
  'ttsModel',
  'ttsDefaultVoiceRef',
  'ttsVoiceDir',
  'ttsLanguage',
  'ttsEmotion',
  'ttsSessionOptions',
  'asrFamily',
  'asrModel',
  'asrVadModel',
  'asrChunkMode',
  'asrChunkSeconds',
  'asrLanguage',
  'asrEnableItn',
  'asrSessionOptions',
  'asrMinSegmentMs',
  'asrMergeGapMs',
  'outputFolder',
]

/**
 * Read the current plain values out of a possibly-volatile config object.
 * @param {Record<string, any>} config
 */
function snapshotRaw(config) {
  const raw = {}
  for (const key of CONFIG_KEYS) raw[key] = readValue(config?.[key], undefined)
  return raw
}

/** Publish the resolved config and return it. */
function publish(config, engineStatus) {
  const resolved = resolveConfig(config)
  try {
    writeStateConfig(
      resolved,
      {
        engine: {
          enabled: resolved.engine.enabled,
          autoStart: resolved.engine.autoStart,
          url: resolved.engine.url,
          ...(engineStatus ?? {}),
        },
      },
      // Flat values let the standalone MCP server re-resolve the output folder
      // against its own working directory.
      snapshotRaw(config),
    )
  } catch (error) {
    hostLogWarn(
      `[dsh-audio-toolkit] 无法写入 ${STATE_CONFIG_PATH}：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return resolved
}

/**
 * The session working directory a tool call runs in.
 *
 * DSH records each session's directory in its header and exposes it through the
 * `workingDirectory` service; the output folder must land beside the files the
 * agent can see, so try the session header first, then the service, then the
 * deployment default, then the host process directory.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent?: {session?: any}}} [exec]
 * @returns {string}
 */
function workspaceOf(ctx, exec) {
  const session = exec?.agent?.session
  // The service tracks the *current* directory (it follows a `cd`), while
  // `session.header.cwd` is only where the session started — so the service wins
  // and the header is the fallback.
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service?.get && session) {
      const directory = service.get(session)
      if (typeof directory === 'string' && directory) return directory
    }
    if (typeof service?.defaultDirectory === 'string' && service.defaultDirectory) return service.defaultDirectory
  } catch {
    /* fall through */
  }
  const fromHeader = session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  return process.cwd()
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} config
 */
export function apply(ctx, config) {
  try {
    const resolved = publish(config)
    hostLog(`[dsh-audio-toolkit] v${PLUGIN_VERSION} 配置：${summarize(resolved)}`)

    const log = hostLog
    // The manager is constructed once, so it reads the config through a factory:
    // a volatile panel edit must reach start()/restart() without a plugin reload.
    const engineConfig = () => resolveConfig(snapshotRaw(config))
    const engine = new AudioEngine({ getConfig: engineConfig, log })

    // Re-resolve on every call so a panel edit applies without a remount, and
    // resolve the output folder against the *session's* working directory.
    const currentConfig = (exec) => resolveConfig(snapshotRaw(config), { baseDir: workspaceOf(ctx, exec) })

    // Async jobs: one queue per plugin instance, so the agent can submit several
    // tasks and poll later. Finished jobs survive a reload through the snapshot.
    let jobs
    try {
      jobs = new JobQueue({
        limit: resolved.mcp.maxConcurrentCalls,
        persistPath: join(STATE_DIR, 'jobs.json'),
        execute: (kind, params, cfg, signal) => {
          const raw = kind === 'tts' ? 'tts_speak' : 'asr_transcribe'
          const tool = findTool(raw)
          if (!tool) throw new Error(`未知任务类型：${kind}`)
          return tool.handler(params, cfg, { signal, version: PLUGIN_VERSION, configSource: 'job', jobs })
        },
      })
      try {
        ctx.effect(() => () => jobs.dispose(), 'audio-toolkit: job queue')
      } catch {
        /* effect registration is optional; dispose also runs on process exit */
      }
    } catch (error) {
      hostLogWarn(
        `[dsh-audio-toolkit] 任务队列不可用（异步提交将不可用）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // Native tools use the exact requested names; MCP cannot, because the bridge
    // always prefixes `mcp__<server>__`. The plugin injects `tools`, so the service
    // is present by the time apply runs.
    try {
      const names = registerHostTools(ctx, currentConfig, { jobs })
      log(`已注册工具：${names.join(', ')}`)
    } catch (error) {
      hostLogWarn(
        `[dsh-audio-toolkit] 注册 audio_toolkit_* 工具失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // Kill the engine whenever this plugin instance is disposed (HMR reload,
    // bundle disable, DSH exit). This is the "follow DSH lifecycle" guarantee.
    // Returning the promise lets the Loader wait for the socket to close before a
    // replacement instance starts on the same port.
    try {
      const dispose = () => () => engine.stop()
      try {
        ctx.effect(dispose, 'audio-toolkit: engine lifecycle')
      } catch {
        // Some Loader builds reject the label argument.
        ctx.effect(dispose)
      }
    } catch (error) {
      hostLogWarn(`[dsh-audio-toolkit] 无法注册引擎生命周期：${error instanceof Error ? error.message : String(error)}`)
    }

    if (resolved.engine.enabled && resolved.engine.autoStart) {
      // Do not block plugin activation: the server is lazy, and tool calls that
      // arrive early retry briefly before reporting "not started".
      engine
        .start()
        .then((result) => {
          if (result.error) {
            hostLogWarn(`[dsh-audio-toolkit] 引擎未能启动：${result.error}`)
            return
          }
          hostLog(
            result.reused
              ? `[dsh-audio-toolkit] 复用已在运行的引擎：${resolved.engine.url}`
              : `[dsh-audio-toolkit] 引擎已启动：${resolved.engine.url}`,
          )
        })
        .catch((error) => {
          hostLogWarn(
            `[dsh-audio-toolkit] 引擎启动异常：${error instanceof Error ? error.message : String(error)}`,
          )
        })
    } else {
      hostLog(
        `[dsh-audio-toolkit] 引擎未自动启动（engineEnabled=${resolved.engine.enabled}, engineAutoStart=${resolved.engine.autoStart}）`,
      )
    }

    let previousRaw = snapshotRaw(config)
    let previousResolved = resolved

    // A volatile panel edit does not remount the plugin: react to it here.
    try {
      ctx.on('loader/volatile-update', () => {
        try {
          const nextRaw = snapshotRaw(config)
          const next = resolveConfig(nextRaw)
          const enabledChanged = previousResolved.engine.enabled !== next.engine.enabled
          const restartNeeded = engineSettingsChanged(previousRaw, nextRaw)
          previousRaw = nextRaw
          previousResolved = next

          if (enabledChanged) {
            if (next.engine.enabled) {
              log('面板：启动引擎')
              void engine.start().catch(() => {})
            } else {
              log('面板：停止引擎')
              void engine.stop().catch(() => {})
            }
          } else if (restartNeeded && next.engine.enabled && engine.running) {
            log('面板：引擎相关配置变化，正在重启引擎')
            engine
              .restart()
              .then(() => log('引擎重启完成'))
              .catch(() => {})
          }
          publish(config)
        } catch (error) {
          hostLogWarn(
            `[dsh-audio-toolkit] 处理配置更新失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    } catch {
      // Older Loader builds do not emit the event; a reload still calls apply().
    }
  } catch (error) {
    hostLogWarn(
      `[dsh-audio-toolkit] 启动自检异常（已忽略）：${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    )
  }
}
