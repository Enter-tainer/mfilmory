import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PhotoManifestItem } from '@afilmory/typing'

import { signatureMatches, writeSignature } from '../../image/asset-signature.js'
import type { Logger } from '../../logger/index.js'
import { workdir } from '../../path.js'
import { StorageManager } from '../../storage/index.js'
import type { S3CompatibleConfig, StorageConfig } from '../../storage/interfaces.js'
import type { ThumbnailPluginData } from '../thumbnail-storage/shared.js'
import { MEDIA_CACHE_CONTROL, PREVIEW_PLUGIN_DATA_KEY, THUMBNAIL_PLUGIN_DATA_KEY } from '../thumbnail-storage/shared.js'
import type { BuilderPlugin } from '../types.js'
import { PHOTO_OG_WEBP_QUALITY, renderPhotoOgImage } from './photo-og.js'
import type { CloudflareMiddlewareVendorConfig } from './vendors/cloudflare-moddleware.js'
import { CloudflareMiddlewareVendor } from './vendors/cloudflare-moddleware.js'
import type { OgVendor } from './vendors/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../../..')

const PLUGIN_NAME = 'afilmory:og-image'
const RUN_STATE_KEY = 'state'
const DEFAULT_DIRECTORY = '.afilmory/og-images'
const DEFAULT_CONTENT_TYPE = 'image/webp'

type UploadableStorageConfig = Exclude<StorageConfig, { provider: 'eagle' }>

interface OgImagePluginOptions {
  enable?: boolean
  directory?: string
  storageConfig?: UploadableStorageConfig
  contentType?: string
  vendor?: OgVendorConfig
}

type OgVendorConfig = CloudflareMiddlewareVendorConfig

interface ResolvedPluginConfig {
  directory: string
  remotePrefix: string
  contentType: string
  useDefaultStorage: boolean
  storageConfig: UploadableStorageConfig | null
  enabled: boolean
}

interface PluginRunState {
  uploaded: Set<string>
  urlCache: Map<string, string>
}

function normalizeDirectory(directory: string | undefined): string {
  const value = directory?.trim() || DEFAULT_DIRECTORY
  const normalized = value.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
  return normalized || DEFAULT_DIRECTORY
}

function trimSlashes(value: string | undefined | null): string | null {
  if (!value) return null
  const normalized = value.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
  return normalized.length > 0 ? normalized : null
}

function joinSegments(...segments: Array<string | null | undefined>): string {
  const filtered = segments
    .map(segment => (segment ?? '').replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, ''))
    .filter(segment => segment.length > 0)
  return filtered.join('/')
}

function resolveRemotePrefix(config: UploadableStorageConfig, directory: string): string {
  switch (config.provider) {
    case 's3':
    case 'oss':
    case 'cos': {
      const base = trimSlashes((config as S3CompatibleConfig).prefix)
      return joinSegments(base, directory)
    }
    default: {
      return joinSegments(directory)
    }
  }
}

/**
 * Get or initialize per-run caches to dedupe uploads and URL lookups.
 */
function getOrCreateRunState(container: Map<string, unknown>): PluginRunState {
  let state = container.get(RUN_STATE_KEY) as PluginRunState | undefined
  if (!state) {
    state = {
      uploaded: new Set<string>(),
      urlCache: new Map<string, string>(),
    }
    container.set(RUN_STATE_KEY, state)
  }
  return state
}

function createVendor(config: OgVendorConfig): OgVendor {
  switch (config.type) {
    case 'cloudflare-middleware': {
      return new CloudflareMiddlewareVendor(config)
    }
    default: {
      throw new Error(`Unknown OG vendor type: ${String((config as { type?: string }).type)}`)
    }
  }
}

