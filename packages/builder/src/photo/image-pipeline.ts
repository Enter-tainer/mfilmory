import type { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PhotoManifestItem, ProcessPhotoResult } from '@afilmory/typing'
import { compressUint8Array } from '@afilmory/utils'
import type { Sharp } from 'sharp'
import sharp from 'sharp'

import type { BuilderOptions } from '../builder/builder.js'
import { hardForceEncode, signatureMatches } from '../image/asset-signature.js'
import { extractExifData, extractXmpMetadataFromExif } from '../image/exif.js'
import {
  getPreviewFilename,
  getPreviewPaths,
  PREVIEW_SIGNATURE,
  previewExists,
  savePreviewToDisk,
} from '../image/preview.js'
import {
  convertBmpToJpegSharpInstance,
  getImageMetadataWithSharp,
  isBitmap,
  preprocessImageBuffer,
} from '../image/processor.js'
import {
  getThumbnailFilename,
  getThumbnailPaths,
  saveThumbnailToDisk,
  THUMBNAIL_SIGNATURE,
  thumbnailExists,
} from '../image/thumbnail.js'
import type { PluginRunState } from '../plugins/manager.js'
import type { ThumbnailPluginData } from '../plugins/thumbnail-storage/shared.js'
import { PREVIEW_PLUGIN_DATA_KEY, THUMBNAIL_PLUGIN_DATA_KEY } from '../plugins/thumbnail-storage/shared.js'
import type { S3ObjectLike } from '../types/s3.js'
import { shouldProcessPhoto } from './cache-manager.js'
import type { CpuPhotoTaskInput, CpuPhotoTaskOutput } from './cpu-task.js'
import { runPhotoCpuTask } from './cpu-task.js'
import { getPhotoExecutionContext } from './execution-context.js'
import { detectGainMap } from './gainmap-detector.js'
import { extractPhotoInfo } from './info-extractor.js'
import { processLivePhoto } from './live-photo-handler.js'
import { getGlobalLoggers } from './logger-adapter.js'
import { detectMotionPhoto } from './motion-photo-detector.js'
import { getOriginalWithCache, getOriginalWithCacheEntry } from './original-cache.js'
import type { PhotoProcessorOptions } from './processor.js'

const EMPTY_XMP_METADATA = {
  keywords: [] as string[],
  regions: [],
}

export interface ProcessedImageData {
  sharpInstance: Sharp
  imageBuffer: Buffer
  metadata: { width: number, height: number }
}

export interface PhotoProcessingContext {
  photoKey: string
  obj: S3ObjectLike
  existingItem: PhotoManifestItem | undefined
  livePhotoMap: Map<string, S3ObjectLike>
  options: PhotoProcessorOptions
  pluginData: Record<string, unknown>
}

/**
 * 预处理图片数据
 * 包括获取原始数据、格式转换、BMP 处理等
 */
export async function preprocessImage(
  photoKey: string,
): Promise<{ rawBuffer: Buffer, processedBuffer: Buffer } | null> {
  const loggers = getGlobalLoggers()
  const { storageManager, prefetchedBuffers } = getPhotoExecutionContext()

  try {
    // 获取图片数据（优先读本地原图缓存，避免反复从 S3 下载 3GB）
    const rawImageBuffer = prefetchedBuffers?.get(photoKey)
      ?? (await getOriginalWithCache(photoKey, () => storageManager.getFile(photoKey)))
    if (!rawImageBuffer) {
      loggers.image.error(`无法获取图片数据：${photoKey}`)
      return null
    }

    // 预处理图片（处理 HEIC/HEIF 格式）
    let imageBuffer: Buffer
    try {
      imageBuffer = await preprocessImageBuffer(rawImageBuffer, photoKey)
    }
    catch (error) {
      loggers.image.error(`预处理图片失败：${photoKey}`, error)
      return null
    }

    return {
      rawBuffer: rawImageBuffer,
      processedBuffer: imageBuffer,
    }
  }
  catch (error) {
    loggers.image.error(`图片预处理失败：${photoKey}`, error)
    return null
  }
}

/**
 * 处理图片并创建 Sharp 实例
 * 包括 BMP 转换和元数据提取
 */
