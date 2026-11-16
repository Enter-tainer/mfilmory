import process from 'node:process'

import type { AfilmoryManifest, CameraInfo, LensInfo, PhotoManifestItem, ProcessPhotoResult } from '@afilmory/typing'
import { Semaphore } from '@afilmory/utils'

import { flushSignatures, setSignatureBatchMode } from '../image/asset-signature.js'
import { shutdownExiftool } from '../image/exif.js'
import { isMediaFormatCurrent, markMediaFormatCurrent } from '../image/media-format.js'
import { previewExists } from '../image/preview.js'
import { thumbnailExists } from '../image/thumbnail.js'
import { logger } from '../logger/index.js'
import { handleDeletedPhotos, loadExistingManifest, needsUpdate, saveManifest } from '../manifest/manager.js'
import { CURRENT_MANIFEST_VERSION } from '../manifest/version.js'
import type { BuilderRuntimePools } from '../photo/execution-context.js'
import { computePhotoId, releasePluginDataBuffers } from '../photo/image-pipeline.js'
import type { PhotoProcessorOptions } from '../photo/processor.js'
import { processPhoto } from '../photo/processor.js'
import type { PluginRunState } from '../plugins/manager.js'
import { PluginManager } from '../plugins/manager.js'
import type {
  BuilderPluginConfigEntry,
  BuilderPluginESMImporter,
  BuilderPluginEventPayloads,
} from '../plugins/types.js'
import type { StorageProviderFactory, StorageProviderRegistrationOptions } from '../storage/factory.js'
import type { StorageConfig } from '../storage/index.js'
import { StorageFactory, StorageManager } from '../storage/index.js'
import type { BuilderConfig, UserBuilderSettings } from '../types/config.js'
import { CpuPool } from '../worker/cpu-pool.js'
import { NetworkPool } from '../worker/network-pool.js'

export interface BuilderOptions {
  isForceMode: boolean
  isForceManifest: boolean
  isForceThumbnails: boolean
  dryRun?: boolean
  keyRegex?: string
  concurrencyLimit?: number // 可选，如果未提供则使用配置文件中的默认值
  progressListener?: BuildProgressListener
  signal?: AbortSignal
}

export interface BuilderResult {
  hasUpdates: boolean
  newCount: number
  processedCount: number
  skippedCount: number
  deletedCount: number
  totalPhotos: number
  /** 本次结束后仍有产物上传失败的照片数；这些照片下一次增量构建会自动重试。 */
  uploadFailedCount: number
}

export interface BuildProgressStartPayload {
  total: number
  mode: 'cpu-worker' | 'in-process'
  concurrency: number
}

export interface BuildProgressSnapshot {
  total: number
  completed: number
  newCount: number
  processedCount: number
  skippedCount: number
  failedCount: number
  currentKey?: string
}

export interface BuildProgressListener {
  onStart?: (payload: BuildProgressStartPayload) => void
  onProgress?: (snapshot: BuildProgressSnapshot) => void
  onComplete?: (summary: BuildProgressSnapshot) => void
  onError?: (error: unknown) => void
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  const reason = signal.reason
  throw reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : '构建已取消')
}

export class AfilmoryBuilder {
  private storageManager: StorageManager | null = null
  private config: BuilderConfig
  private pluginManager: PluginManager
  private readonly pluginReferences: BuilderPluginConfigEntry[]
  /** dry-run 时置 false：插件照常加载（`onInit` 的排除前缀要生效），但钩子不执行。 */
  private pluginHooksEnabled = true
  private runtimePools: BuilderRuntimePools | undefined = undefined

  constructor(config: BuilderConfig) {
    this.config = config

    this.pluginReferences = this.resolvePluginReferences()

    this.pluginManager = new PluginManager(this.pluginReferences, {
      baseDir: process.cwd(),
    })
  }

  getRuntimePools(): BuilderRuntimePools | undefined {
    return this.runtimePools
  }

