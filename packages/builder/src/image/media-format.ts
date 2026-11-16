import fs from 'node:fs/promises'
import path from 'node:path'

import { workdir } from '@afilmory/builder/path.js'

import { PREVIEW_BITDEPTH, PREVIEW_QUALITY, PREVIEW_SIZE } from './preview.js'
import { THUMBNAIL_BITDEPTH, THUMBNAIL_QUALITY, THUMBNAIL_WIDTH } from './thumbnail.js'

/**
 * 产物编码参数的「格式版本」。
 *
 * 缩略图 / 占位图的文件名不含参数（`<photoId>.avif`），所以照片处理完之后，
 * 光看文件在不在无法判断它是不是用当前参数编的——改位深、改质量这类改动会
 * 被静默跳过（历史上就踩过：以为签名会触发重编码，实际入口门禁只 stat 了文件）。
 *
 * 这里用一个**全局版本标记**兜住这类改动：参数变了 → 常量变化 → 标记失配 →
 * 本次构建把全部照片重新排进队列；构建成功后再把标记写上。
 * 单文件、单写者，不涉及每张照片的并发写。
 *
 * 注意：改了任何影响像素的编码参数（`THUMBNAIL_*` / `PREVIEW_*`）都要让它体现在
 * 这个串里，否则老产物会被当成新的。
 */
export const MEDIA_FORMAT_VERSION = [
  `thumb${THUMBNAIL_WIDTH}q${THUMBNAIL_QUALITY}b${THUMBNAIL_BITDEPTH}`,
  `preview${PREVIEW_SIZE}q${PREVIEW_QUALITY}b${PREVIEW_BITDEPTH}`,
].join('-')

const MARKER_PATH = path.join(workdir, 'src/data/.cache/media-format-version')

export async function isMediaFormatCurrent(): Promise<boolean> {
  try {
    return (await fs.readFile(MARKER_PATH, 'utf8')).trim() === MEDIA_FORMAT_VERSION
  }
  catch {
    return false
  }
}

export async function markMediaFormatCurrent(): Promise<void> {
  await fs.mkdir(path.dirname(MARKER_PATH), { recursive: true })
  await fs.writeFile(MARKER_PATH, MEDIA_FORMAT_VERSION)
}