export async function processImageWithSharp(imageBuffer: Buffer, photoKey: string): Promise<ProcessedImageData | null> {
  const loggers = getGlobalLoggers()
  const { builder } = getPhotoExecutionContext()
  const { limitInputPixels } = builder.getConfig().system.processing

  try {
    // 创建 Sharp 实例，复用于多个操作
    let sharpInstance = sharp(imageBuffer, { limitInputPixels })
    let processedBuffer = imageBuffer

    // 处理 BMP
    if (isBitmap(imageBuffer)) {
      try {
        // Convert the BMP image to JPEG format and create a new Sharp instance for the converted image.
        sharpInstance = await convertBmpToJpegSharpInstance(imageBuffer)
        // Update the image buffer to reflect the new JPEG data from the Sharp instance.
        processedBuffer = await sharpInstance.toBuffer()
      }
      catch (error) {
        loggers.image.error(`转换 BMP 失败：${photoKey}`, error)
        return null
      }
    }

    // 获取图片元数据（复用 Sharp 实例）
    const metadata = await getImageMetadataWithSharp(sharpInstance)
    if (!metadata) {
      loggers.image.error(`获取图片元数据失败：${photoKey}`)
      return null
    }

    return {
      sharpInstance,
      imageBuffer: processedBuffer,
      metadata,
    }
  }
  catch (error) {
    loggers.image.error(`Sharp 处理失败：${photoKey}`, error)
    return null
  }
}

/**
 * 生成带摘要后缀的 ID
 * @param s3Key S3 键
 * @returns 带摘要后缀的 ID
 */
async function generatePhotoId(s3Key: string): Promise<string> {
  const { builder } = getPhotoExecutionContext()
  const {
    system: {
      processing: { digestSuffixLength },
    },
  } = builder.getConfig()
  if (!digestSuffixLength || digestSuffixLength <= 0) {
    return path.basename(s3Key, path.extname(s3Key))
  }

  const baseName = path.basename(s3Key, path.extname(s3Key))
  const sha256 = crypto.createHash('sha256').update(s3Key).digest('hex')
  const digestSuffix = sha256.slice(0, digestSuffixLength)
  return `${baseName}_${digestSuffix}`
}

export interface PhotoPipelineRuntime {
  runState: PluginRunState
  builderOptions: BuilderOptions
  releaseStage1Gate?: () => void
}

function releasePluginDataBuffers(pluginData: Record<string, unknown>): void {
  for (const key of [THUMBNAIL_PLUGIN_DATA_KEY, PREVIEW_PLUGIN_DATA_KEY]) {
    const entry = pluginData[key] as ThumbnailPluginData | undefined
    if (entry && 'buffer' in entry) {
      entry.buffer = null
    }
  }
}

/**
 * 完整的照片处理管道
 * 整合下载、EXIF、纯 CPU 处理与磁盘产物保存，上传与地理编码在外部/插件异步推进
 */
