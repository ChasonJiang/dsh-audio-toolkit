/**
 * Async job queue for batch submissions.
 *
 * The agent can hand over several TTS/ASR tasks at once, keep working, then poll
 * for completion. Jobs run against the same handlers as the synchronous tools, so
 * results are identical — only the waiting model differs.
 *
 * The queue is intentionally small: in-memory scheduling, an optional JSON
 * snapshot so a plugin reload does not orphan finished results, and no resumption
 * of interrupted work (the audio files are still on disk; the job is not).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Finished jobs are listed by default; older ones are dropped past this count. */
const RETAINED_JOBS = 100

/** Snapshot writes are coalesced; the queue may finish several jobs per tick. */
const PERSIST_DEBOUNCE_MS = 300

/** Allowed terminal and intermediate states. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'error', 'cancelled']

let sequence = 0

/** `job-20261111-183000-412-7` (timestamp, milliseconds, sequence) */
function nextJobId() {
  const now = new Date()
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  sequence = (sequence + 1) % 1000
  return [
    'job-',
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    // Milliseconds keep ids unique past 1000 submissions per second.
    pad(now.getMilliseconds(), 3),
    '-',
    pad(sequence, 3),
  ].join('')
}

/** Strip internal bookkeeping (the abort controller, raw cfg) from a job. */
function publicView(job) {
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    submitted_at: new Date(job.submittedAt).toISOString(),
    started_at: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    duration_ms: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.result === undefined ? {} : { result: job.result }),
  }
}

/**
 * FIFO queue with bounded concurrency.
 */
export class JobQueue {
  /**
   * @param {object} options
   * @param {(kind: string, params: Record<string, any>, cfg: Record<string, any>, signal: AbortSignal) => Promise<any>} options.execute
   *   runs one task through the matching tool handler
   * @param {number} [options.limit] max concurrently running jobs
   * @param {string} [options.persistPath] JSON snapshot path (optional)
   */
  constructor({ execute, limit = 2, persistPath }) {
    this.execute = execute
    this.limit = Math.max(1, limit)
    this.persistPath = persistPath
    /** @type {Map<string, any>} insertion-ordered */
    this.jobs = new Map()
    this.pending = []
    this.running = 0
    this.persistTimer = undefined
    this.disposed = false
    this.load()
  }

  /** Update the concurrency limit (from the panel config). */
  setLimit(limit) {
    const next = Math.max(1, Math.trunc(Number(limit) || 1))
    if (next === this.limit) return
    this.limit = next
    this.pump()
  }

  /**
   * Queue one task.
   * @param {{kind: string, params: Record<string, any>, cfg: Record<string, any>}} task
   * @returns {Record<string, any>} the public job view
   */
  submit({ kind, params, cfg }) {
    const job = {
      id: nextJobId(),
      kind,
      params,
      cfg,
      status: 'queued',
      submittedAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      controller: undefined,
    }
    this.jobs.set(job.id, job)
    this.pending.push(job)
    this.trim()
    this.pump()
    this.persist()
    return publicView(job)
  }

  /** Run queued jobs while capacity remains. */
  pump() {
    if (this.disposed) return
    while (this.running < this.limit && this.pending.length > 0) {
      const job = this.pending.shift()
      if (!job || job.status !== 'queued') continue
      this.running += 1
      job.status = 'running'
      job.startedAt = Date.now()
      job.controller = new AbortController()
      this.persist()
      void this.execute(job.kind, job.params, job.cfg, job.controller.signal)
        .then((result) => {
          if (job.status === 'cancelled') return
          job.status = 'done'
          job.result = result
        })
        .catch((error) => {
          if (job.status === 'cancelled' || error?.name === 'AbortError') {
            job.status = 'cancelled'
            return
          }
          job.status = 'error'
          job.error = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          job.finishedAt = Date.now()
          job.controller = undefined
          this.running = Math.max(0, this.running - 1)
          this.persist()
          this.pump()
        })
    }
  }

  /**
   * Read jobs, newest first.
   * @param {{ids?: string[], status?: string, limit?: number}} [query]
   */
  list({ ids, status, limit = 20 } = {}) {
    let list = [...this.jobs.values()]
    if (Array.isArray(ids) && ids.length > 0) {
      const wanted = new Set(ids)
      list = list.filter((job) => wanted.has(job.id))
    }
    if (status) list = list.filter((job) => job.status === status)
    list.sort((a, b) => b.submittedAt - a.submittedAt)
    return list.slice(0, Math.max(1, Math.min(100, Math.trunc(limit) || 20))).map(publicView)
  }