  async buildManifest(options: BuilderOptions): Promise<BuilderResult> {
    try {
      // 插件必须加载，--dry-run 也不例外：thumbnail-storage / og-image-storage 在
      // `onInit` 里用 addExcludePrefix 注册 `.afilmory/...` 产物前缀。少了这一步，
      // 列表会把 builder 自己的产物当成照片（实测 369 张会数成 1476 张），
      // dry-run 报出来的数字就永远是假的。
      await this.ensurePluginsReady()
      // 但插件钩子在 dry-run 下不跑：它们会真的上传缩略图、同步远程仓库、写 manifest。
      // 只想要 `onInit` 的副作用（排除前缀 / 存储提供商注册），不想要写入。
      this.pluginHooksEnabled = !options.dryRun
      this.ensureStorageManager()
      return await this.#buildManifest(options)
    }
    catch (error) {
      logger.main.error('❌ 构建 manifest 失败：', error)
      throw error
    }
  }

  /**
   * 构建照片清单
   * @param options 构建选项
   */
  async #buildManifest(options: BuilderOptions): Promise<BuilderResult> {
    const startTime = Date.now()
    const runState = this.pluginManager.createRunState()
    const manifest: PhotoManifestItem[] = []
    const processingResults: ProcessPhotoResult[] = []
    let processedCount = 0
    let skippedCount = 0
    let newCount = 0
    let failedCount = 0
    let deletedCount = 0

