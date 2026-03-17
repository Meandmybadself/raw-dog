/// <reference lib="webworker" />
import LibRaw from 'libraw-wasm'
import type { DecodeRequest, DecodeWorkerMessage, RawMetadata } from '../types'

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const msg = event.data
  if (msg.type !== 'DECODE') return

  const { id, buffer, halfSize } = msg

  const postProgress = (phase: string, percent: number) => {
    const response: DecodeWorkerMessage = { type: 'DECODE_PROGRESS', id, phase, percent }
    self.postMessage(response)
  }

  try {
    postProgress('initializing', 5)

    const raw = new LibRaw()
    const fileBytes = new Uint8Array(buffer)
    // Keep a copy — raw.open() transfers the buffer to libraw's internal worker
    const fileCopy = new Uint8Array(fileBytes)

    postProgress('opening', 10)

    // Use outputBps:8 for simpler data handling — the values are gamma-corrected sRGB
    await raw.open(fileBytes, {
      useCameraWb: true,
      outputBps: 8,
      userQual: halfSize ? 0 : 3,
      halfSize: halfSize ?? false,
      outputColor: 1,
      noAutoBright: false,
    })

    postProgress('processing', 40)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawMeta: any = await raw.metadata(false)

    postProgress('reading pixels', 60)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPixels: any = await raw.imageData()

    postProgress('normalizing', 85)

    const metaWidth: number = rawMeta.width ?? rawMeta.iwidth ?? rawMeta.raw_width ?? 0
    const metaHeight: number = rawMeta.height ?? rawMeta.iheight ?? rawMeta.raw_height ?? 0

    const pixelBytes = extractPixelData(rawPixels, 0)
    const totalPixels = pixelBytes.length / 3  // RGB, 1 byte each

    // metadata reports full-size dimensions even with halfSize: true.
    // Derive actual output dimensions from pixel count + aspect ratio.
    const metaPixels = metaWidth * metaHeight
    let width = metaWidth
    let height = metaHeight
    if (totalPixels > 0 && Math.abs(totalPixels - metaPixels) > metaPixels * 0.01) {
      // Dimensions don't match — likely halfSize mode.
      // Use aspect ratio from metadata to compute actual dims.
      const aspect = metaWidth / metaHeight
      height = Math.round(Math.sqrt(totalPixels / aspect))
      width = Math.round(height * aspect)
    }

    // Detect failed libraw decode: if <10% of sampled pixels are non-zero,
    // the decoder likely doesn't support this format. Fall back to embedded JPEG preview.
    let floatPixels: Float32Array
    let finalWidth = width
    let finalHeight = height

    if (isDecodeMostlyEmpty(pixelBytes)) {
      console.warn('[decode.worker] libraw produced mostly-empty output, trying embedded JPEG fallback')
      const fallback = await decodeEmbeddedPreview(fileCopy)
      if (fallback) {
        floatPixels = fallback.pixels
        finalWidth = fallback.width
        finalHeight = fallback.height
      } else {
        // Fallback also failed — use libraw output as-is
        floatPixels = uint8ToFloat32(pixelBytes)
      }
    } else {
      floatPixels = uint8ToFloat32(pixelBytes)
    }

    postProgress('done', 100)

    const metadata: RawMetadata = {
      width: finalWidth,
      height: finalHeight,
      make: rawMeta.camera_make ?? rawMeta.make ?? rawMeta.camera_manufacturer ?? '',
      model: rawMeta.camera_model ?? rawMeta.model ?? '',
      iso: rawMeta.iso_speed ?? rawMeta.isoSpeed ?? 0,
      shutterSpeed: rawMeta.shutter ?? 0,
      aperture: rawMeta.aperture ?? 0,
      focalLength: rawMeta.focal_len ?? rawMeta.focalLength ?? 0,
      timestamp: rawMeta.timestamp instanceof Date ? rawMeta.timestamp.getTime() : (rawMeta.timestamp ?? 0),
    }

    const response: DecodeWorkerMessage = {
      type: 'DECODE_SUCCESS',
      id,
      pixels: floatPixels.buffer as ArrayBuffer,
      width: finalWidth,
      height: finalHeight,
      metadata,
    }

    self.postMessage(response, [floatPixels.buffer as ArrayBuffer])
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const m = message.toLowerCase()
    let code: 'UNSUPPORTED_FORMAT' | 'CORRUPT_FILE' | 'OUT_OF_MEMORY' | 'UNKNOWN' = 'UNKNOWN'
    if (m.includes('unsupported') || m.includes('no decoder')) code = 'UNSUPPORTED_FORMAT'
    else if (m.includes('corrupt') || m.includes('bad file')) code = 'CORRUPT_FILE'
    else if (m.includes('memory') || m.includes('oom')) code = 'OUT_OF_MEMORY'

    const response: DecodeWorkerMessage = { type: 'DECODE_ERROR', id, code, message }
    self.postMessage(response)
  }
}

