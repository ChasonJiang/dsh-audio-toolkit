/**
 * Resident audio.cpp engine manager (host half).
 *
 * One `audiocpp_server` process serves every TTS/ASR call, so a request costs
 * inference time instead of a model load. Its lifecycle follows the DSH plugin:
 *
 *   apply()            → start (when enabled + autoStart)
 *   ctx.effect(dispose)→ stop   (plugin reload, DSH exit, profile unload)
 *   panel toggle       → start/stop through `engineEnabled`
 *   config change      → restart when the engine-relevant settings changed
 *
 * The server itself runs with `lazy_load` + `max_loaded_models: 0`, so startup is
 * quick; the first request per model pays the weight load.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { ensureAssets } from '../mcp/assets.mjs'
import { writeEngineConfig } from './config.js'

/** How long to wait for `/health` before calling a start failed. */
const READY_TIMEOUT_MS = 90_000

/** How long to wait for a graceful process exit before killing it. */
const STOP_TIMEOUT_MS = 10_000

/**
 * Rotate `engine.log` past this size (one previous file is kept).
 *
 * The server's `--log` has no level switch and emits per-request TRACE/TIMING
 * lines, so an unbounded file grows by megabytes per session.
 */
const LOG_ROTATE_BYTES = 8 * 1024 * 1024

/** Rename an oversized engine log to `<path>.1` (best effort). */
function rotateLog(path) {
  try {
    if (statSync(path).size <= LOG_ROTATE_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    /* no log yet, or another instance owns it */
  }
}

/**
 * Engines with a possible live child process.
 *
 * A DSH exit may happen while `start()` is still waiting for `/health`; the
 * async `ctx.effect` disposer then does not get to run and the child survives,
 * holding the port for the next launch (which then "reuses" a half-dead engine).
 * The synchronous `exit` hook kills it.
 */
const liveEngines = new Set()
let exitHookInstalled = false

/** Track one engine for the process exit hook. */
function trackEngine(engine) {
  liveEngines.add(engine)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const item of liveEngines) {
      const child = item.child
      if (!child || child.exitCode !== null) continue
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  })
}

/** Keys whose change requires restarting the engine. */
const RESTART_KEYS = [
  'engineHost',
  'assetsDir',
  'enginePort',
  'engineIdleUnloadSeconds',
  'engineMaxLoadedModels',
  'backend',
  'device',
  'threads',
  'binDir',
  'extraArgs',
  'ttsFamily',
  'ttsModel',
  'ttsSessionOptions',
  'asrFamily',
  'asrModel',
  'asrVadModel',
  'asrChunkMode',
  'asrChunkSeconds',
  'asrSessionOptions',
]

/**
 * GET a URL and resolve to the parsed JSON body, or undefined on failure.
 *
 * This is used by engine start/stop/restart, so it must settle in **every** case:
 * a socket that is closed mid-response, a peer that trickles bytes forever, and
 * an already-rejected request all resolve `undefined` instead of leaving the
 * lifecycle await pending (`engine.start()` would otherwise hang before its own
 * readiness deadline could fire).
 */
export function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    const budget = Math.max(1, Number(timeoutMs) || 1)
    let settled = false
    let req
    let timer
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    // A hard overall deadline, not just an idle-socket timeout: `timeout` only
    // fires when the socket is quiet, so a peer sending a byte per second could
    // keep a health check alive indefinitely.
    timer = setTimeout(() => {
      try {
        req?.destroy()
      } catch {
        /* already gone */
      }
      done(undefined)
    }, budget)
    timer.unref?.()

    try {
      req = request(url, { method: 'GET', timeout: budget }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return done(undefined)
          try {
            done(JSON.parse(body))
          } catch {
            done(undefined)
          }
        })
        // An incomplete response never emits `end`; without these handlers the
        // promise above would stay pending forever.
        res.on('error', () => done(undefined))
        res.on('aborted', () => done(undefined))
        res.on('close', () => {
          if (!res.complete) done(undefined)
        })
      })
    } catch {
      done(undefined)
      return
    }
    req.on('timeout', () => {
      try {
        req.destroy()
      } catch {
        /* already gone */
      }
      done(undefined)
    })
    req.on('error', () => done(undefined))
    req.on('close', () => {
      // The request closed before a response arrived (connection refused/reset).
      if (!req.res || !req.res.complete) done(undefined)
    })
    req.end()
  })
}