    try {
      throwIfAborted(options.signal)

      await this.emitPluginEvent(runState, 'beforeBuild', {
        options,
      })

      this.logBuildStart()

      // 读取现有的 manifest（如果存在）
      const existingManifest = await this.loadExistingManifest(options)
      const existingManifestItems = existingManifest.data
      const existingManifestMap = new Map(existingManifestItems.map(item => [item.s3Key, item]))

      await this.emitPluginEvent(runState, 'afterManifestLoad', {
        options,
        manifest: existingManifest,
        manifestMap: existingManifestMap,
      })

      logger.main.info(`现有 manifest 包含 ${existingManifestItems.length} 张照片`)

      const storageConfig = this.getStorageConfig()
      logger.main.info('使用存储提供商：', storageConfig.provider)

      const storageManager = this.getStorageManager()

      // 列出存储中的所有文件
      const allObjects = await storageManager.listAllFiles()
      logger.main.info(`存储中找到 ${allObjects.length} 个文件`)

      await this.emitPluginEvent(runState, 'afterAllFilesListed', {
        options,
        allObjects,
      })

      throwIfAborted(options.signal)

      // 检测 Live Photo 配对（如果启用）
      const livePhotoMap = await this.detectLivePhotos(allObjects)
      if (this.config.system.processing.enableLivePhotoDetection) {
        logger.main.info(`检测到 ${livePhotoMap.size} 个 Live Photo`)
      }

      await this.emitPluginEvent(runState, 'afterLivePhotoDetection', {
        options,
        livePhotoMap,
      })

      throwIfAborted(options.signal)

      // 列出存储中的所有图片文件
      const listedImageObjects = await storageManager.listImages()
      const imageObjects = this.filterImageObjectsByKey(listedImageObjects, options)
      logger.main.info(`存储中找到 ${listedImageObjects.length} 张照片`)
      if (imageObjects.length !== listedImageObjects.length) {
        logger.main.info(`调试筛选后剩余 ${imageObjects.length} 张照片`)
      }

      await this.emitPluginEvent(runState, 'afterImagesListed', {
        options,
        imageObjects,
      })

      throwIfAborted(options.signal)

      if (imageObjects.length === 0) {
        logger.main.error('❌ 没有找到需要处理的照片')
        const result: BuilderResult = {
          hasUpdates: false,
          newCount: 0,
          processedCount: 0,
          skippedCount: 0,
          deletedCount: 0,
          totalPhotos: 0,
          uploadFailedCount: 0,
        }

        await this.emitPluginEvent(runState, 'afterBuild', {
          options,
          result,
          manifest,
        })

        return result
      }

      // 创建存储中存在的图片 key 集合，用于检测已删除的图片
      const s3ImageKeys = new Set(imageObjects.map(obj => obj.key))

      throwIfAborted(options.signal)

      // 媒体格式（宽度 / 质量 / 位深）变了就得整批重来，只算一次并同时传给 filterTaskImages 与 shouldProcessPhoto，
      // 避免照片排进队列后又在 shouldProcessPhoto 因为旧缩略图存在而被判「无需处理」。
      const mediaFormatStale
        = !options.isForceMode && !options.isForceManifest && !(await isMediaFormatCurrent())
      if (mediaFormatStale) {
        logger.main.info('媒体格式版本已变化，本次构建会重新生成全部缩略图 / 占位图')
      }

      // 筛选出实际需要处理的图片
      let tasksToProcess = await this.filterTaskImages(imageObjects, existingManifestMap, options, mediaFormatStale)

      // 为减少尾部长耗时，按文件大小降序处理（优先处理大文件）
      if (tasksToProcess.length > 1) {
        const beforeFirst = tasksToProcess[0]?.key
        tasksToProcess = tasksToProcess.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
        if (beforeFirst !== tasksToProcess[0]?.key) {
          logger.main.info('已按文件大小降序重排处理队列')
        }
      }

      await this.emitPluginEvent(runState, 'afterTasksPrepared', {
        options,
        tasks: tasksToProcess,
        totalImages: imageObjects.length,
      })

      logger.main.info(`存储中找到 ${imageObjects.length} 张照片，实际需要处理 ${tasksToProcess.length} 张`)

      const xmpSettings = this.getConfig().system.processing.xmp ?? { keywords: true, regions: true }

      const processorOptions: PhotoProcessorOptions = {
        isForceMode: options.isForceMode,
        isForceManifest: options.isForceManifest,
        isForceThumbnails: options.isForceThumbnails,
        xmpKeywordsEnabled: xmpSettings.keywords,
        xmpRegionsEnabled: xmpSettings.regions,
        dryRun: options.dryRun,
        mediaFormatStale,
      }

      const processing = this.config.system.processing
      const effectiveCpuConcurrency
        = typeof options.concurrencyLimit === 'number' && options.concurrencyLimit > 0
          ? options.concurrencyLimit
          : processing.cpuConcurrency

      const cpuPool = new CpuPool({
        cpuConcurrency: effectiveCpuConcurrency,
        sharpConcurrency: processing.sharpConcurrency,
        cpuWorkerCount: processing.cpuWorkerCount,
        taskCount: tasksToProcess.length,
        signal: options.signal,
      })

      const toPositiveInt = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value > 0
          ? Math.max(1, Math.floor(value))
          : undefined
      const storageDownload
        = 'downloadConcurrency' in storageConfig ? toPositiveInt(storageConfig.downloadConcurrency) : undefined
      const storageUpload
        = 'uploadConcurrency' in storageConfig ? toPositiveInt(storageConfig.uploadConcurrency) : undefined
      const networkPool = new NetworkPool({
        downloadConcurrency: storageDownload ?? processing.networkConcurrency,
        uploadConcurrency: storageUpload ?? processing.networkConcurrency,
      })

      const runtimePools: BuilderRuntimePools = { cpu: cpuPool, network: networkPool }
      this.runtimePools = runtimePools
      setSignatureBatchMode(true)

      const { progressListener } = options

      try {
        await this.emitPluginEvent(runState, 'beforeProcessTasks', {
          options,
          tasks: tasksToProcess,
          processorOptions,
          mode: cpuPool.plan.mode,
          concurrency: cpuPool.plan.cpuSlots,
        })

        if (tasksToProcess.length === 0) {
          progressListener?.onStart?.({
            total: 0,
            mode: cpuPool.plan.mode,
            concurrency: cpuPool.plan.cpuSlots,
          })
          logger.main.info('💡 没有需要处理的照片，使用现有 manifest')
          for (const item of existingManifestItems) {
            if (!s3ImageKeys.has(item.s3Key)) {
              continue
            }
            const normalizedItem = this.normalizeManifestItem(item, xmpSettings)

            await this.emitPluginEvent(runState, 'beforeAddManifestItem', {
              options,
              item: normalizedItem,
              pluginData: {},
              resultType: 'skipped',
            })

            manifest.push(normalizedItem)
            skippedCount++
          }
        }
        else {
          const totalTasks = tasksToProcess.length
          let completedTaskCount = 0

          const applyResultCounters = (result: ProcessPhotoResult | null | undefined): void => {
            if (!result) {
              return
            }

            switch (result.type) {
              case 'new': {
                newCount++
                processedCount++
                break
              }
              case 'processed': {
                processedCount++
                break
              }
              case 'skipped': {
                skippedCount++
                break
              }
              case 'failed': {
                failedCount++
                break
              }
            }
          }

          const emitProgress = (currentKey?: string): void => {
            progressListener?.onProgress?.({
              total: totalTasks,
              completed: completedTaskCount,
              newCount,
              processedCount,
              skippedCount,
              failedCount,
              currentKey,
            })
          }

          progressListener?.onStart?.({
            total: totalTasks,
            mode: cpuPool.plan.mode,
            concurrency: cpuPool.plan.cpuSlots,
          })
          emitProgress()

          logger.main.info(
            `开始处理任务：CPU 池=${cpuPool.plan.mode === 'cpu-worker' ? `子进程(${cpuPool.plan.workerCount}进程/${cpuPool.plan.cpuSlots}槽/sharp=${cpuPool.plan.sharpConcurrency})` : `同进程(${cpuPool.plan.cpuSlots}槽/sharp=${cpuPool.plan.sharpConcurrency})`}，网络池=↓${networkPool.downloadConcurrency}/↑${networkPool.uploadConcurrency}`,
          )

          throwIfAborted(options.signal)
          await cpuPool.start()

          const legacyLivePhotoMap = new Map<string, { Key: string, Size?: number, LastModified?: Date, ETag?: string }>()
          for (const [key, value] of livePhotoMap) {
            legacyLivePhotoMap.set(key, {
              Key: value.key,
              Size: value.size,
              LastModified: value.lastModified,
              ETag: value.etag,
            })
          }

          // 两层有界门控：
          // 1) pipelineWindowGate 约束全流程在途与待上传结果总量，防止慢上传导致内存无限膨胀；
          // 2) stage1Gate 按 downloadConcurrency + cpuSlots + 4 开窗，既容许慢下载与 CPU 充分重叠，
          //    又能在 Stage 1 完成后立刻释放（在 acquireStage2Gate 之前），避免慢上传反过来堵死下载/CPU。
          const pipelineWindowGate = new Semaphore(
            Math.max(
              16,
              cpuPool.plan.cpuSlots + networkPool.downloadConcurrency + Math.max(8, networkPool.uploadConcurrency * 3),
            ),
          )
          const stage1Gate = new Semaphore(Math.max(4, cpuPool.plan.cpuSlots + networkPool.downloadConcurrency + 4))
          const stage2Gate = new Semaphore(Math.max(4, networkPool.uploadConcurrency * 2))
          const acquireStage2Gate = () => stage2Gate.acquire(options.signal)
          let nextWorkerSeq = 0

          const settledResults = await Promise.allSettled(
            tasksToProcess.map(async (obj, taskIndex) => {
              if (options.signal?.aborted) {
                return null
              }

              let releaseWindow: (() => void) | undefined
              let releaseStage1Raw: (() => void) | undefined
              let stage1Released = false
              const releaseStage1Gate = () => {
                if (!stage1Released) {
                  stage1Released = true
                  releaseStage1Raw?.()
                }
              }

              try {
                releaseWindow = await pipelineWindowGate.acquire(options.signal)
                releaseStage1Raw = await stage1Gate.acquire(options.signal)
                if (options.signal?.aborted) {
                  releaseStage1Gate()
                  return null
                }

                const workerId = (nextWorkerSeq++ % Math.max(1, cpuPool.plan.cpuSlots)) + 1
                const legacyObj = {
                  Key: obj.key,
                  Size: obj.size,
                  LastModified: obj.lastModified,
                  ETag: obj.etag,
                }

                const result = await processPhoto(
                  legacyObj,
                  taskIndex,
                  workerId,
                  totalTasks,
                  existingManifestMap,
                  legacyLivePhotoMap,
                  processorOptions,
                  this,
                  {
                    runState,
                    builderOptions: options,
                    pools: runtimePools,
                    releaseStage1Gate,
                    acquireStage2Gate,
                  },
                )
                applyResultCounters(result)
                completedTaskCount++
                emitProgress(obj.key)
                return result
              }
              catch (error) {
                if (options.signal?.aborted) {
                  return null
                }
                throw error
              }
              finally {
                releaseStage1Gate()
                releaseWindow?.()
              }
            }),
          )

          const firstRejected = settledResults.find(
            (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
          )
          if (firstRejected) {
            throw firstRejected.reason
          }

          throwIfAborted(options.signal)

          const manifestKeySet = new Set<string>()
          for (const entry of settledResults) {
            if (entry.status !== 'fulfilled' || !entry.value) {
              continue
            }

            const result = entry.value
            if (!result.item) {
              if (result.pluginData) {
                releasePluginDataBuffers(result.pluginData)
              }
              processingResults.push({
                item: null,
                type: result.type,
              })
              continue
            }

            const normalizedItem = this.normalizeManifestItem(result.item, xmpSettings)

            await this.emitPluginEvent(runState, 'beforeAddManifestItem', {
              options,
              item: normalizedItem,
              pluginData: result.pluginData ?? {},
              resultType: result.type,
            })

            if (result.pluginData) {
              releasePluginDataBuffers(result.pluginData)
            }

            processingResults.push({
              item: normalizedItem,
              type: result.type,
            })
            manifest.push(normalizedItem)
            manifestKeySet.add(normalizedItem.s3Key)
          }

          for (const [key, item] of existingManifestMap) {
            if (s3ImageKeys.has(key) && !manifestKeySet.has(key)) {
              const normalizedItem = this.normalizeManifestItem(item, xmpSettings)

              await this.emitPluginEvent(runState, 'beforeAddManifestItem', {
                options,
                item: normalizedItem,
                pluginData: {},
                resultType: 'skipped',
              })

              manifest.push(normalizedItem)
              manifestKeySet.add(key)
              skippedCount++
            }
          }

          completedTaskCount = Math.max(completedTaskCount, totalTasks)
          emitProgress()
          progressListener?.onComplete?.({
            total: totalTasks,
            completed: completedTaskCount,
            newCount,
            processedCount,
            skippedCount,
            failedCount,
          })
        }

        if (tasksToProcess.length === 0 && progressListener) {
          progressListener.onComplete?.({
            total: 0,
            completed: 0,
            newCount,
            processedCount,
            skippedCount,
            failedCount,
          })
        }

        throwIfAborted(options.signal)

        // 全部照片都处理成功才把「格式版本」落盘：中途失败或 --dry-run 时不写，
        // 下次构建会继续按「版本不符」重新排队（幂等，最多多编一次）。
        if (!options.dryRun && failedCount === 0) {
          await markMediaFormatCurrent()
        }

        await this.emitPluginEvent(runState, 'afterProcessTasks', {
          options,
          tasks: tasksToProcess,
          results: processingResults,
          manifest,
          stats: {
            newCount,
            processedCount,
            skippedCount,
          },
        })
      }
      finally {
        this.runtimePools = undefined
        await cpuPool.close()
        await shutdownExiftool()
        setSignatureBatchMode(false)
        await flushSignatures()
      }

      throwIfAborted(options.signal)

      // 检测并处理已删除的图片
      if (!options.dryRun) {
        deletedCount = await handleDeletedPhotos(manifest)

        await this.emitPluginEvent(runState, 'afterCleanup', {
          options,
          manifest,
          deletedCount,
        })
      }

      // 生成相机和镜头集合
      const cameras = this.generateCameraCollection(manifest)
      const lenses = this.generateLensCollection(manifest)

      if (!options.dryRun) {
        await this.emitPluginEvent(runState, 'beforeSaveManifest', {
          options,
          manifest,
          cameras,
          lenses,
        })

        await saveManifest(manifest, cameras, lenses)

        await this.emitPluginEvent(runState, 'afterSaveManifest', {
          options,
          manifest,
          cameras,
          lenses,
        })
      }
      else {
        logger.main.info('🧪 Dry-run 模式：跳过 manifest 保存、缩略图清理和插件副作用')
      }

      if (this.config.system.observability.showDetailedStats) {
        this.logBuildResults(
          manifest,
          {
            newCount,
            processedCount,
            skippedCount,
            deletedCount,
          },
          Date.now() - startTime,
        )
      }

      const hasUpdates = newCount > 0 || processedCount > 0 || deletedCount > 0

      const uploadFailedItems = manifest.filter(item => item.lastProcessSuccess === false)
      const uploadFailedCount = uploadFailedItems.length
      if (uploadFailedCount > 0) {
        logger.main.warn(`⚠ ${uploadFailedCount} 张照片仍有产物上传失败；已写入 manifest，下一次增量构建会自动重试`)
        for (const item of uploadFailedItems.slice(0, 20)) {
          logger.main.warn(`  - ${item.id}: ${item.uploadFailures?.slice(-3).join('; ') ?? '未知错误'}`)
        }
        if (uploadFailedCount > 20) {
          logger.main.warn(`  … 另有 ${uploadFailedCount - 20} 张，详见 manifest 的 uploadFailures`)
        }
      }

      const result: BuilderResult = {
        hasUpdates,
        newCount,
        processedCount,
        skippedCount,
        deletedCount,
        totalPhotos: manifest.length,
        uploadFailedCount,
      }

      await this.emitPluginEvent(runState, 'afterBuild', {
        options,
        result,
        manifest,
      })

      return result
    }
    catch (error) {
      options.progressListener?.onError?.(error)
      await this.emitPluginEvent(runState, 'onError', {
        options,
        error,
      })
      throw error
    }
  }

