import type { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import type { ImageMetadata, ToneAnalysis } from '@afilmory/typing'
import type { Sharp } from 'sharp'
import sharp from 'sharp'

import { generateBlurhash } from '../image/blurhash.js'
import { calculateHistogramAndAnalyzeTone } from '../image/histogram.js'
import { encodePreviewBuffer } from '../image/preview.js'
import {
  convertBmpToJpegSharpInstance,
  getImageMetadataWithSharp,
  isBitmap,
  preprocessImageBuffer,
} from '../image/processor.js'
import { encodeThumbnailBuffer } from '../image/thumbnail.js'
import { renderPhotoOgImage } from '../plugins/og-image-storage/photo-og.js'

export interface CpuPhotoTaskInput {
  photoKey: string
  photoId: string
  rawBuffer?: Buffer
  rawFilePath?: string
  existingThumbnailPath?: string
  limitInputPixels?: number | boolean
  needMetadata: boolean
  needThumbnail: boolean
  needBlurhash: boolean
  needPreview: boolean
  needToneAnalysis: boolean
}

export interface CpuPhotoTaskOutput {
  contentDigest: string | null
  metadata: ImageMetadata | null
  thumbnailBuffer: Buffer | null
  thumbHash: Uint8Array | null
  previewBuffer: Buffer | null
  toneAnalysis: ToneAnalysis | null
}

async function decodeToSharpInput(
  rawBuffer: Buffer,
  photoKey: string,
  limitInputPixels?: number | boolean,
): Promise<{ imageBuffer: Buffer, sharpInstance: Sharp }> {
  let imageBuffer = await preprocessImageBuffer(rawBuffer, photoKey)
  let sharpInstance = sharp(imageBuffer, { limitInputPixels })

  if (isBitmap(imageBuffer)) {
    sharpInstance = await convertBmpToJpegSharpInstance(imageBuffer, limitInputPixels)
    imageBuffer = await sharpInstance.toBuffer()
  }

  return { imageBuffer, sharpInstance }
}

/**
 * 纯 CPU 照片处理任务（解码 / 旋转 / 缩放 / AVIF 编码 / Blurhash / 影调直方图）。
 * 不包含任何存储网络请求、ExifTool、地理编码或磁盘产物写入，可在子进程安全执行。
 */
export async function runPhotoCpuTask(input: CpuPhotoTaskInput): Promise<CpuPhotoTaskOutput> {
  const needsOriginalDecode
    = input.needMetadata || input.needThumbnail || input.needPreview || input.needToneAnalysis

  let contentDigest: string | null = null
  let metadata: ImageMetadata | null = null
  let thumbnailBuffer: Buffer | null = null
  let thumbHash: Uint8Array | null = null
  let previewBuffer: Buffer | null = null
  let toneAnalysis: ToneAnalysis | null = null

  if (needsOriginalDecode) {
    const rawBuffer = input.rawBuffer ?? (input.rawFilePath ? await fs.readFile(input.rawFilePath) : null)
    if (!rawBuffer) {
      throw new Error(`CPU task missing raw input for ${input.photoKey}`)
    }

    const { imageBuffer, sharpInstance } = await decodeToSharpInput(
      rawBuffer,
      input.photoKey,
      input.limitInputPixels,
    )

    if (input.needMetadata) {
      metadata = await getImageMetadataWithSharp(sharpInstance)
      if (!metadata) {
        throw new Error(`获取图片元数据失败：${input.photoKey}`)
      }
      contentDigest = crypto.createHash('sha256').update(imageBuffer).digest('hex')
    }

    if (input.needThumbnail) {
      thumbnailBuffer = await encodeThumbnailBuffer(imageBuffer, input.limitInputPixels)
      if (input.needBlurhash) {
        thumbHash = await generateBlurhash(thumbnailBuffer, input.limitInputPixels)
      }
    }

    if (input.needPreview) {
      previewBuffer = await encodePreviewBuffer(imageBuffer, input.limitInputPixels)
    }

    if (input.needToneAnalysis) {
      toneAnalysis = await calculateHistogramAndAnalyzeTone(sharpInstance)
    }
  }

  if (!input.needThumbnail && input.needBlurhash && input.existingThumbnailPath) {
    try {
      const existingThumbBuffer = await fs.readFile(input.existingThumbnailPath)
      thumbHash = await generateBlurhash(existingThumbBuffer, input.limitInputPixels)
    }
    catch {
      const rawBuffer = input.rawBuffer ?? (input.rawFilePath ? await fs.readFile(input.rawFilePath) : null)
      if (rawBuffer) {
        const { imageBuffer: fallbackImageBuffer } = await decodeToSharpInput(
          rawBuffer,
          input.photoKey,
          input.limitInputPixels,
        )
        const fallbackThumbBuffer = await encodeThumbnailBuffer(fallbackImageBuffer, input.limitInputPixels)
        thumbnailBuffer = fallbackThumbBuffer
        thumbHash = await generateBlurhash(fallbackThumbBuffer, input.limitInputPixels)
      }
    }
  }

  return {
    contentDigest,
    metadata,
    thumbnailBuffer,
    thumbHash,
    previewBuffer,
    toneAnalysis,
  }
}

export interface CpuOgRenderInput {
  buffer: Buffer
}

export async function runOgRenderTask(input: CpuOgRenderInput): Promise<Buffer> {
  return await renderPhotoOgImage(input.buffer)
}
