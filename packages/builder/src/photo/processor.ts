import type { PhotoManifestItem, ProcessPhotoResult } from '@afilmory/typing'

import type { AfilmoryBuilder, BuilderOptions } from '../builder/builder.js'
import { logger } from '../logger/index.js'
import type { PluginRunState } from '../plugins/manager.js'
import type { S3ObjectLike } from '../types/s3.js'
import { createStorageKeyNormalizer, runWithPhotoExecutionContext } from './execution-context.js'
import type { PhotoProcessingContext } from './image-pipeline.js'
import { processPhotoWithPipeline } from './image-pipeline.js'
import { createPhotoProcessingLoggers } from './logger-adapter.js'

export interface PhotoProcessorOptions {
  isForceMode: boolean
  isForceManifest: boolean
  isForceThumbnails: boolean
  xmpKeywordsEnabled: boolean
  xmpRegionsEnabled: boolean
  dryRun?: boolean
  /**
   * 媒体格式版本（宽度 / 质量 / 位深）已变化：所有照片都要重新生成缩略图 / 占位图。
   *
   * 必须一路传到 `shouldProcessPhoto()`：那一层才是真正的入口，只把照片排进队列
   * 而不放行这一层，照片会在开始处理前被判成「无需处理」，marker 却已经被写上新值。
   */
  mediaFormatStale?: boolean
}

// 处理单张照片
export async function processPhoto(
  obj: S3ObjectLike,
  index: number,
  workerId: number,
  totalImages: number,
  existingManifestMap: Map<string, PhotoManifestItem>,
  livePhotoMap: Map<string, S3ObjectLike>,
  options: PhotoProcessorOptions,
  builder: AfilmoryBuilder,
  pluginRuntime: {
    runState: PluginRunState
    builderOptions: BuilderOptions
  },
): Promise<ProcessPhotoResult> {
  const key = obj.Key
  if (!key) {
    logger.image.warn(`跳过没有 Key 的对象`)
    return { item: null, type: 'failed' }
  }

  const existingItem = existingManifestMap.get(key)

  // 构建处理上下文
  const context: PhotoProcessingContext = {
    photoKey: key,
    obj,
    existingItem,
    livePhotoMap,
    options,
    pluginData: {},
  }

  const storageManager = builder.getStorageManager()
  const storageConfig = builder.getStorageConfig()
  const photoLoggers = createPhotoProcessingLoggers(workerId, logger)

  return await runWithPhotoExecutionContext(
    {
      builder,
      storageManager,
      storageConfig,
      normalizeStorageKey: createStorageKeyNormalizer(storageConfig),
      loggers: photoLoggers,
    },
    async () => {
      photoLoggers.image.info(`📸 [${index + 1}/${totalImages}] ${key}`)

      // 使用处理管道
      return await processPhotoWithPipeline(context, pluginRuntime)
    },
  )
}