async function readLocalPublicFile(url: string): Promise<Buffer | null> {
  if (/^https?:\/\//i.test(url)) return null

  const localPath = path.join(workdir, 'public', url.replace(/^\/+/, ''))
  try {
    return await readFile(localPath)
  }
  catch {
    return null
  }
}

/**
 * 找一份够大的照片源。
 *
 * 分享图是 1200×630 满幅，600px 的缩略图会被放大到发糊，所以优先用 2560px 的
 * 阅览器占位图（preview）；只有它缺失时才退回缩略图。两者都由上一个插件
 * （thumbnail-storage）在内存里准备好，正常一次构建不需要额外读盘或联网。
 */
async function resolvePhotoSource(
  item: PhotoManifestItem,
  thumbnailData: ThumbnailPluginData | undefined,
  previewData: ThumbnailPluginData | undefined,
  logger: Logger,
): Promise<Buffer | null> {
  for (const buffer of [previewData?.buffer, thumbnailData?.buffer]) {
    if (buffer && buffer.length > 0) return buffer
  }

  const urls = [previewData?.localUrl, item.previewUrl, thumbnailData?.localUrl, item.thumbnailUrl]

  for (const url of urls) {
    if (!url) { continue }

    const local = await readLocalPublicFile(url)
    if (local) return local

    if (!/^https?:\/\//i.test(url)) { continue }

    try {
      const response = await fetch(url)
      if (response.ok) return Buffer.from(await response.arrayBuffer())
    }
    catch (error) {
      logger.main.debug?.(`OG image plugin: could not fetch ${url}`, error)
    }
  }

  return null
}

/**
 * Render Open Graph images for processed photos and upload them to remote storage.
 *
 * 卡片本身只有照片（见 `photo-og.ts`）；标题、日期、EXIF 这些文字交给分享平台
 * 从页面的 og:title / og:description 里原生渲染，由 middleware vendor 注入。
 */
export default function ogImagePlugin(options: OgImagePluginOptions = {}): BuilderPlugin {
  let resolved: ResolvedPluginConfig | null = null
  let externalStorageManager: StorageManager | null = null
  let vendor: OgVendor | null = null

  return {
    name: PLUGIN_NAME,
    hooks: {
      onInit: ({ builder, config, logger }) => {
        const enable = options.enable ?? true
        const directory = normalizeDirectory(options.directory)
        const contentType = options.contentType ?? DEFAULT_CONTENT_TYPE

        if (options.vendor && !vendor) {
          try {
            vendor = createVendor(options.vendor)
          }
          catch (error) {
            logger.main.error('OG image plugin: failed to initialize vendor config.', error)
            throw error
          }
        }

        if (!enable) {
          resolved = {
            directory,
            remotePrefix: '',
            contentType,
            useDefaultStorage: true,
            storageConfig: null,
            enabled: false,
          }
          return
        }

        const fallbackStorage = config.user?.storage ?? builder.getStorageConfig()
        const storageConfig = (options.storageConfig ?? fallbackStorage) as StorageConfig

        if (storageConfig.provider === 'eagle') {
          logger.main.warn('OG image plugin does not support Eagle storage provider; plugin disabled.')
          resolved = {
            directory,
            remotePrefix: '',
            contentType,
            useDefaultStorage: !options.storageConfig,
            storageConfig: null,
            enabled: false,
          }
          return
        }

        const uploadableConfig = storageConfig as UploadableStorageConfig
        const remotePrefix = resolveRemotePrefix(uploadableConfig, directory)

        resolved = {
          directory,
          remotePrefix,
          contentType,
          useDefaultStorage: !options.storageConfig,
          storageConfig: uploadableConfig,
          enabled: true,
        }

        if (!options.storageConfig) {
          builder.getStorageManager().addExcludePrefix(remotePrefix)
        }
        else {
          externalStorageManager = new StorageManager(uploadableConfig)
        }
      },
      afterPhotoProcess: async ({ builder, payload, runShared, logger }) => {
        if (!resolved || !resolved.enabled) {
          return
        }

        const { item, type } = payload.result
        if (!item) {
          return
        }

        const storageManager = resolved.useDefaultStorage ? builder.getStorageManager() : externalStorageManager
        if (!storageManager) {
          logger.main.warn('OG image plugin could not resolve storage manager. Skipping upload.')
          return
        }

        const state = getOrCreateRunState(runShared)

        const ogSignature = `photo-straight-webp-q${PHOTO_OG_WEBP_QUALITY}`
        const canReuse
          = !payload.options.isForceMode
            && !payload.options.isForceManifest
            && (await signatureMatches('og', item.id, ogSignature))
        const shouldRender
          = !canReuse && (type !== 'skipped' || payload.options.isForceMode || payload.options.isForceManifest)

        const remoteKey = joinSegments(resolved.remotePrefix, `${item.id}.webp`)

        if (!shouldRender) {
          try {
            const remoteUrl = await storageManager.generatePublicUrl(remoteKey)
            state.urlCache.set(remoteKey, remoteUrl)
            item.ogImageUrl = remoteUrl
          }
          catch (error) {
            logger.main.info(`OG image plugin: skipped rendering and could not resolve URL for ${remoteKey}.`, error)
          }
          return
        }

        const thumbnailData = payload.context.pluginData[THUMBNAIL_PLUGIN_DATA_KEY] as ThumbnailPluginData | undefined
        const previewData = payload.context.pluginData[PREVIEW_PLUGIN_DATA_KEY] as ThumbnailPluginData | undefined

        const source = await resolvePhotoSource(item, thumbnailData, previewData, logger)
        if (!source) {
          logger.main.warn(`OG image plugin: no usable photo source for ${item.id}, skipping.`)
          return
        }

        try {
          const webp = await renderPhotoOgImage(source)

          const stateForUpload = state
          if (
            !stateForUpload.uploaded.has(remoteKey)
            || payload.options.isForceMode
            || payload.options.isForceManifest
          ) {
            try {
              await storageManager.uploadFile(remoteKey, webp, {
                cacheControl: MEDIA_CACHE_CONTROL,
                contentType: resolved.contentType,
              })
              stateForUpload.uploaded.add(remoteKey)
            }
            catch (error) {
              logger.main.error(`OG image plugin: failed to upload ${remoteKey}`, error)
              return
            }
          }

          let remoteUrl = stateForUpload.urlCache.get(remoteKey)
          if (!remoteUrl) {
            try {
              remoteUrl = await storageManager.generatePublicUrl(remoteKey)
              stateForUpload.urlCache.set(remoteKey, remoteUrl)
            }
            catch (error) {
              logger.main.error(`OG image plugin: failed to generate URL for ${remoteKey}`, error)
              return
            }
          }

          await writeSignature('og', item.id, ogSignature)
          item.ogImageUrl = remoteUrl
        }
        catch (error) {
          logger.main.error(`OG image plugin: failed to render OG image for ${item.id}`, error)
        }
      },
      afterBuild: async ({ logger }) => {
        if (!vendor) return

        try {
          await vendor.build({ repoRoot, logger })
        }
        catch (error) {
          logger.main.error('OG image plugin: vendor build step failed.', error)
        }
      },
    },
  }
}

export type { OgImagePluginOptions, OgVendorConfig }

export { type CloudflareMiddlewareVendorConfig } from './vendors/cloudflare-moddleware.js'
export { type OgVendorKind } from './vendors/types.js'