  private async loadExistingManifest(options: BuilderOptions): Promise<AfilmoryManifest> {
    return options.isForceMode || options.isForceManifest
      ? {
          version: CURRENT_MANIFEST_VERSION,
          data: [],
          cameras: [],
          lenses: [],
        }
      : await loadExistingManifest({
          allowWrite: !options.dryRun,
          allowMigrate: !options.dryRun,
        })
  }

  private async detectLivePhotos(
    allObjects: Awaited<ReturnType<StorageManager['listAllFiles']>>,
  ): Promise<Map<string, (typeof allObjects)[0]>> {
    if (!this.config.system.processing.enableLivePhotoDetection) {
      return new Map()
    }

    return await this.getStorageManager().detectLivePhotos(allObjects)
  }

  private logBuildStart(): void {
    const storage = this.getStorageConfig()
    switch (storage.provider) {
      case 's3':
      case 'oss':
      case 'cos': {
        const endpoint = storage.endpoint || '默认 AWS S3'
        const customDomain = storage.customDomain || '未设置'
        const { bucket } = storage
        const prefix = storage.prefix || '无前缀'

        logger.main.info('🚀 开始从存储获取照片列表...')
        logger.main.info(`🔗 使用端点：${endpoint}`)
        logger.main.info(`🌐 自定义域名：${customDomain}`)
        logger.main.info(`🪣 存储桶：${bucket}`)
        logger.main.info(`📂 前缀：${prefix}`)
        break
      }
      case 'github': {
        const { owner, repo, branch, path } = storage
        logger.main.info('🚀 开始从存储获取照片列表...')
        logger.main.info(`👤 仓库所有者：${owner}`)
        logger.main.info(`🏷️ 仓库名称：${repo}`)
        logger.main.info(`🌲 分支：${branch}`)
        logger.main.info(`📂 路径：${path}`)
        break
      }
    }
  }