export async function executePhotoProcessingPipeline(
  context: PhotoProcessingContext,
  runtime?: PhotoPipelineRuntime,
): Promise<PhotoManifestItem | null> {
  const { photoKey, obj, existingItem, livePhotoMap, options } = context
  const { builder, storageManager, prefetchedBuffers, pools } = getPhotoExecutionContext()
  const loggers = getGlobalLoggers()
  const { limitInputPixels } = builder.getConfig().system.processing
  // Generate the actual photo ID with digest suffix
  const photoId = await generatePhotoId(photoKey)

  try {
    const forceHardThumb = (options.isForceMode || options.isForceThumbnails) && hardForceEncode()
    const fileReplaced = Boolean(existingItem && existingItem.lastModified !== obj.LastModified?.toISOString())
    const forceReextract = options.isForceMode || options.isForceManifest || fileReplaced

    const thumbnailPaths = getThumbnailPaths(photoId)
    const previewPaths = getPreviewPaths(photoId)

    let reusableThumbBuffer: Buffer | null = null
    let reusableThumbHash = false
    if (!fileReplaced && !forceHardThumb && (await thumbnailExists(photoId))) {
      const canReuseFromManifest
        = !options.isForceMode && !options.isForceThumbnails && Boolean(existingItem?.thumbHash)
      const canReuseFromSignature
        = canReuseFromManifest || (await signatureMatches('thumbnail', photoId, THUMBNAIL_SIGNATURE))

      if (canReuseFromSignature) {
        try {
          reusableThumbBuffer = await fs.readFile(thumbnailPaths.thumbnailPath)
          reusableThumbHash = canReuseFromManifest
          loggers.thumbnail.info(`复用现有缩略图：${photoId}`)
          if (reusableThumbHash) {
            loggers.blurhash.info(`复用现有 blurhash: ${photoId}`)
          }
        }
        catch (error) {
          loggers.thumbnail.warn(`读取现有缩略图失败，重新生成：${photoId}`, error)
        }
      }
    }

    let reusablePreviewBuffer: Buffer | null = null
    if (
      !fileReplaced
      && !forceHardThumb
      && (await previewExists(photoId))
      && (await signatureMatches('preview', photoId, PREVIEW_SIGNATURE))
    ) {
      try {
        reusablePreviewBuffer = await fs.readFile(previewPaths.previewPath)
      }
      catch (error) {
        loggers.thumbnail.warn(`读取现有占位图失败，重新生成：${photoId}`, error)
      }
    }

    const needThumbnail = reusableThumbBuffer === null
    const needBlurhash = needThumbnail || !reusableThumbHash
    const needPreview = reusablePreviewBuffer === null
    const needMetadata = forceReextract || !existingItem?.width || !existingItem?.height || !existingItem?.digest
    const needExif = forceReextract || !existingItem?.exif
    const needToneAnalysis = forceReextract || !existingItem?.toneAnalysis

    if (!needExif) {
      loggers.exif.info(`复用现有 EXIF 数据：${photoId}`)
    }
    if (!needToneAnalysis) {
      loggers.tone.info(`复用现有影调分析：${photoId}`)
    }

    const needsOriginalDecode = needMetadata || needThumbnail || needPreview || needToneAnalysis
    const cachedExifRecord = !needExif
      ? (existingItem?.exif as unknown as Record<string, unknown> | undefined)
      : undefined
    const mayNeedMotionRaw
      = existingItem?.video?.type === 'motion-photo'
        || Boolean(
          cachedExifRecord
          && (cachedExifRecord.MotionPhoto || cachedExifRecord.MicroVideo || cachedExifRecord.ContainerDirectory),
        )
    const needsOriginalFile = needsOriginalDecode || needExif || mayNeedMotionRaw

    let rawBuffer: Buffer | undefined = prefetchedBuffers?.get(photoKey)
    let rawFilePath: string | undefined

    if (needsOriginalFile && !rawBuffer) {
      const fetchOriginal = () => storageManager.getFile(photoKey)
      const cachedEntry = await getOriginalWithCacheEntry(photoKey, () =>
        pools ? pools.network.download(fetchOriginal) : fetchOriginal())
      if (!cachedEntry) {
        loggers.image.error(`无法获取图片数据：${photoKey}`)
        return null
      }
      rawBuffer = cachedEntry.buffer
      rawFilePath = cachedEntry.filePath
    }

    const needsCpuTask = needsOriginalDecode || needBlurhash
    const cpuPromise: Promise<CpuPhotoTaskOutput> = needsCpuTask
      ? (() => {
          const sendPathOnly = Boolean(rawFilePath && pools?.cpu.plan.mode === 'cpu-worker')
          const cpuInput: CpuPhotoTaskInput = {
            photoKey,
            photoId,
            rawBuffer: sendPathOnly ? undefined : rawBuffer,
            rawFilePath,
            existingThumbnailPath: !needThumbnail && needBlurhash ? thumbnailPaths.thumbnailPath : undefined,
            limitInputPixels,
            needMetadata,
            needThumbnail,
            needBlurhash,
            needPreview,
            needToneAnalysis,
          }
          return pools ? pools.cpu.runPhotoTask(cpuInput) : runPhotoCpuTask(cpuInput)
        })()
      : Promise.resolve({
          contentDigest: null,
          metadata: null,
          thumbnailBuffer: null,
          thumbHash: null,
          previewBuffer: null,
          toneAnalysis: null,
        })

    const exifPromise = (async () => {
      const exif = needExif ? await extractExifData(rawBuffer!, rawBuffer, rawFilePath) : (existingItem?.exif ?? null)
      if (runtime) {
        await builder.emitPluginEvent(runtime.runState, 'onExifExtracted', {
          options: runtime.builderOptions,
          context,
          itemId: photoId,
          photoKey,
          exif,
          existingItem,
        })
      }
      return exif
    })()

    const livePhotoPromise = processLivePhoto(photoKey, livePhotoMap, storageManager)
    const originalUrlPromise = storageManager.generatePublicUrl(photoKey)

    const [cpuResult, exifData, livePhotoResult, originalUrl] = await Promise.all([
      cpuPromise,
      exifPromise,
      livePhotoPromise,
      originalUrlPromise,
    ])

    const metadata = needMetadata ? cpuResult.metadata : { width: existingItem!.width, height: existingItem!.height }
    if (!metadata) {
      loggers.image.error(`获取图片元数据失败：${photoKey}`)
      return null
    }
    const contentDigest = needMetadata ? (cpuResult.contentDigest ?? existingItem?.digest ?? '') : existingItem!.digest

    const finalThumbnailBuffer = cpuResult.thumbnailBuffer ?? reusableThumbBuffer
    const finalThumbnailUrl = finalThumbnailBuffer
      ? cpuResult.thumbnailBuffer && !options.dryRun
        ? await saveThumbnailToDisk(photoId, cpuResult.thumbnailBuffer)
        : thumbnailPaths.thumbnailUrl
      : null

    if (cpuResult.thumbnailBuffer) {
      loggers.thumbnail.success(`缩略图生成完成：${photoId} (${Math.round(cpuResult.thumbnailBuffer.length / 1024)}KB)`)
    }

    if (finalThumbnailBuffer && finalThumbnailUrl) {
      context.pluginData[THUMBNAIL_PLUGIN_DATA_KEY] = {
        photoId,
        fileName: getThumbnailFilename(photoId),
        buffer: finalThumbnailBuffer,
        localUrl: finalThumbnailUrl,
      }
    }

    const finalPreviewBuffer = cpuResult.previewBuffer ?? reusablePreviewBuffer
    const finalPreviewUrl = finalPreviewBuffer
      ? cpuResult.previewBuffer && !options.dryRun
        ? await savePreviewToDisk(photoId, cpuResult.previewBuffer)
        : previewPaths.previewUrl
      : null

    if (cpuResult.previewBuffer) {
      loggers.thumbnail.info(`生成占位图：${photoId} (${Math.round(cpuResult.previewBuffer.length / 1024)}KB)`)
    }

    if (finalPreviewBuffer && finalPreviewUrl) {
      context.pluginData[PREVIEW_PLUGIN_DATA_KEY] = {
        photoId,
        fileName: getPreviewFilename(photoId),
        buffer: finalPreviewBuffer,
        localUrl: finalPreviewUrl,
      }
    }

    const exiftoolXmpMetadata
      = options.xmpKeywordsEnabled || options.xmpRegionsEnabled
        ? extractXmpMetadataFromExif(exifData)
        : EMPTY_XMP_METADATA
    const xmpKeywords = options.xmpKeywordsEnabled ? exiftoolXmpMetadata.keywords : []
    const xmpRegions = options.xmpRegionsEnabled ? exiftoolXmpMetadata.regions : []

    // 5. 检测 HDR GainMap（Ultra HDR 图片）
    const hasGainMap = detectGainMap({
      exifData: exifData as unknown as Record<string, unknown> | null,
    })

    // 6. 检测 Motion Photo（从图片中提取嵌入视频的元数据）
    const motionPhotoMetadata = rawBuffer
      ? detectMotionPhoto({
          rawImageBuffer: rawBuffer,
          exifData: exifData as unknown as Record<string, unknown> | null,
        })
      : null

    // 释放原图大 buffer 引用，后续阶段只保留缩略图/占位图供上传插件使用
    rawBuffer = undefined

    // 检测冲突：不允许同时存在 Motion Photo 和 Live Photo
    if (motionPhotoMetadata?.isMotionPhoto && livePhotoResult.isLivePhoto) {
      const errorMsg = `❌ 检测到同时存在 Motion Photo (嵌入视频) 和 Live Photo (独立视频文件)：${photoKey}。这是不允许的，请只保留一种格式。`
      loggers.image.error(errorMsg)
      throw new Error(errorMsg)
    }

    // 8. 处理影调分析
    const toneAnalysis = needToneAnalysis ? cpuResult.toneAnalysis : (existingItem?.toneAnalysis ?? null)

    // 9. 提取照片信息
    const photoInfo = extractPhotoInfo(photoKey, exifData)

    // 10. 构建照片清单项
    const aspectRatio = metadata.width / metadata.height
    const extension = path.extname(photoKey).slice(1).toUpperCase()
    const thumbHash = cpuResult.thumbHash
      ? compressUint8Array(cpuResult.thumbHash)
      : reusableThumbHash
        ? (existingItem?.thumbHash ?? null)
        : null

    const photoItem: PhotoManifestItem = {
      id: photoId,
      format: extension || 'UNKNOWN',
      title: photoInfo.title,
      description: photoInfo.description,
      dateTaken: photoInfo.dateTaken,
      tags: options.xmpKeywordsEnabled ? mergeUniqueTags(photoInfo.tags, xmpKeywords) : photoInfo.tags,
      originalUrl,
      thumbnailUrl: finalThumbnailUrl ?? thumbnailPaths.thumbnailUrl,
      previewUrl: finalPreviewUrl,
      thumbHash,
      width: metadata.width,
      height: metadata.height,
      aspectRatio,
      s3Key: photoKey,
      lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
      size: obj.Size || 0,
      digest: contentDigest,
      exif: exifData,
      keywords: xmpKeywords,
      regions: xmpRegions,
      toneAnalysis,
      location: existingItem?.location ?? null,
      // Video source (Motion Photo or Live Photo)
      video:
        motionPhotoMetadata?.isMotionPhoto && motionPhotoMetadata.motionPhotoOffset !== undefined
          ? {
              type: 'motion-photo',
              offset: motionPhotoMetadata.motionPhotoOffset,
              size: motionPhotoMetadata.motionPhotoVideoSize,
              presentationTimestamp: motionPhotoMetadata.presentationTimestampUs,
            }
          : livePhotoResult.isLivePhoto
            ? {
                type: 'live-photo',
                videoUrl: livePhotoResult.livePhotoVideoUrl!,
                s3Key: livePhotoResult.livePhotoVideoS3Key!,
              }
            : undefined,
      // HDR 相关字段
      isHDR:
        exifData?.MPImageType === 'Gain Map Image'
        || exifData?.UniformResourceName === 'urn:iso:std:iso:ts:21496:-1'
        || hasGainMap,
    }

    loggers.image.success(`✅ 处理完成：${photoKey}`)
    return photoItem
  }
  catch (error) {
    loggers.image.error(`❌ 处理管道失败：${photoKey}`, error)
    return null
  }
}

