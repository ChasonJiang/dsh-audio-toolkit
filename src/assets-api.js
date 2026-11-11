/**
 * Local HTTP API for runtime-asset management.
 *
 * The panel has no RPC channel — it can only read/write plugin config — so the
 * host exposes a tiny loopback server instead: status, install, cancel. The
 * client queries it directly, which gives live progress without inventing a
 * config field for every byte.
 *
 * Security: bound to 127.0.0.1, mutating calls require a localhost `Origin`
 * (a web page cannot forge it), and the body is size-limited.
 */

import { createServer } from 'node:http'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { assetsReady, cancelInstall, installSnapshot, missingAssets, startInstall } from '../mcp/assets.mjs'
import { TOOLKIT_VERSION } from './config.js'

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
const MAX_BODY = 64 * 1024

/** Directory size, cached briefly: it walks the 5 GB model tree. */
const sizeCache = new Map()

function dirSize(dir) {
  const hit = sizeCache.get(dir)
  if (hit && Date.now() - hit.at < 60_000) return hit.size
  let total = 0
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        try {
          total += statSync(child).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  sizeCache.set(dir, { at: Date.now(), size: total })
  return total
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectPromise(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * @param {{getConfig: () => ReturnType<typeof import('./config.js').resolveConfig>, log?: (message: string) => void}} options
 */
export function createAssetsApi({ getConfig, log = () => {} }) {
  const server = createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? '')
    const sameOrigin = !origin || LOOPBACK_ORIGIN.test(origin)
    const cors = {
      'access-control-allow-origin': origin && LOOPBACK_ORIGIN.test(origin) ? origin : '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    }
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...cors })
      res.end(`${JSON.stringify(payload)}\n`)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const config = getConfig()
        const missing = missingAssets(config)
        const install = installSnapshot()
        send(200, {
          toolkit: TOOLKIT_VERSION,
          platform: process.platform,
          root: config.assets.root,
          ready: missing.length === 0,
          missing,
          auto_download: config.assets.autoDownload,
          proxy: config.assets.proxy || '',
          sizes: {
            release: dirSize(config.audioCpp.binDir),
            models: dirSize(config.audioCpp.modelsDir),
          },
          install,
        })
        return
      }

      // Mutating calls: only the local DSH UI may drive them.
      if (req.method === 'POST' && (url.pathname === '/install' || url.pathname === '/cancel')) {
        if (!sameOrigin) {
          send(403, { error: 'forbidden origin' })
          return
        }
        if (url.pathname === '/cancel') {
          send(200, { cancelled: cancelInstall() })
          return
        }
        const body = await readBody(req)
        let options = {}
        try {
          options = body ? JSON.parse(body) : {}
        } catch {
          send(400, { error: 'invalid json' })
          return
        }
        const config = getConfig()
        const result = startInstall(config, {
          proxy: typeof options.proxy === 'string' ? options.proxy : undefined,
          platform: typeof options.platform === 'string' && options.platform ? options.platform : undefined,
          backend: typeof options.backend === 'string' && options.backend ? options.backend : undefined,
          log: (line) => log(line),
        })
        if (result.started) log('[assets] 面板请求安装运行时依赖')
        send(202, result)
        return
      }

      send(404, { error: 'not found' })
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  let port = 0
  return {
    get port() {
      return port
    },
    /** Bind the configured port, walking forward if it is taken. */
    async start(preferred) {
      const base = Number(preferred) > 0 ? Number(preferred) : 8789
      for (let offset = 0; offset < 6; offset += 1) {
        const candidate = base + offset
        const ok = await new Promise((resolvePromise) => {
          const onError = () => {
            server.removeListener('listening', onListening)
            resolvePromise(false)
          }
          const onListening = () => {
            server.removeListener('error', onError)
            resolvePromise(true)
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(candidate, '127.0.0.1')
        })
        if (ok) {
          // Never keep the process alive on its own (tests, headless runs).
          server.unref()
          port = candidate
          log(`[assets] 依赖服务已启动：http://127.0.0.1:${port}`)
          return port
        }
      }
      log('[assets] 依赖服务无法绑定端口，面板里的依赖管理将不可用')
      return 0
    },
    async close() {
      // A plugin reload must not leave the download worker orphaned.
      cancelInstall()
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    },
  }
}