  private logBuildResults(
    manifest: PhotoManifestItem[],
    stats: {
      newCount: number
      processedCount: number
      skippedCount: number
      deletedCount: number
    },
    totalDuration: number,
  ): void {
    const durationSeconds = Math.round(totalDuration / 1000)
    const durationMinutes = Math.floor(durationSeconds / 60)
    const remainingSeconds = durationSeconds % 60

    logger.main.success(`🎉 Manifest 构建完成!`)
    logger.main.info(`📊 处理统计:`)
    logger.main.info(`   📸 总照片数：${manifest.length}`)
    logger.main.info(`   🆕 新增照片：${stats.newCount}`)
    logger.main.info(`   🔄 处理照片：${stats.processedCount}`)
    logger.main.info(`   ⏭️ 跳过照片：${stats.skippedCount}`)
    logger.main.info(`   🗑️ 删除照片：${stats.deletedCount}`)
    logger.main.info(
      `   ⏱️ 总耗时：${durationMinutes > 0 ? `${durationMinutes}分${remainingSeconds}秒` : `${durationSeconds}秒`}`,
    )
  }

  /**
   * 获取当前使用的存储管理器
   */
  getStorageManager(): StorageManager {
    return this.ensureStorageManager()
  }

  setStorageManager(manager: StorageManager): void {
    this.storageManager = manager
  }

