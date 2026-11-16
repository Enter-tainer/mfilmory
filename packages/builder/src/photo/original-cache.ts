import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { workdir } from '@afilmory/builder/path.js'

import { removeWithWindowsRetry, renameWithWindowsRetry } from '../image/asset-signature.js'

/**
 * 原图磁盘缓存。
 *
 * 每次 `--force-*` 重建都要从 S3 重新下载全部原图（这个库是 3.1GB），
 * 在本地反复调参时纯属浪费。这里把下载过的原图缓存到
 * `apps/web/src/data/.cache/originals/`（该目录本来就在 .gitignore 里），
 * 命中就不走网络。
 *
 * 对象被替换（`LastModified` 变化）时应传入 `invalidate: true` 清理旧缓存；
 * 需要干净结果时也可用 `MFILMORY_NO_ORIGINAL_CACHE=1` 跑一次，或直接删缓存目录。
 */
const CACHE_DIR = path.join(workdir, 'src/data/.cache/originals')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
const FTYP_MARKER = Buffer.from('ftyp', 'ascii')

function cacheEnabled(): boolean {
  return process.env.MFILMORY_NO_ORIGINAL_CACHE !== '1'
}

function resolveCachePath(key: string): string {
  const normalizedKey = key.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalizedKey.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Invalid original cache key: ${key}`)
  }

  const joined = segments.join('/')
  const ext = path.posix.extname(joined)
  const stem = ext ? joined.slice(0, -ext.length) : joined
  const shortHash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)
  const safeRelative = `${stem}_${shortHash}${ext}`
  const resolved = path.resolve(CACHE_DIR, safeRelative)
  const rel = path.relative(CACHE_DIR, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Original cache key escapes cache directory: ${key}`)
  }
  return resolved
}

interface ByteSource {
  size: number
  readSlice: (offset: number, length: number) => Promise<Buffer>
}

function createBufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    async readSlice(offset: number, length: number): Promise<Buffer> {
      const start = Math.max(0, offset)
      const end = Math.min(buffer.length, start + length)
      return buffer.subarray(start, end)
    },
  }
}

function createFileHandleSource(handle: fs.FileHandle, size: number): ByteSource {
  return {
    size,
    async readSlice(offset: number, length: number): Promise<Buffer> {
      const targetLength = Math.max(0, Math.min(length, size - offset))
      if (targetLength === 0) {
        return Buffer.alloc(0)
      }
      const out = Buffer.allocUnsafe(targetLength)
      let totalRead = 0
      while (totalRead < targetLength) {
        const { bytesRead } = await handle.read(out, totalRead, targetLength - totalRead, offset + totalRead)
        if (bytesRead === 0) {
          break
        }
        totalRead += bytesRead
      }
      return totalRead === targetLength ? out : out.subarray(0, totalRead)
    },
  }
}

async function isCompleteIsoBmffFrom(source: ByteSource, startOffset: number): Promise<boolean> {
  if (startOffset < 0 || source.size - startOffset < 12) {
    return false
  }
  const firstHeader = await source.readSlice(startOffset, 8)
  if (firstHeader.length < 8 || !firstHeader.subarray(4, 8).equals(FTYP_MARKER)) {
    return false
  }

  let pos = startOffset
  while (pos < source.size) {
    if (pos + 8 > source.size) {
      return false
    }
    const header = await source.readSlice(pos, 16)
    if (header.length < 8) {
      return false
    }
    const size32 = header.readUInt32BE(0)
    if (size32 === 0) {
      return true
    }
    if (size32 === 1) {
      if (pos + 16 > source.size || header.length < 16) {
        return false
      }
      const boxSize = Number(header.readBigUInt64BE(8))
      if (!Number.isFinite(boxSize) || boxSize < 16 || pos + boxSize > source.size) {
        return false
      }
      pos += boxSize
      continue
    }
    if (size32 < 8 || pos + size32 > source.size) {
      return false
    }
    pos += size32
  }
  return pos === source.size
}

async function findMotionPhotoBmffOffset(source: ByteSource): Promise<number | null> {
  const chunkSize = 65_536
  const overlap = 8
  for (let offset = 2; offset < source.size; offset += chunkSize - overlap) {
    const chunk = await source.readSlice(offset, chunkSize)
    if (chunk.length < 8) {
      break
    }
    let searchFrom = 4
    while (true) {
      const idx = chunk.indexOf(FTYP_MARKER, searchFrom)
      if (idx === -1) {
        break
      }
      const candidateBoxStart = offset + idx - 4
      if (candidateBoxStart >= 4) {
        return candidateBoxStart
      }
      searchFrom = idx + 1
    }
  }
  return null
}

