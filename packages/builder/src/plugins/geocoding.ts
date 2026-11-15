import type { LocationInfo, PickedExif } from '@afilmory/typing'

import type { AfilmoryBuilder } from '../builder/builder.js'
import type { Logger } from '../logger/index.js'
import {
  createStorageKeyNormalizer,
  getPhotoExecutionContext,
  runWithPhotoExecutionContext,
} from '../photo/execution-context.js'
import type { GeocodingProvider } from '../photo/geocoding.js'
import { createGeocodingProvider, extractLocationFromGPS, parseGPSCoordinates } from '../photo/geocoding.js'
import { createPhotoProcessingLoggers } from '../photo/logger-adapter.js'
import type { BuilderPlugin } from './types.js'

const PLUGIN_NAME = 'afilmory:geocoding'
const RUN_STATE_KEY = 'geocodingState'
const DEFAULT_CACHE_PRECISION = 4

interface GeocodingPluginOptions {
  enable?: boolean
  provider?: 'mapbox' | 'nominatim' | 'auto'
  mapboxToken?: string
  nominatimBaseUrl?: string
  cachePrecision?: number
  /**
   * Preferred languages for geocoding results (BCP47). Accepts comma-separated string or array.
   */
  language?: string | string[]
}
type GeocodingPluginOptionsResolved = Required<Pick<GeocodingPluginOptions, 'enable' | 'provider'>>
  & Pick<GeocodingPluginOptions, 'mapboxToken' | 'nominatimBaseUrl' | 'cachePrecision'> & {
    language: string | null
  }

interface ResolvedGeocodingSettings {
  provider: 'mapbox' | 'nominatim' | 'auto'
  mapboxToken?: string
  nominatimBaseUrl?: string
  cachePrecision: number
  language: string | null
}

interface PendingGeocodeJob {
  cacheKey: string
  promise: Promise<LocationInfo | null>
  overwrite: boolean
}

interface GeocodingState {
  provider: GeocodingProvider | null
  providerKey: string | null
  cache: Map<string, LocationInfo | null>
  inflight: Map<string, Promise<LocationInfo | null>>
  pendingByKey: Map<string, PendingGeocodeJob>
}

type LocationLogger = Logger['main']

function normalizeCachePrecision(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_CACHE_PRECISION
  }

  const rounded = Math.round(value)
  return Math.max(0, Math.min(10, rounded))
}

function normalizeLanguage(value: string | string[] | undefined): string | null {
  if (!value) { return null }
  const parts = Array.isArray(value) ? value : String(value).split(',')
  const normalized = parts.map(v => v.trim()).filter(Boolean)
  return normalized.length > 0 ? normalized.join(',') : null
}

function resolveSettings(options: GeocodingPluginOptions): GeocodingPluginOptionsResolved {
  return {
    enable: options.enable ?? false,
    provider: options.provider ?? 'auto',
    mapboxToken: options.mapboxToken,
    nominatimBaseUrl: options.nominatimBaseUrl,
    cachePrecision: normalizeCachePrecision(options.cachePrecision ?? DEFAULT_CACHE_PRECISION),
    language: normalizeLanguage(options.language),
  }
}

function getOrCreateState(runShared: Map<string, unknown>): GeocodingState {
  const existing = runShared.get(RUN_STATE_KEY) as GeocodingState | undefined
  if (existing) {
    return existing
  }

  const next: GeocodingState = {
    provider: null,
    providerKey: null,
    cache: new Map(),
    inflight: new Map(),
    pendingByKey: new Map(),
  }
  runShared.set(RUN_STATE_KEY, next)
  return next
}

function buildProviderKey(settings: ResolvedGeocodingSettings): string {
  return `${settings.provider}:${settings.mapboxToken ?? ''}:${settings.nominatimBaseUrl ?? ''}:${settings.language ?? ''}`
}

function ensureProvider(
  state: GeocodingState,
  settings: ResolvedGeocodingSettings,
  logger: LocationLogger,
): GeocodingProvider | null {
  const providerKey = buildProviderKey(settings)
  if (state.provider && state.providerKey === providerKey) {
    return state.provider
  }

  if (state.providerKey && state.providerKey !== providerKey) {
    state.cache.clear()
    state.inflight.clear()
  }

  const provider = createGeocodingProvider(
    settings.provider,
    settings.mapboxToken,
    settings.nominatimBaseUrl,
    settings.language ?? undefined,
  )

  if (!provider) {
    logger.warn('无法创建地理编码提供者，请检查 geocoding 配置和 Token')
    state.provider = null
    state.providerKey = null
    return null
  }

  state.provider = provider
  state.providerKey = providerKey
  return provider
}