/** Check if decoded pixel data is mostly zeros (indicating a failed decode) */
function isDecodeMostlyEmpty(pixelBytes: Uint8Array): boolean {
  const step = Math.max(1, Math.floor(pixelBytes.length / 10000))
  let nonZero = 0
  for (let i = 0; i < pixelBytes.length; i += step) {
    if (pixelBytes[i] !== 0) nonZero++
  }
  const totalSampled = Math.ceil(pixelBytes.length / step)
  return nonZero / totalSampled < 0.1
}

/** Convert 8-bit [0,255] to float32 [0,1] RGB */
function uint8ToFloat32(pixelBytes: Uint8Array): Float32Array {
  const floatPixels = new Float32Array(pixelBytes.length)
  const scale = 1 / 255
  for (let i = 0; i < pixelBytes.length; i++) {
    floatPixels[i] = pixelBytes[i] * scale
  }
  return floatPixels
}

/**
 * Extract and decode the largest embedded JPEG preview from a TIFF/DNG file.
 * DNG files contain embedded JPEG previews that any browser can decode.
 */
async function decodeEmbeddedPreview(
  fileBytes: Uint8Array,
): Promise<{ pixels: Float32Array; width: number; height: number } | null> {
  try {
    const jpeg = extractLargestJpeg(fileBytes)
    if (!jpeg) {
      console.warn('[decode.worker] No embedded JPEG found in file')
      return null
    }
    console.log(`[decode.worker] Found embedded JPEG preview: ${jpeg.length} bytes`)

    const blob = new Blob([jpeg as BlobPart], { type: 'image/jpeg' })
    const bitmap = await createImageBitmap(blob)
    const { width, height } = bitmap

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }

    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const imageData = ctx.getImageData(0, 0, width, height)
    const rgba = imageData.data

    // Convert RGBA u8 → RGB float32
    const pixelCount = width * height
    const floatPixels = new Float32Array(pixelCount * 3)
    const scale = 1 / 255
    for (let i = 0; i < pixelCount; i++) {
      floatPixels[i * 3] = rgba[i * 4] * scale
      floatPixels[i * 3 + 1] = rgba[i * 4 + 1] * scale
      floatPixels[i * 3 + 2] = rgba[i * 4 + 2] * scale
    }

    console.log(`[decode.worker] Embedded JPEG fallback succeeded: ${width}x${height}`)
    return { pixels: floatPixels, width, height }
  } catch (e) {
    console.warn('[decode.worker] Embedded JPEG fallback failed:', e)
    return null
  }
}

/**
 * Parse TIFF/DNG structure to find the largest embedded JPEG.
 * Walks IFDs and SubIFDs looking for JPEG data referenced by standard TIFF tags.
 */
