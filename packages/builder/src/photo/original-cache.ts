import fs from 'node:fs/promises'
import path from 'node:path'

import { workdir } from '@afilmory/builder/path.js'

/**
 * 原图磁盘缓存。
 *
 * 每次 `--force-*` 重建都要从 S3 重新下载全部原图（这个库是 3.1GB），
 * 在本地反复调参时纯属浪费。这里把下载过的原图缓存到
 * `apps/web/src/data/.cache/originals/`（该目录本来就在 .gitignore 里），
 * 命中就不走网络。
 *
 * 缓存只按对象 key 存，不带过期：对象被替换（同名新文件）时缓存会旧。
 * 需要干净结果时用 MFILMORY_NO_ORIGINAL_CACHE=1 跑一次，或直接删缓存目录。
 */
const CACHE_DIR = path.join(workdir, 'src/data/.cache/originals')

function cacheEnabled(): boolean {
  return process.env.MFILMORY_NO_ORIGINAL_CACHE !== '1'
}

/**
 * 判断缓存下来的字节是不是一张完整的图。
 *
 * 实测踩到的坑：S3 GET 被中断时能拿到截断的 body（本机出现过一批正好
 * 524288 字节的半个 JPEG），缓存下来之后每次重建都在 sharp 里报
 * `VipsJpeg: premature end of JPEG image`，而且因为缓存命中会一直复现。
 * 这里做一次极廉价的完整性检查：JPEG 必须以 FFD9 结尾。
 */
function looksComplete(buffer: Buffer, key: string): boolean {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') {
    if (buffer.length < 4) return false
    return buffer[buffer.length - 2] === 0xFF && buffer[buffer.length - 1] === 0xD9
  }
  return buffer.length > 0
}

export async function getOriginalWithCache(
  key: string,
  fetcher: () => Promise<Buffer | null>,
): Promise<Buffer | null> {
  if (!cacheEnabled()) {
    return fetcher()
  }

  const filePath = path.join(CACHE_DIR, key)
  try {
    const cached = await fs.readFile(filePath)
    if (looksComplete(cached, key)) {
      return cached
    }
    // 截断的缓存：删掉重下，否则每次重建都会在 sharp 里失败
    await fs.rm(filePath, { force: true })
  }
  catch {
    // cache miss
  }

  const buffer = await fetcher()
  if (buffer) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, buffer)
  }
  return buffer
}

export async function clearOriginalCache(): Promise<void> {
  await fs.rm(CACHE_DIR, { recursive: true, force: true })
}