  /** Counts per status plus totals, for `audio_status` and quick polling. */
  summary() {
    const counts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 }
    for (const job of this.jobs.values()) counts[job.status] = (counts[job.status] ?? 0) + 1
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    return {
      ...counts,
      total,
      active: counts.queued + counts.running,
      limit: this.limit,
    }
  }

  /**
   * Cancel queued or running jobs.
   * @param {string[]} ids
   */
  cancel(ids) {
    const cancelled = []
    const skipped = []
    for (const id of ids) {
      const job = this.jobs.get(id)
      if (!job) {
        skipped.push({ job_id: id, reason: 'not-found' })
        continue
      }
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = Date.now()
        this.pending = this.pending.filter((entry) => entry !== job)
        cancelled.push(id)
        continue
      }
      if (job.status === 'running') {
        job.status = 'cancelled'
        try {
          job.controller?.abort()
        } catch {
          /* already settled */
        }
        cancelled.push(id)
        continue
      }
      skipped.push({ job_id: id, reason: `already-${job.status}` })
    }
    this.persist()
    return { cancelled, skipped }
  }

  /** Keep the registry bounded: oldest finished jobs go first. */
  trim() {
    if (this.jobs.size <= RETAINED_JOBS) return
    const finished = [...this.jobs.values()]
      .filter((job) => job.status === 'done' || job.status === 'error' || job.status === 'cancelled')
      .sort((a, b) => a.submittedAt - b.submittedAt)
    while (this.jobs.size > RETAINED_JOBS && finished.length > 0) {
      const victim = finished.shift()
      this.jobs.delete(victim.id)
    }
  }

  /**
   * Schedule a snapshot write (debounced).
   * @param {boolean} [force] write synchronously, even while disposing —
   *   `dispose()` must flush the cancellation it just applied before a shutdown
   *   can end the process.
   */
  persist(force = false) {
    if (!this.persistPath || (this.disposed && !force)) return
    if (force) {
      this.writeSnapshot()
      return
    }
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.writeSnapshot()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  /** Write one snapshot atomically; never throws. */
  writeSnapshot() {
    if (!this.persistPath) return
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      const jobs = [...this.jobs.values()].slice(-RETAINED_JOBS).map((job) => ({
        ...publicView(job),
        // cfg is not persisted: interrupted jobs are not resumed.
      }))
      const temp = `${this.persistPath}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), jobs }, null, 2), 'utf8')
      renameSync(temp, this.persistPath)
    } catch {
      /* a snapshot is best effort */
    }
  }

  /** Restore finished jobs from a previous process; mark interrupted ones. */
  load() {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const payload = JSON.parse(readFileSync(this.persistPath, 'utf8').replace(/^\uFEFF/, ''))
      for (const entry of payload?.jobs ?? []) {
        if (!entry?.job_id || this.jobs.has(entry.job_id)) continue
        const interrupted = entry.status === 'queued' || entry.status === 'running'
        this.jobs.set(entry.job_id, {
          id: entry.job_id,
          kind: entry.kind,
          params: {},
          cfg: {},
          status: interrupted ? 'error' : entry.status,
          submittedAt: Date.parse(entry.submitted_at) || Date.now(),
          startedAt: entry.started_at ? Date.parse(entry.started_at) : 0,
          finishedAt: entry.finished_at ? Date.parse(entry.finished_at) : Date.now(),
          error: interrupted ? '插件重启，任务已中断' : entry.error,
          result: entry.result,
        })
      }
      // A snapshot may predate a lower retention limit.
      this.trim()
    } catch {
      /* a corrupt snapshot must not block the queue */
    }
  }

  /** Abort everything, stop scheduling, and flush one last snapshot. */
  dispose() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        try {
          job.controller?.abort()
        } catch {
          /* ignore */
        }
        job.status = 'cancelled'
        job.finishedAt = job.finishedAt || Date.now()
      }
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = job.finishedAt || Date.now()
      }
    }
    this.pending = []
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    // Flush the cancellation state before the disposed guard stops all writes.
    this.persist(true)
    this.disposed = true
  }
}
