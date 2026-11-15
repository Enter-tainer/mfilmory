import path from 'node:path'
import process from 'node:process'

import type { AfilmoryManifest, CameraInfo, LensInfo, PhotoManifestItem, ProcessPhotoResult } from '@afilmory/typing'
import { Semaphore } from '@afilmory/utils'

import { flushSignatures, setSignatureBatchMode } from '../image/asset-signature.js'
import { isMediaFormatCurrent, markMediaFormatCurrent } from '../image/media-format.js'
import { previewExists } from '../image/preview.js'
import { thumbnailExists } from '../image/thumbnail.js'
import { logger } from '../logger/index.js'
import { handleDeletedPhotos, loadExistingManifest, needsUpdate, saveManifest } from '../manifest/manager.js'
import { CURRENT_MANIFEST_VERSION } from '../manifest/version.js'
import type { BuilderRuntimePools } from '../photo/execution-context.js'
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
}

export interface BuilderResult {
  hasUpdates: boolean
  newCount: number
  processedCount: number
  skippedCount: number
  deletedCount: number
  totalPhotos: number
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

      // 检测 Live Photo 配对（如果启用）
      const livePhotoMap = await this.detectLivePhotos(allObjects)
      if (this.config.system.processing.enableLivePhotoDetection) {
        logger.main.info(`检测到 ${livePhotoMap.size} 个 Live Photo`)
      }

      await this.emitPluginEvent(runState, 'afterLivePhotoDetection', {
        options,
        livePhotoMap,
      })

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

      if (imageObjects.length === 0) {
        logger.main.error('❌ 没有找到需要处理的照片')
        const result: BuilderResult = {
          hasUpdates: false,
          newCount: 0,
          processedCount: 0,
          skippedCount: 0,
          deletedCount: 0,
          totalPhotos: 0,
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

      // 筛选出实际需要处理的图片
      let tasksToProcess = await this.filterTaskImages(imageObjects, existingManifestMap, options)

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
      })

      const storageDownload
        = 'downloadConcurrency' in storageConfig && typeof storageConfig.downloadConcurrency === 'number'
          ? storageConfig.downloadConcurrency
          : undefined
      const storageUpload
        = 'uploadConcurrency' in storageConfig && typeof storageConfig.uploadConcurrency === 'number'
          ? storageConfig.uploadConcurrency
          : undefined
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

          // 预取缓冲区（Stage 1）适度超前 CPU 槽位 +4：网络下载完即进入 ExifTool + CPU 池，
          // 随后立即释放 gate 并丢弃原图大 Buffer，不让后续上传/逆地理编码占住前段并发。
          const stage1Gate = new Semaphore(cpuPool.plan.cpuSlots + 4)
          let nextWorkerSeq = 0

          const results = await Promise.all(
            tasksToProcess.map(async (obj, taskIndex) => {
              const workerId = (nextWorkerSeq++ % Math.max(1, cpuPool.plan.cpuSlots)) + 1
              const legacyObj = {
                Key: obj.key,
                Size: obj.size,
                LastModified: obj.lastModified,
                ETag: obj.etag,
              }

              const release = await stage1Gate.acquire()
              let released = false
              const releaseStage1Gate = () => {
                if (!released) {
                  released = true
                  release()
                }
              }

              try {
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
                  },
                )
                applyResultCounters(result)
                completedTaskCount++
                emitProgress(obj.key)
                return result
              }
              finally {
                releaseStage1Gate()
              }
            }),
          )

          for (const result of results) {
            processingResults.push({
              item: result.item,
              type: result.type,
            })

            if (!result.item) {
              continue
            }

            const normalizedItem = this.normalizeManifestItem(result.item, xmpSettings)

            await this.emitPluginEvent(runState, 'beforeAddManifestItem', {
              options,
              item: normalizedItem,
              pluginData: result.pluginData ?? {},
              resultType: result.type,
            })

            manifest.push(normalizedItem)
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

          for (const [key, item] of existingManifestMap) {
            if (s3ImageKeys.has(key) && !manifest.some(m => m.s3Key === key)) {
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
        setSignatureBatchMode(false)
        await flushSignatures()
      }

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
      const result: BuilderResult = {
        hasUpdates,
        newCount,
        processedCount,
        skippedCount,
        deletedCount,
        totalPhotos: manifest.length,
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
  ): Promise<Awaited<ReturnType<StorageManager['listImages']>>> {
    // 强制模式下所有图片都需要处理
    if (options.isForceMode || options.isForceManifest) {
      return imageObjects
    }

    // 编码参数（宽度 / 质量 / 位深）变了就必须整体重来：产物文件名不含参数，
    // 只看「文件在不在」会静默复用旧产物——历史上以为签名会触发重编码，
    // 实际这一层先 stat 了文件就跳过了，日志还一切正常。
    if (!(await isMediaFormatCurrent())) {
      logger.main.info('媒体格式版本已变化，本次构建会重新生成全部缩略图 / 占位图')
      return imageObjects
    }

    const tasksToProcess: Awaited<ReturnType<StorageManager['listImages']>> = []

    for (const obj of imageObjects) {
      const { key } = obj
      const photoId = path.basename(key, path.extname(key))
      const existingItem = existingManifestMap.get(key)

      // 新图片需要处理
      if (!existingItem) {
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

    const pattern = new RegExp(keyRegex, 'i')

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