/**
 * 判断缓存下来的字节是不是一张完整的图。
 *
 * 实测踩到的坑：S3 GET 被中断时能拿到截断的 body（本机出现过一批正好
 * 524288 字节的半个 JPEG），缓存下来之后每次重建都在 sharp 里报
 * `VipsJpeg: premature end of JPEG image`，而且因为缓存命中会一直复现。
 * 这里结合预期大小及各容器格式头尾/Box 结构做完整性校验。
 */
async function looksCompleteSource(source: ByteSource, key: string, expectedSize?: number): Promise<boolean> {
  if (source.size <= 0) {
    return false
  }
  if (expectedSize !== undefined && expectedSize > 0 && source.size !== expectedSize) {
    return false
  }

  const ext = path.extname(key).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg': {
      if (source.size < 4) {
        return false
      }
      const head = await source.readSlice(0, 2)
      if (head.length < 2 || head[0] !== 0xFF || head[1] !== 0xD8) {
        return false
      }
      const tail = await source.readSlice(source.size - 2, 2)
      if (tail.length === 2 && tail[0] === 0xFF && tail[1] === 0xD9) {
        return true
      }
      // Android MotionPhoto 在 JPEG FFD9 末尾之后追加 MP4/ISOBMFF 视频段
      const bmffOffset = await findMotionPhotoBmffOffset(source)
      if (bmffOffset !== null) {
        return await isCompleteIsoBmffFrom(source, bmffOffset)
      }
      return false
    }
    case '.png': {
      if (source.size < 33) {
        return false
      }
      const head = await source.readSlice(0, 8)
      if (!head.equals(PNG_MAGIC)) {
        return false
      }
      const tail = await source.readSlice(source.size - 12, 12)
      return tail.equals(PNG_IEND)
    }
    case '.webp': {
      if (source.size < 12) {
        return false
      }
      const head = await source.readSlice(0, 12)
      if (head.subarray(0, 4).toString('ascii') !== 'RIFF' || head.subarray(8, 12).toString('ascii') !== 'WEBP') {
        return false
      }
      const riffSize = head.readUInt32LE(4)
      return 8 + riffSize <= source.size
    }
    case '.bmp': {
      if (source.size < 14) {
        return false
      }
      const head = await source.readSlice(0, 6)
      if (head.subarray(0, 2).toString('ascii') !== 'BM') {
        return false
      }
      const bfSize = head.readUInt32LE(2)
      return bfSize >= 14 && bfSize <= source.size
    }
    case '.heic':
    case '.heif':
    case '.avif': {
      return await isCompleteIsoBmffFrom(source, 0)
    }
    default: {
      return true
    }
  }
}

export interface OriginalCacheEntry {
  buffer?: Buffer
  filePath?: string
}

export interface OriginalCacheOptions {
  invalidate?: boolean
  skipBuffer?: boolean
  expectedSize?: number
}

export async function getOriginalWithCacheEntry(
  key: string,
  fetcher: () => Promise<Buffer | null>,
  options?: OriginalCacheOptions,
): Promise<OriginalCacheEntry | null> {
  if (!cacheEnabled()) {
    const buffer = await fetcher()
    return buffer ? { buffer } : null
  }

  const filePath = resolveCachePath(key)
  if (options?.invalidate) {
    await removeWithWindowsRetry(filePath).catch(() => {})
  }
  else {
    try {
      if (options?.skipBuffer) {
        const handle = await fs.open(filePath, 'r')
        let complete = false
        try {
          const stat = await handle.stat()
          if (stat.isFile()) {
            complete = await looksCompleteSource(
              createFileHandleSource(handle, stat.size),
              key,
              options.expectedSize,
            )
          }
        }
        finally {
          await handle.close()
        }
        if (complete) {
          return { filePath }
        }
      }
      else {
        const cached = await fs.readFile(filePath)
        if (await looksCompleteSource(createBufferSource(cached), key, options?.expectedSize)) {
          return { buffer: cached, filePath }
        }
      }
      // 截断或损坏的缓存：删掉重下，否则每次重建都会在 sharp 里失败
      await removeWithWindowsRetry(filePath)
    }
    catch {
      // cache miss
    }
  }

  const buffer = await fetcher()
  if (!buffer) {
    return null
  }

  if (!(await looksCompleteSource(createBufferSource(buffer), key, options?.expectedSize))) {
    return {
      buffer: options?.skipBuffer ? undefined : buffer,
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    await fs.writeFile(tmpPath, buffer)
    await renameWithWindowsRetry(tmpPath, filePath)
  }
  finally {
    await removeWithWindowsRetry(tmpPath).catch(() => {})
  }
  return {
    buffer: options?.skipBuffer ? undefined : buffer,
    filePath,
  }
}

export async function getOriginalWithCache(
  key: string,
  fetcher: () => Promise<Buffer | null>,
): Promise<Buffer | null> {
  const entry = await getOriginalWithCacheEntry(key, fetcher)
  return entry?.buffer ?? null
}

export async function clearOriginalCache(): Promise<void> {
  await fs.rm(CACHE_DIR, { recursive: true, force: true })
}
