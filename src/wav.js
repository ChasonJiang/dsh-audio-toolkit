/**
 * Minimal PCM WAV reader/writer used by the segment-timestamp path.
 *
 * The VAD model needs 16 kHz mono input and each detected sentence is sent to the
 * engine as its own file, so the toolkit slices audio itself instead of shelling
 * out to ffmpeg. 16-bit PCM is the common case (it is what audio.cpp writes);
 * 8-bit and 32-bit integer PCM are accepted so odd inputs still work, and float
 * or compressed WAVs fail with a clear message.
 *
 * `readMono16k` streams a file: long recordings used to be decoded into a Buffer,
 * an Int16Array, a Float32Array and a second Int16Array at once (≈1.4 GB for a
 * two-hour stereo file). It now decodes one block at a time into the single
 * output buffer.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Raised when a file is not a usable PCM WAV. */
export class WavError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WavError'
  }
}

function readTag(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4)
}

/** `WAVE_FORMAT_EXTENSIBLE`: the real format lives in a sub-format GUID. */
const WAVE_FORMAT_EXTENSIBLE = 0xfffe
/** `WAVE_FORMAT_IEEE_FLOAT`. */
const WAVE_FORMAT_FLOAT = 0x0003

/**
 * Resolve the effective format of a `fmt ` chunk.
 *
 * ffmpeg and most DAWs write 24/32-bit PCM as `WAVE_FORMAT_EXTENSIBLE`
 * (format 65534) with the real code in the first two bytes of the sub-format
 * GUID. Rejecting those files made the sentence-timeline path refuse perfectly
 * ordinary PCM audio, so the code unwraps the GUID and keeps only the layout.
 *
 * @param {Buffer} fmtBuffer the `fmt ` chunk body
 * @returns {{audioFormat: number, channels: number, sampleRate: number, bitsPerSample: number}}
 */
function readFormatChunk(fmtBuffer) {
  if (fmtBuffer.length < 16) throw new WavError('WAV 的 fmt 块被截断')
  const declared = fmtBuffer.readUInt16LE(0)
  const channels = fmtBuffer.readUInt16LE(2)
  const sampleRate = fmtBuffer.readUInt32LE(4)
  const bitsPerSample = fmtBuffer.readUInt16LE(14)
  let audioFormat = declared
  if (declared === WAVE_FORMAT_EXTENSIBLE) {
    if (fmtBuffer.length < 40) throw new WavError('WAVE_FORMAT_EXTENSIBLE 的 fmt 块缺少子格式 GUID')
    audioFormat = fmtBuffer.readUInt16LE(24)
  }
  if (audioFormat === WAVE_FORMAT_FLOAT) {
    if (bitsPerSample !== 32) {
      throw new WavError(`只支持 32-bit float WAV（当前 ${bitsPerSample} bit）`)
    }
  } else if (audioFormat === 1) {
    if (![8, 16, 24, 32].includes(bitsPerSample)) {
      throw new WavError(`不支持的位深：${bitsPerSample} bit（支持 8/16/24/32）`)
    }
  } else {
    throw new WavError(
      `只支持 PCM 或 32-bit float 的 WAV（当前 format=${audioFormat}，可能是压缩格式）`,
    )
  }
  if (!(channels > 0) || !(sampleRate > 0)) throw new WavError('WAV 声道数或采样率无效')
  return { audioFormat, channels, sampleRate, bitsPerSample }
}

/**
 * Build a reader for one sample, scaled to the int16 range.
 *
 * 8-bit WAV is unsigned, 24-bit is little-endian 3 bytes, 32-bit PCM is
 * left-justified so a 16-bit shift keeps the headroom, and float is scaled
 * directly.
 * @param {Buffer} buffer
 * @param {number} audioFormat
 * @param {number} bitsPerSample
 * @returns {(offset: number) => number}
 */
function sampleReader(buffer, audioFormat, bitsPerSample) {
  if (audioFormat === WAVE_FORMAT_FLOAT) {
    return (offset) =>
      Math.max(-32768, Math.min(32767, Math.round(buffer.readFloatLE(offset) * 32768)))
  }
  if (bitsPerSample === 8) return (offset) => (buffer.readUInt8(offset) - 128) * 256
  if (bitsPerSample === 16) return (offset) => buffer.readInt16LE(offset)
  if (bitsPerSample === 24) {
    return (offset) => {
      const raw =
        buffer.readUInt8(offset) |
        (buffer.readUInt8(offset + 1) << 8) |
        (buffer.readUInt8(offset + 2) << 16)
      const signed = raw & 0x800000 ? raw - 0x1000000 : raw
      return Math.round(signed / 256)
    }
  }
  return (offset) => Math.max(-32768, Math.min(32767, Math.round(buffer.readInt32LE(offset) / 65536)))
}