  registerStorageProvider(
    provider: string,
    factory: StorageProviderFactory,
    options?: StorageProviderRegistrationOptions,
  ): void {
    StorageFactory.registerProvider(provider, factory, options)

    if (this.getStorageConfig().provider === provider) {
      this.storageManager = null
      this.ensureStorageManager()
    }
  }

  createPluginRunState(): PluginRunState {
    return this.pluginManager.createRunState()
  }

  async emitPluginEvent<TEvent extends keyof BuilderPluginEventPayloads>(
    runState: PluginRunState,
    event: TEvent,
    payload: BuilderPluginEventPayloads[TEvent],
  ): Promise<void> {
    // dry-run 只加载插件（为了 onInit 里的排除前缀），不执行钩子——
    // 钩子会真的上传产物、同步仓库、写文件。
    if (!this.pluginHooksEnabled) {
      return
    }
    await this.pluginManager.emit(this, runState, event, payload)
  }

  async ensurePluginsReady(): Promise<void> {
    await this.pluginManager.ensureLoaded(this)
  }

  private resolvePluginReferences(): BuilderPluginConfigEntry[] {
    const references: BuilderPluginConfigEntry[] = []
    const seen = new Set<string>()

    const addReference = (ref: BuilderPluginConfigEntry) => {
      if (typeof ref === 'string') {
        if (seen.has(ref)) {
          return
        }
        seen.add(ref)
        references.push(ref)
        return
      }

      const pluginName = ref.name
      if (pluginName) {
        const key = `plugin:${pluginName}`
        if (seen.has(key)) {
          return
        }
        seen.add(key)
      }
      references.push(ref)
    }

    const hasPluginWithName = (name: string): boolean => {
      return references.some((ref) => {
        if (typeof ref === 'string') {
          return false
        }
        return ref.name === name
      })
    }

    const storagePluginByProvider: Record<string, BuilderPluginESMImporter> = {
      s3: () => import('@afilmory/builder/plugins/storage/s3.js'),
      b2: () => import('@afilmory/builder/plugins/storage/b2.js'),
      github: () => import('@afilmory/builder/plugins/storage/github.js'),
      eagle: () => import('@afilmory/builder/plugins/storage/eagle.js'),
      local: () => import('@afilmory/builder/plugins/storage/local.js'),
    }

    const storageProvider = this.getStorageConfig().provider
    const storagePlugin = storagePluginByProvider[storageProvider]
    if (storagePlugin) {
      const expectedName = `afilmory:storage:${storageProvider}`
      if (hasPluginWithName(expectedName)) {
        return references
      }
      addReference(storagePlugin)
    }

    for (const ref of this.config.plugins) {
      addReference(ref)
    }

    return references
  }

