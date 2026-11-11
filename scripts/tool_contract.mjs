#!/usr/bin/env node
/**
 * Render the **tool contract** section of README.md from the code.
 *
 * The model-facing surface — DSH tool names, parameters, required flags, enums
 * and descriptions — is read from `mcp/tools.mjs` and `src/host-tools.js`, so the
 * documentation cannot drift from what the model actually sees. The few facts a
 * JSON Schema cannot express (return fields, failure modes) live in `CONTRACT`
 * below; a tool added or renamed without an entry fails the check instead of
 * silently documenting the wrong thing.
 *
 * Usage:
 *   node scripts/tool_contract.mjs           # print the block
 *   node scripts/tool_contract.mjs --write   # rewrite README between the markers
 *   node scripts/tool_contract.mjs --check   # exit 1 when README is stale
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../mcp/tools.mjs'
import { TOOL_NAMES } from '../src/host-tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const README_PATH = join(PACKAGE_ROOT, 'docs', 'GUIDE.zh.md')

const BEGIN = '<!-- BEGIN GENERATED:tool-contract -->'
const END = '<!-- END GENERATED:tool-contract -->'

/**
 * Documentation-only contract facts, keyed by raw tool name.
 * `returns` entries are `[field, meaning]`; `errors` are the failure modes a
 * caller should expect to handle.
 */
