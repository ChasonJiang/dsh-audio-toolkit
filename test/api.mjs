#!/usr/bin/env node
/**
 * Tests for the loopback assets API (the channel the panel uses).
 *
 * Covers the origin gate (the DSH desktop renderer is `dsh-app://app`, not
 * localhost) and the guards. No download is triggered.
 *
 * Usage: node test/api.mjs
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { createAssetsApi } from '../src/assets-api.js'
import { resolveConfig } from '../src/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '..', 'state', 'tmp', 'api-test')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const config = resolveConfig({ assetsDir: join(SCRATCH, 'assets'), assetsAutoDownload: false })
  const api = createAssetsApi({ getConfig: () => config })
  const port = await api.start(19000 + Math.floor(Math.random() * 500))
  const base = `http://127.0.0.1:${port}`
  try {
    const status = await fetch(`${base}/status`)
    const body = await status.json()
    check('status responds', status.status === 200 && body.ready === false, `${body.missing?.length} missing`)
    check('status reports the asset root', typeof body.root === 'string' && body.root.length > 0, body.root)

    const options = await fetch(`${base}/install`, { method: 'OPTIONS', headers: { origin: 'dsh-app://app' } })
    check(
      'preflight allows the desktop renderer',
      options.status === 204 && options.headers.get('access-control-allow-origin') === 'dsh-app://app',
      `${options.status} ${options.headers.get('access-control-allow-origin')}`,
    )

    const desktopCancel = await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
      body: '{}',
    })
    check('desktop origin may cancel', desktopCancel.status === 200, String(desktopCancel.status))

    const loopbackCancel = await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:13599', 'content-type': 'application/json' },
      body: '{}',
    })
    check('loopback web UI may cancel', loopbackCancel.status === 200, String(loopbackCancel.status))

    const evil = await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    check('foreign origins are rejected', evil.status === 403, String(evil.status))

    // A manual binDir is not overwritten: the guard rejects before any spawn.
    const manual = createAssetsApi({
      getConfig: () => resolveConfig({ assetsDir: join(SCRATCH, 'manual'), binDir: join(SCRATCH, 'manual-bin') }),
    })
    const manualPort = await manual.start(port + 10)
    try {
      const install = await fetch(`http://127.0.0.1:${manualPort}/install`, {
        method: 'POST',
        headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
        body: JSON.stringify({ release: true, models: true }),
      })
      const payload = await install.json()
      check('install guard is surfaced', install.status === 500 && String(payload.error).includes('手动指定'), payload.error)
    } finally {
      await manual.close()
    }

    const missing = await fetch(`${base}/nope`)
    check('unknown routes 404', missing.status === 404, String(missing.status))
  } finally {
    await api.close()
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((result) => result.name).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