function extractLargestJpeg(data: Uint8Array): Uint8Array | null {
  if (data.length < 8) return null

  // Read TIFF header
  const le = data[0] === 0x49 // 'II' = little-endian, 'MM' = big-endian
  const r16 = (off: number) =>
    le ? data[off] | (data[off + 1] << 8) : (data[off] << 8) | data[off + 1]
  const r32 = (off: number) =>
    le
      ? (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | ((data[off + 3] << 24) >>> 0)) >>> 0
      : (((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0)

  const magic = r16(2)
  if (magic !== 42) return null // Not TIFF

  let bestJpeg: Uint8Array | null = null
  let bestSize = 0

  const ifdQueue: number[] = [r32(4)]
  const visited = new Set<number>()

  while (ifdQueue.length > 0) {
    const ifdOff = ifdQueue.pop()!
    if (visited.has(ifdOff) || ifdOff === 0 || ifdOff + 2 > data.length) continue
    visited.add(ifdOff)

    const entryCount = r16(ifdOff)
    const ifdEnd = ifdOff + 2 + entryCount * 12
    if (ifdEnd + 4 > data.length) continue

    let compression = 0
    let jpegOffset = 0
    let jpegLength = 0
    let stripOffsets: number[] = []
    let stripCounts: number[] = []

    for (let i = 0; i < entryCount; i++) {
      const e = ifdOff + 2 + i * 12
      const tag = r16(e)
      const type = r16(e + 2)
      const count = r32(e + 4)
      const vOff = e + 8

      // Read a single value (SHORT or LONG)
      const val1 = () => (type === 3 ? r16(vOff) : r32(vOff))

      // Read array of values (SHORT or LONG), following offset if >4 bytes
      const valN = (): number[] => {
        const itemSize = type === 3 ? 2 : 4
        const totalBytes = count * itemSize
        const src = totalBytes > 4 ? r32(vOff) : vOff
        if (src + totalBytes > data.length) return []
        const out: number[] = []
        for (let j = 0; j < count; j++) {
          out.push(type === 3 ? r16(src + j * itemSize) : r32(src + j * itemSize))
        }
        return out
      }

      switch (tag) {
        case 0x0103: // Compression
          compression = val1()
          break
        case 0x0111: // StripOffsets
          stripOffsets = valN()
          break
        case 0x0117: // StripByteCounts
          stripCounts = valN()
          break
        case 0x014a: // SubIFDs
          for (const sub of valN()) ifdQueue.push(sub)
          break
        case 0x0201: // JPEGInterchangeFormat (thumbnail offset)
          jpegOffset = val1()
          break
        case 0x0202: // JPEGInterchangeFormatLength
          jpegLength = val1()
          break
      }
    }

    // JPEG thumbnail via tags 0x0201/0x0202
    if (jpegOffset > 0 && jpegLength > 0 && jpegOffset + jpegLength <= data.length) {
      if (jpegLength > bestSize) {
        bestJpeg = data.slice(jpegOffset, jpegOffset + jpegLength)
        bestSize = jpegLength
      }
    }

    // JPEG-compressed strips (compression 6=old-JPEG, 7=new-JPEG)
    if ((compression === 6 || compression === 7) && stripOffsets.length === 1 && stripCounts.length >= 1) {
      const off = stripOffsets[0]
      const len = stripCounts[0]
      if (off + len <= data.length && len > bestSize) {
        bestJpeg = data.slice(off, off + len)
        bestSize = len
      }
    }

    // Next IFD in chain
    const nextIFD = r32(ifdEnd)
    if (nextIFD > 0) ifdQueue.push(nextIFD)
  }

  return bestJpeg
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPixelData(data: any, expectedLength: number): Uint8Array {
  // Case 1: Already a typed array with valid buffer
  if (data instanceof Uint8Array && data.byteLength > 0) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data) && data.buffer?.byteLength > 0) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  // Case 2: Plain object from structured clone of embind vector
  // Embind vectors become objects like {0: 128, 1: 64, 2: 200, ...}
  if (data && typeof data === 'object') {
    // Try numeric keys
    const keys = Object.keys(data)
    if (keys.length > 0 && !isNaN(Number(keys[0]))) {
      const len = keys.length
      const arr = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        arr[i] = data[i] ?? data[String(i)] ?? 0
      }
      return arr
    }

    // Try if it has a 'data' or 'buffer' property
    if (data.data) return extractPixelData(data.data, expectedLength)
    if (data.buffer && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer)
    }

    // Log structure for debugging
    const sampleKeys = Object.keys(data).slice(0, 10)
    const sampleVals = sampleKeys.map(k => `${k}:${typeof data[k]}=${data[k]}`)
    throw new Error(
      `Cannot extract pixels from object. Keys(${Object.keys(data).length}): [${sampleVals.join(', ')}]`
    )
  }

  throw new Error(`Unexpected imageData: type=${typeof data}, constructor=${data?.constructor?.name}`)
}