async function ensurePhotoContext<T>(builder: AfilmoryBuilder, logger: Logger, fn: () => Promise<T>): Promise<T> {
  try {
    getPhotoExecutionContext()
    return await fn()
  }
  catch {
    const storageConfig = builder.getStorageConfig()
    const storageManager = builder.getStorageManager()
    const normalizeStorageKey = createStorageKeyNormalizer(storageConfig)
    const loggers = createPhotoProcessingLoggers(0, logger)

    return await runWithPhotoExecutionContext(
      {
        builder,
        storageManager,
        storageConfig,
        normalizeStorageKey,
        loggers,
        pools: builder.getRuntimePools(),
      },
      fn,
    )
  }
}

function buildCacheKey(latitude: number, longitude: number, precision: number): string {
  return `${latitude.toFixed(precision)},${longitude.toFixed(precision)}`
}

function enqueueGeocodeLookup(params: {
  photoKey: string
  exif: PickedExif | null | undefined
  state: GeocodingState
  settings: ResolvedGeocodingSettings
  provider: GeocodingProvider
  overwrite: boolean
  runInContext: <T>(fn: () => Promise<T>) => Promise<T>
}): { hadGps: boolean, hasCached: boolean, cachedLocation: LocationInfo | null } {
  const { photoKey, exif, state, settings, provider, overwrite, runInContext } = params
  if (!exif) {
    return { hadGps: false, hasCached: false, cachedLocation: null }
  }

  const { latitude, longitude } = parseGPSCoordinates(exif)
  if (latitude === undefined || longitude === undefined) {
    return { hadGps: false, hasCached: false, cachedLocation: null }
  }

  const cacheKey = buildCacheKey(latitude, longitude, settings.cachePrecision)
  if (state.cache.has(cacheKey)) {
    state.pendingByKey.delete(photoKey)
    return {
      hadGps: true,
      hasCached: true,
      cachedLocation: state.cache.get(cacheKey) ?? null,
    }
  }

  let promise = state.inflight.get(cacheKey)
  if (!promise) {
    promise = runInContext(async () => {
      try {
        const location = await extractLocationFromGPS(latitude, longitude, provider)
        state.cache.set(cacheKey, location ?? null)
        return location ?? null
      }
      catch {
        return null
      }
      finally {
        state.inflight.delete(cacheKey)
      }
    })
    promise.catch(() => null)
    state.inflight.set(cacheKey, promise)
  }

  state.pendingByKey.set(photoKey, { cacheKey, promise, overwrite })
  return { hadGps: true, hasCached: false, cachedLocation: null }
}

