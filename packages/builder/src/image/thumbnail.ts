import fs from 'node:fs/promises'
import path from 'node:path'

import { workdir } from '@afilmory/builder/path.js'
import type { ThumbnailResult } from '@afilmory/typing'
import sharp from 'sharp'

import { getGlobalLoggers } from '../photo/logger-adapter.js'
import { hardForceEncode, signatureMatches, writeSignature } from './asset-signature.js'
import { generateBlurhash } from './blurhash.js'

// 常量定义
const THUMBNAIL_DIR = path.join(workdir, 'public/thumbnails')

/**
 * 缩略图输出格式。
 *
 * AVIF 在 600px 宽下的实测（PSNR/SSIM vs 无损重采样）与原来的 JPEG q100 持平甚至更好，
 * 体积约为其 40%；浏览器原生解码（Chrome 85+ / Safari 16.4+ / Firefox 93+），
 * 所以前端不需要任何转换逻辑。
 */
export const THUMBNAIL_EXTENSION = 'avif'
export const THUMBNAIL_MIME_TYPE = 'image/avif'
export const THUMBNAIL_QUALITY = 70
/**
 * 网格一格的实际物理像素（按 MasonryView 的列宽算法 + 常见 DPR 推算）：
 * 手机 2 列 150 CSS @3x ≈ 450px；iPad/Mac 250 CSS @2x = 500px；4K@150% 约 469px。
 * 常见设备最大约 500 物理像素，所以 512 足够（再小会在 MacBook/iPad @2x 上露馅）。
 */
export const THUMBNAIL_WIDTH = 500

/** 缩略图文件名。所有调用方都应走这里，不要再硬编码扩展名（上游 #259）。 */
export function getThumbnailFilename(photoId: string): string {
  return `${photoId}.${THUMBNAIL_EXTENSION}`
}

// 获取缩略图路径信息
export function getThumbnailPaths(photoId: string) {
  const filename = getThumbnailFilename(photoId)
  const thumbnailPath = path.join(THUMBNAIL_DIR, filename)
  const thumbnailUrl = `/thumbnails/${filename}`

  return { thumbnailPath, thumbnailUrl, filename }
}

// 创建失败结果
function createFailureResult(): ThumbnailResult {
  return {
    thumbnailUrl: null,
    thumbnailBuffer: null,
    thumbHash: null,
  }
}

// 创建成功结果
function createSuccessResult(
  thumbnailUrl: string,
  thumbnailBuffer: Buffer,
  thumbHash: Uint8Array | null,
): ThumbnailResult {
  return {
    thumbnailUrl,
    thumbnailBuffer,
    thumbHash,
  }
}

// 确保缩略图目录存在
async function ensureThumbnailDir(): Promise<void> {
  await fs.mkdir(THUMBNAIL_DIR, { recursive: true })
}

// 检查缩略图是否存在
export async function thumbnailExists(photoId: string): Promise<boolean> {
  try {
    const { thumbnailPath } = getThumbnailPaths(photoId)
    await fs.access(thumbnailPath)
    return true
  } catch {
    return false
  }
}

// 读取现有缩略图并生成 blurhash
async function processExistingThumbnail(photoId: string): Promise<ThumbnailResult | null> {
  const { thumbnailPath, thumbnailUrl } = getThumbnailPaths(photoId)

  const thumbnailLog = getGlobalLoggers().thumbnail
  thumbnailLog.info(`复用现有缩略图：${photoId}`)

  try {
    const existingBuffer = await fs.readFile(thumbnailPath)
    const thumbHash = await generateBlurhash(existingBuffer)

    return createSuccessResult(thumbnailUrl, existingBuffer, thumbHash)
  } catch (error) {
    thumbnailLog?.warn(`读取现有缩略图失败，重新生成：${photoId}`, error)
    return null
  }
}

// 生成新的缩略图
async function generateNewThumbnail(
  imageBuffer: Buffer,
  photoId: string,
  persistToDisk = true,
  limitInputPixels?: number | boolean,
): Promise<ThumbnailResult> {
  const { thumbnailPath, thumbnailUrl } = getThumbnailPaths(photoId)

  const log = getGlobalLoggers().thumbnail
  log.info(`生成缩略图：${photoId}`)
  const startTime = Date.now()

  try {
    // 创建 Sharp 实例，复用于缩略图和 blurhash 生成
    const sharpInstance = sharp(imageBuffer, { limitInputPixels }).rotate() // 自动根据 EXIF 旋转

    // 生成缩略图
    const thumbnailBuffer = await sharpInstance
      .clone() // 克隆实例用于缩略图生成
      .resize(THUMBNAIL_WIDTH, null, {
        withoutEnlargement: true,
      })
      .avif({ quality: THUMBNAIL_QUALITY, effort: 6 })
      .toBuffer()

    // 保存到文件
    if (persistToDisk) {
      await fs.writeFile(thumbnailPath, thumbnailBuffer)
    }

    // 记录生成信息
    const duration = Date.now() - startTime
    const sizeKB = Math.round(thumbnailBuffer.length / 1024)
    log.success(`生成完成：${photoId} (${sizeKB}KB, ${duration}ms)`)

    // 基于生成的缩略图生成 blurhash
    const thumbHash = await generateBlurhash(thumbnailBuffer)

    return createSuccessResult(thumbnailUrl, thumbnailBuffer, thumbHash)
  } catch (error) {
    log.error(`生成失败：${photoId}`, error)
    return createFailureResult()
  }
}

// 生成缩略图和 blurhash（复用 Sharp 实例）
export async function generateThumbnailAndBlurhash(
  imageBuffer: Buffer,
  photoId: string,
  forceRegenerate = false,
  persistToDisk = true,
  limitInputPixels?: number | boolean,
): Promise<ThumbnailResult> {
  const thumbnailLog = getGlobalLoggers().thumbnail

  try {
    if (persistToDisk) {
      await ensureThumbnailDir()
    }

    // 参数签名没变且文件存在 → 直接复用；--force-thumbnails 也不会重复编码
    const signature = `${THUMBNAIL_WIDTH}q${THUMBNAIL_QUALITY}e6.${THUMBNAIL_EXTENSION}`
    const forceHard = forceRegenerate && hardForceEncode()
    if (!forceHard && (await thumbnailExists(photoId)) && (await signatureMatches('thumbnail', photoId, signature))) {
      const existingResult = await processExistingThumbnail(photoId)

      if (existingResult) {
        return existingResult
      }
      // 如果处理现有缩略图失败，继续生成新的
    }

    // 生成新的缩略图
    const result = await generateNewThumbnail(imageBuffer, photoId, persistToDisk, limitInputPixels)
    if (result.thumbnailBuffer) {
      await writeSignature('thumbnail', photoId, signature)
    }
    return result
  } catch (error) {
    thumbnailLog.error(`处理失败：${photoId}`, error)
    return createFailureResult()
  }
}