const CONTRACT = {
  tts_speak: {
    purpose: '文本→wav；支持情绪、语速、固定种子',
    returns: [['audio_path', '生成的 wav 绝对路径（唯一字段，其余都是回显或诊断信息）']],
    errors: [
      '`text` 为空，或超过单次 2000 字符上限',
      '参考音色缺失（参数没给、部署也没有默认值），或文件不存在',
      '参考音频无法被 ffmpeg 解码 / ffmpeg 不可用（转码失败时给出原因）',
      '引擎未运行 / 配置为禁用（提示里给出启动办法）',
      '`audiocpp_server` 或 TTS 模型文件缺失',
    ],
  },
  asr_transcribe: {
    purpose: '音频→文本；默认只给路径，可选句级时间轴',
    returns: [
      ['text_path', '转写文本路径；`save_to_file: false` 时为 null'],
      ['text', '仅 `save_to_file: false` 或 `return_text: true` 时返回'],
      ['segments_path', '仅 `timestamps: true` 时返回'],
      ['segments', '仅 `timestamps: true` 且附带正文时返回，每项 `index` / `start_ms` / `end_ms` / `duration_ms` / `text`'],
    ],
    extra: [
      '默认只返回路径。`timestamps: true` 时 `segments_path` 指向 `.segments.json`（含 `fallback` 标记：`true` 表示 VAD 没检出语音、整段回退）。',
    ],
    errors: [
      '找不到音频文件，或路径指向目录',
      '输入音频无法被 ffmpeg 解码（或 ffmpeg 未安装 / 路径不对），转码失败',
      'VAD 模型未配置或文件缺失',
      '引擎未运行 / 配置为禁用；ASR 模型文件缺失',
    ],
  },
  tts_list_voices: {
    purpose: '列出可用的参考音色 wav',
    returns: [
      ['voice_dir', '实际扫描的目录'],
      ['default_voice_path', '部署配置的默认音色；没有时为 null'],
      ['voices', '每项含 `name` 与 `path`（直接作为 `voice_path` 使用）'],
    ],
    errors: ['目录不存在或为空时不报错，返回空的 `voices`'],
  },
  audio_status: {
    purpose: '引擎、模型、GPU 与配置的自检',
    returns: [
      ['toolkit_version', '工具箱版本'],
      ['config_source', '配置来源：插件发布的状态文件，或环境变量覆盖'],
      ['engine', '`url` / `enabled` / `running` / `health`（status/backend/version）/ `models[]`（id/loaded）/ `log`'],
      ['install_ok', '必需文件是否齐全；看 checks 定位缺哪个'],
      ['checks', '每项 `label` / `ok`；只有失败的项才带 `path`'],
      ['audio_cpp', '`backend` / `device` / `ffmpeg`（实际会执行的 ffmpeg，未找到为 null）'],
      ['tts', '`family` / `model` / `default_voice_path` / `voices`（数量）'],
      ['asr', '`family` / `model` / `vad_model` / `chunk_mode`'],
      ['output', '`dir` / `files`'],
      ['jobs', '各状态计数 + `limit`；当前入口没有队列时为 null'],
      ['gpu', '每项 `name` / `free_bytes` / `total_bytes`；枚举失败时是带 error 的对象'],
    ],
    errors: ['只读诊断，不报错；异常体现在 `checks` / `install_ok` / `gpu` 里'],
  },
  submit_tasks: {
    purpose: '异步批量提交，立即返回 job_id',
    returns: [
      ['submitted', '已受理任务，每项 `job_id` / `kind` / `status`'],
      ['rejected', '被拒任务，每项含 kind / reason；非法条目不会拖垮整批'],
      ['queue', '`queued` / `running` / `done` / `error` / `cancelled`'],
    ],
    errors: ['`tasks` 为空或超过 20 个', '当前入口没有任务队列（独立 MCP 服务与宿主插件都有，其它调用方式可能没有）'],
  },
  job_status: {
    purpose: '按 job_id 查进度与结果',
    returns: [
      ['jobs', '每项 `job_id` / `kind` / `status`，以及 `error` 或 `result`（即对应工具的返回）'],
      ['all_settled', '全部结束**且**请求的 id 都存在'],
      ['missing', '请求了但查不到的 job_id；仅在不带 status 过滤时出现'],
      ['summary', '`queued` / `running` / `done` / `error` / `cancelled`'],
    ],
    errors: ['当前入口没有任务队列'],
  },
  cancel_jobs: {
    purpose: '取消排队或运行中的任务',
    returns: [
      ['cancelled', '已取消的 job_id'],
      ['skipped', '未改动的任务，每项含 job_id 与 reason，reason 为 not-found / already-done 等'],
    ],
    errors: ['`job_ids` 为空', '当前入口没有任务队列'],
  },
}
/** Escape one Markdown table cell. */
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Render a JSON Schema node as a short type label. */
function typeLabel(schema) {
  if (schema.enum) return `${schema.type}（${schema.enum.map((value) => `\`${value}\``).join(' / ')}）`
  if (schema.type === 'array') return schema.items?.type === 'object' ? 'array&lt;object&gt;' : 'array'
  return schema.type ?? 'any'
}

/** The generated Markdown, markers included. */
export function renderContract() {
  const lines = []

  for (const tool of TOOLS) {
    if (!TOOL_NAMES[tool.name]) throw new Error(`TOOL_NAMES is missing ${tool.name}`)
    if (!CONTRACT[tool.name]) throw new Error(`CONTRACT is missing ${tool.name}; document the tool before shipping it`)
  }

  lines.push('### 工具总表', '')
  lines.push('| DSH 工具（`audio_toolkit_*`） | MCP 原始名 | 作用 |', '|---|---|---|')
  for (const tool of TOOLS) {
    lines.push(`| \`${TOOL_NAMES[tool.name]}\` | \`${tool.name}\` | ${cell(CONTRACT[tool.name].purpose)} |`)
  }
  lines.push('')
  lines.push('### 参数与返回', '')

  for (const tool of TOOLS) {
    const contract = CONTRACT[tool.name]
    const schema = tool.inputSchema
    const required = new Set(schema.required ?? [])
    lines.push(`#### \`${TOOL_NAMES[tool.name]}\` ／ MCP \`${tool.name}\``, '')
    lines.push(tool.description, '')

    const properties = Object.entries(schema.properties ?? {})
    if (properties.length === 0) {
      lines.push('无参数。', '')
    } else {
      lines.push('| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|')
      for (const [name, property] of properties) {
        lines.push(
          `| \`${name}\` | ${cell(typeLabel(property))} | ${required.has(name) ? '是' : '否'} | ${cell(property.description ?? '')} |`,
        )
      }
      lines.push('')
      const items = schema.properties?.tasks?.items
      if (items?.properties) {
        const itemRequired = new Set(items.required ?? [])
        const fields = Object.entries(items.properties)
          .map(([name, property]) => `\`${name}\`${itemRequired.has(name) ? '（必填）' : ''}：${property.description ?? ''}`)
          .join('；')
        const otherFields =
          items.additionalProperties === true
            ? '；其余字段同对应工具的参数，也可以整体放进 `params` 对象'
            : ''
        lines.push(`**\`tasks[]\` 元素**：${fields}${otherFields}。`, '')
      }
    }

    lines.push(
      `**返回**：${contract.returns.map(([field, meaning]) => `\`${field}\`（${meaning}）`).join('、')}。`,
    )
    if (contract.extra) lines.push('', ...contract.extra)
    lines.push('', `**失败**：${contract.errors.join('；')}。`, '')
  }

  return [BEGIN, ...lines, END].join('\n')
}

/** Replace the generated block in `text`; requires the markers to exist. */
export function splice(text) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`README.md must contain ${BEGIN} … ${END}`)
  }
  return `${text.slice(0, begin)}${renderContract()}${text.slice(end + END.length)}`
}

function main() {
  const args = process.argv.slice(2)
  const block = renderContract()
  if (args.includes('--write')) {
    const text = readFileSync(README_PATH, 'utf8')
    writeFileSync(README_PATH, splice(text), 'utf8')
    console.log(`updated ${README_PATH}`)
    return
  }
  if (args.includes('--check')) {
    const text = readFileSync(README_PATH, 'utf8')
    const begin = text.indexOf(BEGIN)
    const end = text.indexOf(END)
    const current = begin < 0 || end < 0 ? '' : text.slice(begin, end + END.length)
    if (current !== block) {
      console.error('README.md tool contract is stale; run: node scripts/tool_contract.mjs --write')
      process.exitCode = 1
      return
    }
    console.log('tool contract is in sync with the code')
    return
  }
  console.log(block)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