export default function geocodingPlugin(options: GeocodingPluginOptions = {}): BuilderPlugin {
  const normalizedOptions = resolveSettings(options)
  let settings: ResolvedGeocodingSettings | null = null

  return {
    name: PLUGIN_NAME,
    hooks: {
      onInit: () => {
        settings = {
          provider: normalizedOptions.provider,
          mapboxToken: normalizedOptions.mapboxToken,
          nominatimBaseUrl: normalizedOptions.nominatimBaseUrl,
          cachePrecision: normalizedOptions.cachePrecision ?? DEFAULT_CACHE_PRECISION,
          language: normalizedOptions.language,
        }
      },
      afterManifestLoad: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable) { return }

        const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest
        if (shouldOverwriteExisting) { return }

        const state = getOrCreateState(runShared)
        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, settings, locationLogger)
        if (!provider) { return }

        const currentSettings = settings
        const runInContext = <T>(fn: () => Promise<T>) => ensurePhotoContext(builder, logger, fn)

        await ensurePhotoContext(builder, logger, async () => {
          for (const item of payload.manifest.data) {
            if (!item || item.location || !item.exif) { continue }
            const queued = enqueueGeocodeLookup({
              photoKey: item.s3Key,
              exif: item.exif,
              state,
              settings: currentSettings,
              provider,
              overwrite: false,
              runInContext,
            })
            if (queued.hasCached && queued.cachedLocation) {
              item.location = queued.cachedLocation
            }
          }
        })
      },
      onExifExtracted: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable) { return }
        if (!payload.exif) { return }

        const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest
        if (payload.existingItem?.location && !shouldOverwriteExisting) {
          return
        }

        const state = getOrCreateState(runShared)
        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, settings, locationLogger)
        if (!provider) { return }

        const currentSettings = settings
        const runInContext = <T>(fn: () => Promise<T>) => ensurePhotoContext(builder, logger, fn)
        await ensurePhotoContext(builder, logger, async () => {
          enqueueGeocodeLookup({
            photoKey: payload.photoKey,
            exif: payload.exif,
            state,
            settings: currentSettings,
            provider,
            overwrite: shouldOverwriteExisting,
            runInContext,
          })
        })
      },
      afterPhotoProcess: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable) { return }

        const { item } = payload.result
        if (!item) { return }

        const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest

        // 当已有位置信息且未强制刷新时，不重复调用地理编码
        if (item.location && !shouldOverwriteExisting) {
          return
        }

        const state = getOrCreateState(runShared)
        const pending = state.pendingByKey.get(item.s3Key)
        if (pending) {
          if (state.cache.has(pending.cacheKey)) {
            const cached = state.cache.get(pending.cacheKey) ?? null
            if (cached) {
              item.location = cached
            }
            else if (shouldOverwriteExisting) {
              item.location = null
            }
            state.pendingByKey.delete(item.s3Key)
          }
          return
        }

        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, settings, locationLogger)
        if (!provider) {
          if (shouldOverwriteExisting) {
            item.location = null
          }
          return
        }

        const exif = item.exif ?? payload.context.existingItem?.exif ?? null
        const currentSettings = settings
        const runInContext = <T>(fn: () => Promise<T>) => ensurePhotoContext(builder, logger, fn)
        const queued = await ensurePhotoContext(builder, logger, async () =>
          enqueueGeocodeLookup({
            photoKey: item.s3Key,
            exif,
            state,
            settings: currentSettings,
            provider,
            overwrite: shouldOverwriteExisting,
            runInContext,
          }))

        if (!queued.hadGps) {
          if (shouldOverwriteExisting) {
            item.location = null
          }
          return
        }

        if (queued.hasCached) {
          if (queued.cachedLocation) {
            item.location = queued.cachedLocation
          }
          else if (shouldOverwriteExisting) {
            item.location = null
          }
        }
      },
      afterProcessTasks: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable) {
          return
        }

        const currentSettings = settings
        const state = getOrCreateState(runShared)
        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, currentSettings, locationLogger)
        if (!provider) {
          await Promise.allSettled(Array.from(state.pendingByKey.values(), job => job.promise))
          state.pendingByKey.clear()
          return
        }

        const storageConfig = builder.getStorageConfig()
        const storageManager = builder.getStorageManager()
        const normalizeStorageKey = createStorageKeyNormalizer(storageConfig)
        const loggers = createPhotoProcessingLoggers(0, logger)

        await runWithPhotoExecutionContext(
          {
            builder,
            storageManager,
            storageConfig,
            normalizeStorageKey,
            loggers,
            pools: builder.getRuntimePools(),
          },
          async () => {
            let attempted = 0
            let updated = 0
            const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest
            const runInContext = <T>(fn: () => Promise<T>) => ensurePhotoContext(builder, logger, fn)
            const itemTasks: Array<Promise<void>> = []

            for (const item of payload.manifest) {
              if (!item) { continue }

              const pending = state.pendingByKey.get(item.s3Key)
              if (pending) {
                itemTasks.push(
                  pending.promise.then((location) => {
                    attempted++
                    if (location) {
                      item.location = location
                      updated++
                    }
                    else if (pending.overwrite) {
                      item.location = null
                    }
                  }),
                )
                continue
              }

              if (item.location) { continue }

              const queued = enqueueGeocodeLookup({
                photoKey: item.s3Key,
                exif: item.exif,
                state,
                settings: currentSettings,
                provider,
                overwrite: shouldOverwriteExisting,
                runInContext,
              })

              if (!queued.hadGps) {
                continue
              }

              if (queued.hasCached) {
                attempted++
                if (queued.cachedLocation) {
                  item.location = queued.cachedLocation
                  updated++
                }
                continue
              }

              const created = state.pendingByKey.get(item.s3Key)
              if (created) {
                itemTasks.push(
                  created.promise.then((location) => {
                    attempted++
                    if (location) {
                      item.location = location
                      updated++
                    }
                    else if (created.overwrite) {
                      item.location = null
                    }
                  }),
                )
              }
            }

            await Promise.all(itemTasks)
            if (state.pendingByKey.size > 0) {
              await Promise.allSettled(Array.from(state.pendingByKey.values(), job => job.promise))
              state.pendingByKey.clear()
            }

            if (attempted > 0) {
              locationLogger.info(`📍 为 ${attempted} 张照片完成逆地理编码，成功 ${updated} 张`)
            }
          },
        )
      },
    },
  }
}

export type { GeocodingPluginOptions }