function mergeUniqueTags(...groups: string[][]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const group of groups) {
    for (const value of group) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) {
        continue
      }

      seen.add(normalized)
      merged.push(normalized)
    }
  }

  return merged
}

/**
 * 决定是否需要处理照片并返回处理结果
 */
export async function processPhotoWithPipeline(
  context: PhotoProcessingContext,
  runtime: PhotoPipelineRuntime,
): Promise<{
  item: PhotoManifestItem | null
  type: 'new' | 'processed' | 'skipped' | 'failed'
  pluginData: Record<string, unknown>
}> {
  const { photoKey, existingItem, obj, options } = context
  const { builder } = getPhotoExecutionContext()
  const loggers = getGlobalLoggers()

  let stage1Released = false
  const releaseStage1 = () => {
    if (!stage1Released) {
      stage1Released = true
      runtime.releaseStage1Gate?.()
    }
  }

  const photoId = await generatePhotoId(photoKey)

  try {
    await builder.emitPluginEvent(runtime.runState, 'beforePhotoProcess', {
      options: runtime.builderOptions,
      context,
    })

    // 检查是否需要处理
    const { shouldProcess, reason } = await shouldProcessPhoto(photoId, existingItem, obj, options)

    if (!shouldProcess) {
      releaseStage1()
      loggers.image.info(`⏭️ 跳过处理 (${reason}): ${photoKey}`)
      const result = {
        item: existingItem ?? null,
        type: 'skipped' as const,
        pluginData: context.pluginData,
      }
      await builder.emitPluginEvent(runtime.runState, 'afterPhotoProcess', {
        options: runtime.builderOptions,
        context,
        result,
      })
      releasePluginDataBuffers(context.pluginData)
      return result
    }

    // 记录处理原因
    const isNewPhoto = !existingItem
    if (isNewPhoto) {
      loggers.image.info(`🆕 新照片：${photoKey}`)
    }
    else {
      loggers.image.info(`🔄 更新照片 (${reason})：${photoKey}`)
    }

    let processedItem: PhotoManifestItem | null = null
    let resultType: ProcessPhotoResult['type'] = isNewPhoto ? 'new' : 'processed'

    try {
      processedItem = await executePhotoProcessingPipeline(context, runtime)
      if (!processedItem) {
        resultType = 'failed'
      }
    }
    catch (error) {
      releaseStage1()
      await builder.emitPluginEvent(runtime.runState, 'photoProcessError', {
        options: runtime.builderOptions,
        context,
        error,
      })
      loggers.image.error(`❌ 处理过程中发生异常：${photoKey}`, error)
      processedItem = null
      resultType = 'failed'
    }
    finally {
      releaseStage1()
    }

    const result = {
      item: processedItem,
      type: resultType,
      pluginData: context.pluginData,
    }

    await builder.emitPluginEvent(runtime.runState, 'afterPhotoProcess', {
      options: runtime.builderOptions,
      context,
      result,
    })
    releasePluginDataBuffers(context.pluginData)

    return result
  }
  finally {
    releaseStage1()
  }
}
