#!/usr/bin/env node
/**
 * Asset download worker.
 *
 * Spawned by `ensureAssets` so that `NODE_USE_ENV_PROXY` (read once at startup)
 * can make `fetch` honour the configured proxy, and so the multi-hundred-MB
 * archives stay out of the DSH process heap. Progress goes to stdout; the parent
 * forwards it to `state/host.log`.
 *
 * Usage: node mcp/provision.mjs '{"config":{...},"options":{...}}'
 */

import { provisionAssets } from './assets.mjs'

const payload = JSON.parse(process.argv[2] ?? '{}')
if (!payload.config?.assets?.root) {
  console.error('provision: 缺少 config')
  process.exit(2)
}

try {
  await provisionAssets(payload.config, {
    ...payload.options,
    log: (line) => console.log(line),
    onProgress: (update) => console.log(`@@P${JSON.stringify(update)}`),
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