/** @param {Record<string, any>} config */
export class AudioEngine {
  /**
   * @param {{config?: Record<string, any>, getConfig?: () => Record<string, any>, log: (message: string) => void}} options
   *   Pass `getConfig` to follow panel edits: the plugin mounts the engine once,
   *   so a factory is the only way `start()`/`restart()` can pick up a new port,
   *   binary directory or model path without a plugin reload.
   */
  constructor({ config, getConfig, log }) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => config
    this.log = log
    this.child = undefined
    this.startedAt = 0
    this.lastError = ''
    /**
     * Tail of the lifecycle chain. Engine boot, a panel start, a config-driven
     * restart and plugin disposal can arrive in the same tick (especially on the
     * first launch); running them concurrently used to spawn two servers on the
     * same port and orphan one of them.
     */
    this.lifecycle = Promise.resolve()
    trackEngine(this)
  }

  /**
   * Run one lifecycle operation after the previous one settled.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  runExclusive(operation) {
    const next = this.lifecycle.then(operation, operation)
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Effective config, re-read on every access so panel edits apply live. */
  get config() {
    return this.getConfig()
  }

  /** Engine base URL. */
  get url() {
    return this.config.engine.url
  }

  /** Whether this manager currently owns a live child process. */
  get running() {
    return this.child !== undefined && this.child.exitCode === null
  }

  /**
   * Ask `/health`; works even if the process was started by another instance.
   * @param {string} [url] override (a starting engine pins the URL it spawned for)
   */
  async reachable(url = this.url) {
    const health = await httpGetJson(`${url}/health`)
    return health !== undefined
  }

  /**
   * Start the engine if it is not already reachable.
   * @param {{force?: boolean}} [options] `force` starts even when the panel flag
   *   says disabled (boot auto-start and the explicit start button).
   * @returns {Promise<{started: boolean, reused: boolean, error?: string}>}
   */
  start(options = {}) {
    return this.runExclusive(() => this.startEngine(options))
  }

  /**
   * Implementation of `start()`; always runs inside the lifecycle chain.
   * @param {{force?: boolean}} [options]
   */
  async startEngine({ force = false } = {}) {
    // Re-register in case a previous stop removed this engine from the hook set.
    trackEngine(this)
    // Snapshot once: a panel edit arriving mid-start must not mix two configs
    // (for example the old port with the new binary path).
    const config = this.config
    const url = config.engine.url
    if (!config.engine.enabled && !force) {
      return { started: false, reused: false, error: '引擎已在配置中禁用（engineEnabled=false）' }
    }
    if (this.running) {
      return { started: false, reused: true }
    }
    // A previous instance may still be shutting down and would answer `/health`
    // for a moment; wait for the port to be free so we never "reuse" a process
    // that is about to disappear.
    if (!(await this.waitForPortFree(6000, url))) {
      const health = await httpGetJson(`${url}/health`)
      if (health !== undefined) {
        this.log(`端口 ${config.engine.port} 上已有引擎在运行，直接复用：${url}`)
        return { started: false, reused: true }
      }
      this.lastError = `端口 ${config.engine.port} 在 6s 内没有释放`
      this.log(this.lastError)
      return { started: false, reused: false, error: this.lastError }
    }

    // A git/npm install ships no binaries or models; provision them into the
    // resolved asset root on first start unless the user turned that off or
    // pointed binDir/modelsDir somewhere explicit (then the exact path in the
    // error below is more useful than a download attempt).
    if (config.assets.derived) {
      try {
        await ensureAssets(config, { log: (message) => this.log(message), backend: config.audioCpp.backend })
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.log(this.lastError)
        return { started: false, reused: false, error: this.lastError }
      }
    }

    const exePath = config.engine.exePath
    if (!existsSync(exePath)) {
      this.lastError = `找不到 audiocpp_server：${exePath}`
      this.log(this.lastError)
      return { started: false, reused: false, error: this.lastError }
    }

    const configPath = writeEngineConfig(config, config.engine.configPath)
    mkdirSync(dirname(config.engine.logPath), { recursive: true })
    mkdirSync(config.output.tmp, { recursive: true })
    rotateLog(config.engine.logPath)
    const logStream = createWriteStream(config.engine.logPath, { flags: 'a' })
    // `pipe()` ends the destination when the child's stdout closes, while the
    // exit handler below may still want to append a footer. Writing after `end`
    // raises an unhandled stream error (and can crash the host), so every write
    // goes through a guard and the disk-full error is swallowed.
    logStream.on('error', () => {})
    const writeLog = (text) => {
      try {
        if (!logStream.writableEnded && !logStream.destroyed) logStream.write(text)
      } catch {
        /* logging must never take the host down */
      }
    }
    const endLog = () => {
      try {
        if (!logStream.writableEnded && !logStream.destroyed) logStream.end()
      } catch {
        /* already closed by the pipe */
      }
    }
    const stamp = new Date().toISOString()
    writeLog(`\n=== ${stamp} start ${exePath} --config ${configPath} ===\n`)

    const env = {
      ...process.env,
      // audio.cpp stages embedded GGUF specs under TEMP.
      TEMP: config.output.tmp,
      TMP: config.output.tmp,
      TMPDIR: config.output.tmp,
    }
    // Panel-provided arguments come last, so they can override a default flag.
    const args = [
      '--config',
      configPath,
      '--no-ui',
      '--log',
      '--log-file',
      config.engine.logPath,
      ...config.audioCpp.extraArgs,
    ]

    let child
    try {
      child = spawn(exePath, args, {
        cwd: config.audioCpp.binDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.lastError = `启动 audiocpp_server 失败：${error.message}`
      endLog()
      this.log(this.lastError)
      return { started: false, reused: false, error: this.lastError }
    }

    // Both streams share one file; `end: false` keeps whichever closes first from
    // ending the destination while the other still has buffered output. The log
    // is closed on `close` (after both stdio streams are done), not on `exit`.
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    child.on('close', () => endLog())
    let spawnError
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`
      writeLog(`=== engine exited (${reason}) ===\n`)
      if (this.child === child) this.child = undefined
      this.log(`audio.cpp 引擎已退出（${reason}）`)
    })
    child.on('error', (error) => {
      // A failed exec (EACCES, ENOENT, ...) never sets `exitCode`, so the wait
      // below needs this flag or it would poll for the full readiness timeout.
      spawnError = error
      this.lastError = `引擎进程错误：${error.message}`
      this.log(this.lastError)
      endLog()
    })

    this.child = child
    this.startedAt = Date.now()
    this.lastError = ''

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        return { started: false, reused: false, error: this.lastError }
      }
      if (child.exitCode !== null) {
        this.lastError = `引擎启动即退出（code ${child.exitCode}），看 ${config.engine.logPath}`
        this.log(this.lastError)
        return { started: false, reused: false, error: this.lastError }
      }
      if (await this.reachable(url)) {
        this.log(`audio.cpp 引擎已就绪：${url}（pid ${child.pid}）`)
        return { started: true, reused: false }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.lastError = `引擎在 ${READY_TIMEOUT_MS / 1000}s 内没有响应 /health`
    this.log(this.lastError)
    await this.stopEngine()
    return { started: false, reused: false, error: this.lastError }
  }

  /**
   * Wait until `/health` stops answering (port released).
   * @param {number} timeoutMs
   * @param {string} [url] the URL whose port must free up
   */
  async waitForPortFree(timeoutMs, url = this.url) {
    const deadline = Date.now() + timeoutMs
    while (await this.reachable(url)) {
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 200))
    }
    return true
  }

  /** Stop the engine we own (serialized behind any in-flight start/restart). */
  stop() {
    return this.runExclusive(() => this.stopEngine())
  }

  /** Implementation of `stop()`; always runs inside the lifecycle chain. */
  async stopEngine() {
    const child = this.child
    if (!child) {
      // Another instance (or a previous run) may still hold the port.
      if (await this.reachable()) {
        this.log('引擎可达但不属于本实例，无法停止（由其他进程持有该端口）')
        liveEngines.delete(this)
        return { stopped: false, reason: 'not-owned' }
      }
      liveEngines.delete(this)
      return { stopped: false, reason: 'not-running' }
    }
    this.child = undefined
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    const exited = await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise(true)
      const timer = setTimeout(() => resolvePromise(false), STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise(true)
      })
    })
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    // Let the listening socket close before a restart tries to bind it.
    await this.waitForPortFree(5000)
    liveEngines.delete(this)
    this.log('audio.cpp 引擎已停止')
    return { stopped: true }
  }

  /** Restart with the current config. */
  restart() {
    return this.runExclusive(async () => {
      await this.stopEngine()
      // Give the port a moment to be released.
      await new Promise((r) => setTimeout(r, 300))
      return this.startEngine()
    })
  }
}

/** True when two raw configs differ in any engine-relevant key. */
export function engineSettingsChanged(previous, next) {
  for (const key of RESTART_KEYS) {
    const a = previous?.[key]
    const b = next?.[key]
    if (typeof a === 'object' || typeof b === 'object') {
      if (JSON.stringify(a) !== JSON.stringify(b)) return true
      continue
    }
    if (String(a ?? '') !== String(b ?? '')) return true
  }
  return false
}
