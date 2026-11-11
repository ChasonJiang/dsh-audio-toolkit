/**
 * HTTP client for the resident audio.cpp server.
 *
 * The engine is started and stopped by the DSH host plugin; this module only
 * talks to it. Every call is a single HTTP request, so the per-model weights stay
 * loaded between turns.
 */

/** Error carrying the request context needed for a useful tool message. */
export class EngineError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'EngineError'
    this.details = details
  }
}

/** Format a server error body into one line. */
function describeFailure(response, body) {
  const status = `${response.status} ${response.statusText}`.trim()
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.message
    if (message) return `${status}: ${message}`
  } catch {
    /* not JSON */
  }
  return `${status}: ${body.slice(0, 500)}`
}

/** Whether the engine answers `/health`. */
export async function engineHealth(baseUrl, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until the engine is reachable, or give up after `waitMs`.
 * Covers the moment right after DSH boots, when the plugin is still starting the
 * engine in the background.
 */
export async function waitForEngine(baseUrl, waitMs = 4000) {
  const deadline = Date.now() + waitMs
  let health = await engineHealth(baseUrl)
  while (!health && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    health = await engineHealth(baseUrl)
  }
  return health
}

/** Build a hint that tells the model how to get the engine running. */
export function engineDownMessage(baseUrl) {
  return (
    `audio.cpp 引擎未运行（${baseUrl}）。` +
    '请在 DSH 侧栏「插件」页打开 dsh-audio-toolkit，把「引擎启用」设为 true 后保存（或重新启用插件）以启动引擎；' +
    '启动日志在 dsh-audio-toolkit/state/engine.log。'
  )
}

/**
 * POST JSON and resolve to the raw Response.
 *
 * The deadline covers the **whole exchange**, body included: `AbortSignal.timeout`
 * stays attached to the response stream, so a server that answers headers and then
 * stalls cannot hang the tool call. An already-aborted caller signal makes the
 * combined signal aborted before the request is sent.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @param {unknown} body
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
async function postJson(baseUrl, path, body, timeoutMs, signal) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal !== undefined) signals.push(signal)
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
  return response
}

/**
 * Turn a request failure into one actionable line, keeping the reason distinct so
 * callers can tell a timeout from a cancellation.
 * @param {unknown} error
 * @param {string} baseUrl
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal] the caller's signal (a custom abort reason keeps
 *   the `Error` name, so the signal state is the reliable indicator)
 */
function describeRequestError(error, baseUrl, timeoutMs, signal) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') {
    const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
    return {
      message: `引擎请求超时（${label}，${baseUrl}）：模型可能仍在加载，或输入过长`,
      code: 'TIMEOUT',
    }
  }
  if (name === 'AbortError' || signal?.aborted === true) {
    return { message: `引擎请求已取消（${baseUrl}）`, code: 'ABORTED' }
  }
  return {
    message: `请求引擎失败：${error instanceof Error ? error.message : String(error)}`,
    code: 'REQUEST_FAILED',
  }
}

/**
 * Synthesize speech.
 * @param {{baseUrl: string, model: string, text: string, voiceRef?: string, options?: Record<string, unknown>, seed?: number, timeoutMs: number, signal?: AbortSignal}} request
 * @returns {Promise<{bytes: Buffer, contentType: string}>}
 */
export async function synthesizeSpeech(request) {
  const { baseUrl, model, text, voiceRef, options = {}, seed, timeoutMs, signal } = request
  const body = {
    model,
    input: text,
    ...(voiceRef ? { voice_ref: { type: 'path', path: voiceRef } } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }
  let response
  try {
    response = await postJson(baseUrl, '/v1/audio/speech', body, timeoutMs, signal)
  } catch (error) {
    const { message, code } = describeRequestError(error, baseUrl, timeoutMs, signal)
    throw new EngineError(message, { baseUrl, code })
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new EngineError(describeFailure(response, bodyText), { status: response.status })
  }
  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    const { message, code } = describeRequestError(error, baseUrl, timeoutMs, signal)
    throw new EngineError(message, { baseUrl, code })
  }
  if (buffer.length < 44) throw new EngineError(`引擎返回的音频过短（${buffer.length} 字节）`)
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new EngineError('引擎返回的不是 WAV 数据', { head: buffer.subarray(0, 16).toString('hex') })
  }
  return { bytes: buffer, contentType: response.headers.get('content-type') ?? 'audio/wav' }
}

/**
 * Transcribe a server-local audio file.
 * @param {{baseUrl: string, model: string, audioPath: string, options?: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal}} request
 * @returns {Promise<Record<string, any>>}
 */
export async function transcribeAudio(request) {
  const { baseUrl, model, audioPath, options = {}, timeoutMs, signal } = request
  const body = {
    model,
    audio: audioPath,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }
  let response
  try {
    response = await postJson(baseUrl, '/v1/audio/transcriptions', body, timeoutMs, signal)
  } catch (error) {
    const { message, code } = describeRequestError(error, baseUrl, timeoutMs, signal)
    throw new EngineError(message, { baseUrl, code })
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    const { message, code } = describeRequestError(error, baseUrl, timeoutMs, signal)
    throw new EngineError(message, { baseUrl, code })
  }
  if (!response.ok) throw new EngineError(describeFailure(response, text), { status: response.status })
  try {
    return JSON.parse(text)
  } catch {
    throw new EngineError(`引擎返回了无法解析的响应：${text.slice(0, 300)}`)
  }
}

/** List configured models and their loaded state. */
export async function listModels(baseUrl, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