  private ensureStorageManager(): StorageManager {
    if (!this.storageManager) {
      this.storageManager = new StorageManager(this.getStorageConfig())
    }

    return this.storageManager
  }

  private getUserSettings(): UserBuilderSettings {
    if (!this.config.user) {
      throw new Error('User configuration is missing. 请配置 system/user 设置。')
    }
    return this.config.user
  }

  getStorageConfig(): StorageConfig {
    const { storage } = this.getUserSettings()
    if (!storage) {
      throw new Error('Storage configuration is missing. 请配置 system/user storage 设置。')
    }
    return storage
  }

  /**
   * 获取当前配置
   */
  getConfig(): BuilderConfig {
    return Object.freeze(this.config)
  }

  /**
   * 筛选出实际需要处理的图片
   * @param imageObjects 存储中的图片对象列表
   * @param existingManifestMap 现有 manifest 的映射
   * @param options 构建选项
   * @returns 实际需要处理的图片数组
   */
  private async filterTaskImages(
    imageObjects: Awaited<ReturnType<StorageManager['listImages']>>,
    existingManifestMap: Map<string, PhotoManifestItem>,
    options: BuilderOptions,
    mediaFormatStale: boolean,
  ): Promise<Awaited<ReturnType<StorageManager['listImages']>>> {
    // 强制模式下所有图片都需要处理
    if (options.isForceMode || options.isForceManifest) {
      return imageObjects
    }

    // 编码参数（宽度 / 质量 / 位深）变了就必须整体重来：产物文件名不含参数，
    // 只看「文件在不在」会静默复用旧产物。
    if (mediaFormatStale) {
      return imageObjects
    }

    const tasksToProcess: Awaited<ReturnType<StorageManager['listImages']>> = []
    const { digestSuffixLength } = this.config.system.processing

    for (const obj of imageObjects) {
      const { key } = obj
      const photoId = computePhotoId(key, digestSuffixLength)
      const existingItem = existingManifestMap.get(key)

      // 新图片需要处理
      if (!existingItem) {
        tasksToProcess.push(obj)
        continue
      }

      // 上次有产物没上传成功：即使文件没变也要重试
      if (existingItem.lastProcessSuccess === false || (existingItem.uploadFailures?.length ?? 0) > 0) {
        tasksToProcess.push(obj)
        continue
      }

      // 检查是否需要更新（基于修改时间）
      const legacyObj = {
        Key: key,
        Size: obj.size,
        LastModified: obj.lastModified,
        ETag: obj.etag,
      }

      if (needsUpdate(existingItem, legacyObj)) {
        tasksToProcess.push(obj)
        continue
      }

      const needsXmpBackfill
        = !Array.isArray((existingItem as Partial<PhotoManifestItem>).keywords)
          || !Array.isArray((existingItem as Partial<PhotoManifestItem>).regions)

      if (needsXmpBackfill) {
        tasksToProcess.push(obj)
        continue
      }

      // 检查缩略图是否存在，如果不存在或强制刷新缩略图则需要处理
      const hasThumbnail = await thumbnailExists(photoId)
      if (!hasThumbnail || options.isForceThumbnails) {
        tasksToProcess.push(obj)
        continue
      }

      // 占位图比缩略图晚引入，历史产物可能只有缩略图
      if (!(await previewExists(photoId))) {
        tasksToProcess.push(obj)
        continue
      }

      // 其他情况下跳过处理
    }

    return tasksToProcess
  }

