/**
 * Cancellable concurrency limiter for MCP tool calls.
 *
 * A tool call can sit in the queue for a long time when several ASR/TTS requests
 * are in flight, so the wait itself must be cancellable: a `notifications/cancelled`
 * has to remove a queued call without running it, and abort a running one through
 * its handler context. The accounting also has to stay exact — a cancelled call
 * must still release the slot it occupies, or later calls would never run.
 *
 * Kept apart from `server.mjs` so the behaviour is testable without stdio.
 */

/** Rejection raised when a queued or running call is cancelled. */
export function cancelledError(reason) {
  const error = new Error(typeof reason === 'string' && reason ? `已取消：${reason}` : '已取消')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  return error
}

/** FIFO limiter with bounded concurrency and per-call cancellation. */
export class SlotQueue {
  constructor() {
    /** @type {Array<() => void>} queued starters */
    this.queue = []
    this.active = 0
  }

  /**
   * Run `fn` once a slot is free.
   * @param {number} limit maximum concurrent executions
   * @param {() => Promise<any>} fn
   * @param {AbortSignal} [signal] cancels the wait or the running call
   */
  run(limit, fn, signal) {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const start = async () => {
        if (settled) return
        this.active += 1
        try {
          const value = await fn()
          settled = true
          cleanup()
          resolvePromise(value)
        } catch (error) {
          settled = true
          cleanup()
          rejectPromise(error)
        } finally {
          this.active -= 1
          const next = this.queue.shift()
          if (next) next()
        }
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(cancelledError(signal?.reason instanceof Error ? signal.reason.message : undefined))
      }
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
        const index = this.queue.indexOf(start)
        if (index >= 0) this.queue.splice(index, 1)
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (this.active < limit) start()
      else this.queue.push(start)
    })
  }
}
