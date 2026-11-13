import fs from 'node:fs/promises'
import path from 'node:path'

import { workdir } from '@afilmory/builder/path.js'
import sharp from 'sharp'

import { getGlobalLoggers } from '../photo/logger-adapter.js'
import { hardForceEncode, signatureMatches, writeSignature } from './asset-signature.js'

/**
 * 阅览器占位图（preview）。
 *
 * 网格缩略图只有 600px，点开大图时它会被拉伸到整个屏幕（4K 上就是 6 倍），
 * 在原图下载完成前非常糊。preview 是介于缩略图和原图之间的一档：
 * 1600px 宽、AVIF q50，实测在 3840px 显示下 PSNR/SSIM 远高于旧的 600px 占位，
 * 而单张体积与旧占位（600px JPEG q100）基本持平甚至更小。
 */
const PREVIEW_DIR = path.join(workdir, 'public/previews')

export const PREVIEW_EXTENSION = 'avif'
export const PREVIEW_MIME_TYPE = 'image/avif'
/**
 * 长边尺寸。用「长边」而不是「宽度」：竖构图如果按宽度 2560 编，高度会到 3840
 * （9.8MP），等于给竖图白花 ~50% 的体积；按长边 2560 时竖图是 1707×2560，
 * 4K 屏上只放大约 1.26 倍，观感几乎无损。
 */
export const PREVIEW_SIZE = 2560
export const PREVIEW_QUALITY = 45

export function getPreviewFilename(photoId: string): string {
  return `${photoId}.${PREVIEW_EXTENSION}`
}

export function getPreviewPaths(photoId: string) {
  const filename = getPreviewFilename(photoId)
  const previewPath = path.join(PREVIEW_DIR, filename)
  const previewUrl = `/previews/${filename}`

  return { previewPath, previewUrl, filename }
}

export async function previewExists(photoId: string): Promise<boolean> {
  try {
    const { previewPath } = getPreviewPaths(photoId)
    await fs.access(previewPath)
    return true
  }
  catch {
    return false
  }
}

export interface PreviewResult {
  previewUrl: string | null
  previewBuffer: Buffer | null
}

export async function generatePreview(
  imageBuffer: Buffer,
  photoId: string,
  forceRegenerate = false,
  persistToDisk = true,
  limitInputPixels?: number | boolean,
): Promise<PreviewResult> {
  const { previewPath, previewUrl } = getPreviewPaths(photoId)
  const log = getGlobalLoggers().thumbnail

  // 参数签名没变且文件存在 → 直接复用；--force-thumbnails 也不会重复编码
  const signature = `inside-${PREVIEW_SIZE}q${PREVIEW_QUALITY}e6.${PREVIEW_EXTENSION}`
  const forceHard = forceRegenerate && hardForceEncode()
  if (!forceHard && (await previewExists(photoId)) && (await signatureMatches('preview', photoId, signature))) {
    try {
      return { previewUrl, previewBuffer: await fs.readFile(previewPath) }
    }
    catch (error) {
      log?.warn(`读取现有占位图失败，重新生成：${photoId}`, error)
    }
  }

  const startTime = Date.now()
  try {
    const previewBuffer = await sharp(imageBuffer, { limitInputPixels })
      .rotate()
      .resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, fit: 'inside', withoutEnlargement: true })
      .avif({ quality: PREVIEW_QUALITY, effort: 6 })
      .toBuffer()

    if (persistToDisk) {
      await fs.mkdir(PREVIEW_DIR, { recursive: true })
      await fs.writeFile(previewPath, previewBuffer)
    }

    log?.info(`生成占位图：${photoId} (${Math.round(previewBuffer.length / 1024)}KB, ${Date.now() - startTime}ms)`)
    await writeSignature('preview', photoId, signature)
    return { previewUrl, previewBuffer }
  }
  catch (error) {
    log?.error(`生成占位图失败：${photoId}`, error)
    return { previewUrl: null, previewBuffer: null }
  }
}
