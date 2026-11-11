/**
 * Sentence-level timestamps for SenseVoice.
 *
 * SenseVoice is a CTC model: it returns one transcript with no sentence or word
 * boundaries, and the shipped audio.cpp build exposes no timestamp option. This
 * module builds a timeline around the model instead:
 *
 *  1. mix the input down to 16 kHz mono (the VAD model's required input),
 *  2. run the bundled PulseVAD through the audio.cpp CLI to find speech regions,
 *  3. merge/trim those regions into sentence-sized blocks,
 *  4. transcribe each block with the resident engine and attach its time range.
 *
 * Costs one short CLI run for the VAD plus one warm engine request per sentence.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EngineError } from './engine.mjs'
import { runCli } from './audiocpp.mjs'
import { encodeWav, readMono16k, sliceSamples, WavError } from '../src/wav.js'

/** Everything above this is a cancelled tool call, not a model problem. */
function assertNotAborted(signal) {
  if (signal?.aborted) throw new EngineError('转写已取消')
}

/**
 * Detect speech regions in a 16 kHz mono buffer.
 * @param {Int16Array} mono
 * @param {Record<string, any>} cfg
 * @param {string} workDir
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{start: number, end: number}>>} frame ranges at 16 kHz
 */
async function detectSpeechRegions(mono, cfg, workDir, signal) {
  if (!cfg.asr.vadModel) {
    throw new EngineError('句级时间戳需要 VAD 模型：请在插件面板设置 asrVadModel（默认 PulseVAD GGUF）。')
  }
  const vadInput = join(workDir, 'vad-input.wav')
  const vadOutput = join(workDir, 'vad-segments.json')
  writeFileSync(vadInput, encodeWav(mono, 16000))
  assertNotAborted(signal)

  await runCli({
    cliPath: cfg.audioCpp.cliPath,
    cwd: cfg.audioCpp.binDir,
    scratchDir: cfg.output.tmp,
    timeoutMs: cfg.mcp.toolCallTimeoutMs,
    args: [
      '--task',
      'vad',
      '--family',
      'pulsevad',
      '--model',
      cfg.asr.vadModel,
      '--backend',
      cfg.audioCpp.backend,
      // The VAD pass has to honour the same device/threads as the resident engine.
      ...(cfg.audioCpp.device > 0 ? ['--device', String(cfg.audioCpp.device)] : []),
      ...(cfg.audioCpp.threads > 0 ? ['--threads', String(cfg.audioCpp.threads)] : []),
      '--audio',
      vadInput,
      '--segments-out',
      vadOutput,
    ],
  })
  let text = ''
  try {
    text = readFileSync(vadOutput, 'utf8')
  } catch (error) {
    // The CLI writes no segments file when it hears no speech at all.
    if (error?.code === 'ENOENT') return []
    throw new EngineError(`无法读取 VAD 结果：${error.message}`, { path: vadOutput })
  }
  if (!text.trim()) return []
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new EngineError(`VAD 结果不是合法 JSON：${error.message}`, { path: vadOutput })
  }
  const list = Array.isArray(raw) ? raw : (raw.segments ?? [])
  return list.map((entry) => ({
    start: Number(entry.start_sample ?? 0),
    end: Number(entry.end_sample ?? 0),
  }))
}

/**
 * Turn raw speech regions into sentence blocks.
 * @param {Array<{start: number, end: number}>} regions
 * @param {number} totalFrames
 * @param {{minMs: number, mergeGapMs: number}} rules
 */
export function buildBlocks(regions, totalFrames, rules) {
  const minFrames = Math.max(1, Math.round((rules.minMs / 1000) * 16000))
  const mergeFrames = Math.max(0, Math.round((rules.mergeGapMs / 1000) * 16000))
  const sorted = regions
    .filter((region) => Number.isFinite(region.start) && Number.isFinite(region.end) && region.end > region.start)
    .map((region) => ({
      start: Math.max(0, Math.min(totalFrames, region.start)),
      end: Math.max(0, Math.min(totalFrames, region.end)),
    }))
    .sort((a, b) => a.start - b.start)

  const blocks = []
  for (const region of sorted) {
    const previous = blocks[blocks.length - 1]
    if (previous && region.start - previous.end <= mergeFrames) {
      previous.end = Math.max(previous.end, region.end)
      continue
    }
    blocks.push({ ...region })
  }
  return blocks.filter((block) => block.end - block.start >= minFrames)
}

/**
 * Transcribe an audio file into sentence blocks with timestamps.
 * @param {object} request
 * @param {string} request.audioPath absolute path of the input audio
 * @param {Record<string, any>} request.cfg resolved toolkit config
 * @param {string} request.language recognition language (`auto` or a code)
 * @param {(args: object) => Promise<{text: string} & Record<string, any>>} request.transcribe
 *   one engine transcription call, injected so this module stays transport-free;
 *   it decides its own chunking (a sentence slice is already short)
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<{text: string, segments: Array<Record<string, any>>, durationMs: number, vadRegions: number, fallback: boolean}>}
 */
export async function transcribeWithTimestamps({ audioPath, cfg, language, transcribe, signal }) {
  let monoSamples
  try {
    // Streamed decode: long recordings no longer need the file plus three copies.
    monoSamples = readMono16k(audioPath)
  } catch (error) {
    if (error instanceof WavError) {
      throw new EngineError(`${audioPath} 无法做句级时间戳：${error.message}。句级时间戳只支持 WAV（PCM 8/16/24/32-bit 或 32-bit float），可用 ffmpeg 转换。`)
    }
    throw error
  }
  const durationMs = (monoSamples.length / 16000) * 1000

  const workDir = join(cfg.output.tmp, `segments-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  try {
    const regions = await detectSpeechRegions(monoSamples, cfg, workDir, signal)
    assertNotAborted(signal)
    const blocks = buildBlocks(regions, monoSamples.length, {
      minMs: cfg.asr.minSegmentMs,
      mergeGapMs: cfg.asr.mergeGapMs,
    })
    if (blocks.length === 0) {
      // Music, noise, or VAD settings that fit nothing: transcribe the whole file
      // rather than answering "success" with an empty transcript.
      // A whole-file fallback keeps the caller's chunking, unlike a sentence slice.
      const result = await transcribe({ audioPath, chunking: 'requested' })
      const text = String(result?.text ?? '').trim()
      return {
        text,
        segments: text
          ? [
              {
                index: 0,
                start_ms: 0,
                end_ms: Math.round(durationMs),
                duration_ms: Math.round(durationMs),
                text,
              },
            ]
          : [],
        durationMs,
        vadRegions: regions.length,
        fallback: true,
      }
    }

    const segments = []
    for (const [index, block] of blocks.entries()) {
      assertNotAborted(signal)
      const slice = sliceSamples(monoSamples, block.start, block.end)
      const slicePath = join(workDir, `seg-${String(index).padStart(3, '0')}.wav`)
      writeFileSync(slicePath, encodeWav(slice, 16000))
      const result = await transcribe({ audioPath: slicePath })
      const text = String(result?.text ?? '').trim()
      const startMs = Math.round((block.start / 16000) * 1000)
      const endMs = Math.round((block.end / 16000) * 1000)
      if (!text) continue
      segments.push({
        index: segments.length,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: endMs - startMs,
        text,
      })
    }

    return {
      text: segments.map((segment) => segment.text).join('\n'),
      segments,
      durationMs,
      vadRegions: regions.length,
      fallback: false,
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* scratch only */
    }
  }
}
