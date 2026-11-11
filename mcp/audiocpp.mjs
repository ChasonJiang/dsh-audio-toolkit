/**
 * One-off audio.cpp CLI runner.
 *
 * Only `audio_status` needs it, for `--list-devices` (the resident server does
 * not expose the device inventory). Inference never goes through here: those
 * calls go to the long-lived engine over HTTP.
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { isFile } from '../src/config.js'

/** Error carrying the CLI context needed for a useful tool message. */
export class AudioCppError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AudioCppError'
    this.details = details
  }
}

/** Keep the tail of a long log so tool errors stay readable. */
function tail(text, maxChars = 3000) {
  const trimmed = (text || '').trim()
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(trimmed.length - maxChars)}`
}

/**
 * Run one audio.cpp CLI invocation.
 * @param {object} options
 * @param {string} options.cliPath absolute path of audiocpp_cli(.exe)
 * @param {string} options.cwd working directory (normally the bin dir)
 * @param {string[]} options.args
 * @param {number} options.timeoutMs
 * @param {string} [options.scratchDir] workspace scratch dir exported as TEMP/TMP
 * @param {string} [options.label] program name used in error messages
 * @returns {Promise<{stdout: string, stderr: string, code: number, wallMs: number}>}
 */
export function runCli({ cliPath, cwd, args, timeoutMs, scratchDir, label = 'audio.cpp' }) {
  if (!isFile(cliPath)) {
    throw new AudioCppError(`找不到 ${label}：${cliPath}`, { cliPath, args, reason: 'ENOENT' })
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now()
    const env = { ...process.env }
    env.PATH = `${cwd};${env.PATH ?? ''}`
    env.Path = `${cwd};${env.Path ?? ''}`
    if (scratchDir) {
      try {
        mkdirSync(scratchDir, { recursive: true })
      } catch {
        /* fall back to the inherited temp dir */
      }
      env.TEMP = scratchDir
      env.TMP = scratchDir
      env.TMPDIR = scratchDir
    }

    let child
    try {
      child = spawn(cliPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      rejectPromise(new AudioCppError(`无法启动 ${label}：${error.message}`, { cliPath, args }))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(rejectPromise, new AudioCppError(`${label} 调用超时（${Math.round(timeoutMs / 1000)}s）`, { args }))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(rejectPromise, new AudioCppError(`${label} 进程错误：${error.message}`, { cliPath, args }))
    })
    child.on('close', (code) => {
      const result = { stdout, stderr, code: code ?? -1, wallMs: Date.now() - startedAt }
      if (result.code !== 0) {
        finish(rejectPromise, new AudioCppError(`${label} 退出码 ${result.code}：${tail(`${stdout}\n${stderr}`)}`, { args }))
        return
      }
      finish(resolvePromise, result)
    })
  })
}