  private filterImageObjectsByKey(
    imageObjects: Awaited<ReturnType<StorageManager['listImages']>>,
    options: BuilderOptions,
  ): Awaited<ReturnType<StorageManager['listImages']>> {
    const keyRegex = options.keyRegex?.trim()
    if (!keyRegex) {
      return imageObjects
    }

    let pattern: RegExp
    try {
      pattern = new RegExp(keyRegex, 'i')
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无效的 --key-regex 正则表达式 "${keyRegex}": ${detail}`)
    }

    return imageObjects.filter(item => pattern.test(item.key))
  }

  private normalizeManifestItem(
    item: PhotoManifestItem,
    xmpSettings: { keywords: boolean, regions: boolean },
  ): PhotoManifestItem {
    const keywords
      = xmpSettings.keywords && Array.isArray((item as Partial<PhotoManifestItem>).keywords) ? item.keywords : []
    const regions
      = xmpSettings.regions && Array.isArray((item as Partial<PhotoManifestItem>).regions) ? item.regions : []

    return {
      ...item,
      keywords,
      regions,
    }
  }

  /**
   * 生成相机信息集合
   * @param manifest 照片清单数组
   * @returns 唯一相机信息数组
   */
  private generateCameraCollection(manifest: PhotoManifestItem[]): CameraInfo[] {
    const cameraMap = new Map<string, CameraInfo>()

    for (const photo of manifest) {
      if (!photo.exif?.Make || !photo.exif?.Model) {
        continue
      }

      const make = photo.exif.Make.trim()
      const model = photo.exif.Model.trim()
      const displayName = `${make} ${model}`

      // 使用 displayName 作为唯一键，避免重复
      if (!cameraMap.has(displayName)) {
        cameraMap.set(displayName, {
          make,
          model,
          displayName,
        })
      }
    }

    // 按 displayName 排序返回
    return Array.from(cameraMap.values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /**
   * 生成镜头信息集合
   * @param manifest 照片清单数组
   * @returns 唯一镜头信息数组
   */
  private generateLensCollection(manifest: PhotoManifestItem[]): LensInfo[] {
    const lensMap = new Map<string, LensInfo>()

    for (const photo of manifest) {
      if (!photo.exif?.LensModel) {
        continue
      }

      const lensModel = photo.exif.LensModel.trim()
      const lensMake = photo.exif.LensMake?.trim()

      // 生成显示名称：如果有厂商信息则包含，否则只显示型号
      const displayName = lensMake ? `${lensMake} ${lensModel}` : lensModel

      // 使用 displayName 作为唯一键，避免重复
      if (!lensMap.has(displayName)) {
        lensMap.set(displayName, {
          make: lensMake,
          model: lensModel,
          displayName,
        })
      }
    }

    // 按 displayName 排序返回
    return Array.from(lensMap.values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }
}