/**
 * Parse a PCM/float WAV file that is already in memory.
 *
 * Production paths read files through {@link readMono16k}; this stays as the
 * straightforward variant for small buffers and as the reference the streaming
 * reader is tested against.
 * @param {Buffer} buffer
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number, samples: Int16Array, durationMs: number}}
 */
export function parseWav(buffer) {
  if (buffer.length < 44 || readTag(buffer, 0) !== 'RIFF' || readTag(buffer, 8) !== 'WAVE') {
    throw new WavError('不是 RIFF/WAVE 文件（引擎与句级时间戳都只支持 WAV，可用 ffmpeg 转换）')
  }
  let offset = 12
  let fmt
  let data
  while (offset + 8 <= buffer.length) {
    const id = readTag(buffer, offset)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = readFormatChunk(buffer.subarray(body, body + size))
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buffer.length - body) }
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new WavError('WAV 缺少 fmt 或 data 块')
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt

  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(data.size / (bytesPerSample * channels))
  const samples = new Int16Array(frames * channels)
  const readSample = sampleReader(buffer, audioFormat, bitsPerSample)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = readSample(data.start + i * bytesPerSample)
  }
  return {
    sampleRate,
    channels,
    bitsPerSample,
    samples,
    durationMs: (frames / sampleRate) * 1000,
  }
}

/**
 * Mix down to mono and resample to 16 kHz with linear interpolation.
 * @param {Int16Array} samples interleaved samples
 * @param {number} channels
 * @param {number} sampleRate
 * @returns {Int16Array}
 */
export function toMono16k(samples, channels, sampleRate, targetRate = 16000) {
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += samples[frame * channels + channel]
    mono[frame] = sum / channels
  }
  if (sampleRate === targetRate) {
    const out = new Int16Array(frames)
    for (let i = 0; i < frames; i += 1) out[i] = Math.round(mono[i])
    return out
  }
  const ratio = sampleRate / targetRate
  const outFrames = Math.max(1, Math.floor(frames / ratio))
  const out = new Int16Array(outFrames)
  for (let i = 0; i < outFrames; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = mono[index] ?? 0
    const b = mono[Math.min(index + 1, frames - 1)] ?? a
    out[i] = Math.round(a + (b - a) * fraction)
  }
  return out
}

/**
 * Encode mono 16-bit PCM samples as a WAV buffer.
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate = 16000) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i += 1) buffer.writeInt16LE(samples[i], 44 + i * 2)
  return buffer
}

/** Copy a sample range out of a mono buffer, clamped to its bounds. */
export function sliceSamples(samples, startFrame, endFrame) {
  const start = Math.max(0, Math.min(samples.length, Math.floor(startFrame)))
  const end = Math.max(start, Math.min(samples.length, Math.floor(endFrame)))
  return samples.subarray(start, end)
}

/** Read exactly `length` bytes at `position`; returns the bytes transferred. */
function readAt(fd, buffer, offset, length, position) {
  let done = 0
  while (done < length) {
    const read = readSync(fd, buffer, offset + done, length - done, position + done)
    if (read <= 0) break
    done += read
  }
  return done
}

/** Output frames decoded per streaming pass (bounds the working set). */
const BLOCK_OUTPUT_FRAMES = 65_536

/**
 * Read the RIFF structure without loading the audio payload.
 * @param {number} fd
 * @param {number} fileSize
 * @returns {{audioFormat: number, sampleRate: number, channels: number, bitsPerSample: number, dataStart: number, dataSize: number}}
 */
function readWavHeader(fd, fileSize) {
  const head = Buffer.alloc(12)
  if (readAt(fd, head, 0, 12, 0) < 12) throw new WavError('文件过短，不是 RIFF/WAVE')
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavError('不是 RIFF/WAVE 文件')
  }
  const chunk = Buffer.alloc(8)
  let offset = 12
  let fmt
  let data
  while (offset + 8 <= fileSize) {
    if (readAt(fd, chunk, 0, 8, offset) < 8) break
    const id = chunk.toString('ascii', 0, 4)
    const size = chunk.readUInt32LE(4)
    const body = offset + 8
    if (id === 'fmt ') {
      const fmtBuffer = Buffer.alloc(Math.min(size, 64))
      if (readAt(fd, fmtBuffer, 0, fmtBuffer.length, body) < fmtBuffer.length) throw new WavError('WAV 的 fmt 块被截断')
      fmt = readFormatChunk(fmtBuffer)
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, fileSize - body) }
      if (fmt) break
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new WavError('WAV 缺少 fmt 或 data 块')
  return { ...fmt, dataStart: data.start, dataSize: data.size }
}

/**
 * Read only the format header of a WAV file (no audio payload).
 * @param {string} path
 * @returns {{audioFormat: number, channels: number, sampleRate: number, bitsPerSample: number}}
 */
export function readWavFormat(path) {
  const fd = openSync(path, 'r')
  try {
    const { audioFormat, channels, sampleRate, bitsPerSample } = readWavHeader(fd, statSync(path).size)
    return { audioFormat, channels, sampleRate, bitsPerSample }
  } finally {
    closeSync(fd)
  }
}

/**
 * Stream a WAV (PCM or float) into 16 kHz mono samples.
 *
 * Same arithmetic as {@link toMono16k} (average the channels, linear resample),
 * but it reads one output block at a time so memory stays proportional to the
 * decoded signal instead of to the original file plus three copies of it.
 *
 * @param {string} path
 * @param {number} [targetRate]
 * @returns {Int16Array}
 */
export function readMono16k(path, targetRate = 16000) {
  const fd = openSync(path, 'r')
  try {
    const fileSize = statSync(path).size
    const { audioFormat, sampleRate, channels, bitsPerSample, dataStart, dataSize } = readWavHeader(fd, fileSize)
    const bytesPerSample = bitsPerSample / 8
    const blockAlign = bytesPerSample * channels
    const sourceFrames = Math.floor(dataSize / blockAlign)
    const ratio = sampleRate / targetRate
    const outputFrames =
      sampleRate === targetRate ? sourceFrames : Math.max(1, Math.floor(sourceFrames / ratio))
    const out = new Int16Array(outputFrames)
    if (outputFrames === 0 || sourceFrames === 0) return out

    /** Decode `frames` source frames starting at `sourceStart` into mono floats. */
    let scratch = Buffer.alloc(0)
    const decode = (sourceStart, frames) => {
      const bytes = frames * blockAlign
      // A bigger block reallocates `scratch`, so the sample reader is built after
      // that (it closes over the current buffer).
      if (scratch.length < bytes) scratch = Buffer.alloc(bytes)
      const readSample = sampleReader(scratch, audioFormat, bitsPerSample)
      const got = readAt(fd, scratch, 0, bytes, dataStart + sourceStart * blockAlign)
      const decoded = Math.floor(got / blockAlign)
      const mono = new Float32Array(decoded)
      for (let frame = 0; frame < decoded; frame += 1) {
        let sum = 0
        for (let channel = 0; channel < channels; channel += 1) {
          sum += readSample(frame * blockAlign + channel * bytesPerSample)
        }
        mono[frame] = sum / channels
      }
      return mono
    }

    for (let start = 0; start < outputFrames; start += BLOCK_OUTPUT_FRAMES) {
      const end = Math.min(outputFrames, start + BLOCK_OUTPUT_FRAMES)
      if (sampleRate === targetRate) {
        const mono = decode(start, end - start)
        for (let i = 0; i < mono.length; i += 1) out[start + i] = Math.round(mono[i])
        continue
      }
      // The window must cover the interpolation neighbour of the last sample.
      const sourceStart = Math.floor(start * ratio)
      const sourceEnd = Math.min(sourceFrames, Math.floor((end - 1) * ratio) + 2)
      const mono = decode(sourceStart, sourceEnd - sourceStart)
      for (let i = start; i < end; i += 1) {
        const position = i * ratio - sourceStart
        const index = Math.floor(position)
        const fraction = position - index
        const a = mono[index] ?? 0
        const b = mono[Math.min(index + 1, mono.length - 1)] ?? a
        out[i] = Math.round(a + (b - a) * fraction)
      }
    }
    return out
  } finally {
    closeSync(fd)
  }
}
