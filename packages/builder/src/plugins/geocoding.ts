import type { LocationInfo, PhotoManifestItem, PickedExif } from '@afilmory/typing'

import type { AfilmoryBuilder } from '../builder/builder.js'
import type { Logger } from '../logger/index.js'
import {
  createStorageKeyNormalizer,
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
  existingManifestMap: Map<string, PhotoManifestItem>
  cache: Map<string, LocationInfo>
  inflight: Map<string, Promise<LocationInfo | null>>
  pendingByKey: Map<string, PendingGeocodeJob>
  abortController: AbortController
  boundSignal?: AbortSignal
  onBoundAbort?: () => void
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
  if (!value) {
    return null
  }
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
    existingManifestMap: new Map(),
    cache: new Map(),
    inflight: new Map(),
    pendingByKey: new Map(),
    abortController: new AbortController(),
  }
  runShared.set(RUN_STATE_KEY, next)
  return next
}

function bindStateAbortSignal(state: GeocodingState, signal?: AbortSignal): void {
  if (!signal) {
    return
  }
  if (signal.aborted) {
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(signal.reason)
    }
    return
  }
  if (state.boundSignal === signal) {
    return
  }
  unbindStateAbortSignal(state)
  const onAbort = () => {
    state.abortController.abort(signal.reason)
  }
  state.boundSignal = signal
  state.onBoundAbort = onAbort
  signal.addEventListener('abort', onAbort, { once: true })
}

function unbindStateAbortSignal(state: GeocodingState): void {
  if (state.boundSignal && state.onBoundAbort) {
    state.boundSignal.removeEventListener('abort', state.onBoundAbort)
    state.boundSignal = undefined
    state.onBoundAbort = undefined
  }
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

function createNeutralContextRunner(builder: AfilmoryBuilder, logger: Logger): <T>(fn: () => Promise<T>) => Promise<T> {
  const storageConfig = builder.getStorageConfig()
  const storageManager = builder.getStorageManager()
  const normalizeStorageKey = createStorageKeyNormalizer(storageConfig)
  const loggers = createPhotoProcessingLoggers(0, logger)

  return async <T>(fn: () => Promise<T>): Promise<T> =>
    await runWithPhotoExecutionContext(
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

async function drainPendingJobs(state: GeocodingState): Promise<void> {
  if (state.pendingByKey.size > 0) {
    await Promise.allSettled(Array.from(state.pendingByKey.values(), job => job.promise))
    state.pendingByKey.clear()
  }
  if (state.inflight.size > 0) {
    await Promise.allSettled(Array.from(state.inflight.values()))
    state.inflight.clear()
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
  if (!exif || state.abortController.signal.aborted) {
    return { hadGps: false, hasCached: false, cachedLocation: null }
  }

  const { latitude, longitude } = parseGPSCoordinates(exif)
  if (latitude === undefined || longitude === undefined) {
    return { hadGps: false, hasCached: false, cachedLocation: null }
  }

  const cacheKey = buildCacheKey(latitude, longitude, settings.cachePrecision)
  const cachedLocation = state.cache.get(cacheKey)
  if (cachedLocation) {
    state.pendingByKey.delete(photoKey)
    return {
      hadGps: true,
      hasCached: true,
      cachedLocation,
    }
  }

  let promise = state.inflight.get(cacheKey)
  if (!promise) {
    promise = runInContext(async () => {
      try {
        const location = await extractLocationFromGPS(
          latitude,
          longitude,
          provider,
          state.abortController.signal,
        )
        if (location) {
          state.cache.set(cacheKey, location)
          return location
        }
        return null
      }
      catch {
        return null
      }
      finally {
        state.inflight.delete(cacheKey)
      }
    }).catch(() => null)
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
      afterManifestLoad: ({ payload, runShared }) => {
        if (!settings || !normalizedOptions.enable) {
          return
        }

        const state = getOrCreateState(runShared)
        state.existingManifestMap.clear()
        for (const item of payload.manifest.data) {
          if (item?.s3Key) {
            state.existingManifestMap.set(item.s3Key, item)
          }
        }
      },
      afterImagesListed: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable || payload.options.dryRun) {
          return
        }
        if (payload.imageObjects.length === 0) {
          return
        }

        const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest
        if (shouldOverwriteExisting) {
          return
        }

        const state = getOrCreateState(runShared)
        bindStateAbortSignal(state, payload.options.signal)
        if (state.existingManifestMap.size === 0 || state.abortController.signal.aborted) {
          return
        }

        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, settings, locationLogger)
        if (!provider) {
          return
        }

        const currentSettings = settings
        const runInNeutralContext = createNeutralContextRunner(builder, logger)
        await runInNeutralContext(async () => {
          for (const obj of payload.imageObjects) {
            const item = state.existingManifestMap.get(obj.key)
            if (!item || item.location || !item.exif) {
              continue
            }
            if (item.lastModified !== obj.lastModified?.toISOString()) {
              continue
            }

            const queued = enqueueGeocodeLookup({
              photoKey: item.s3Key,
              exif: item.exif,
              state,
              settings: currentSettings,
              provider,
              overwrite: false,
              runInContext: runInNeutralContext,
            })
            if (queued.hasCached && queued.cachedLocation) {
              item.location = queued.cachedLocation
            }
          }
        })
      },
      onExifExtracted: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable || payload.options.dryRun) {
          return
        }
        if (!payload.exif) {
          return
        }

        const fileReplaced = Boolean(
          payload.existingItem
          && payload.existingItem.lastModified !== payload.context.obj.LastModified?.toISOString(),
        )
        const shouldOverwriteExisting
          = payload.options.isForceMode || payload.options.isForceManifest || fileReplaced
        if (payload.existingItem?.location && !shouldOverwriteExisting) {
          return
        }

        const state = getOrCreateState(runShared)
        bindStateAbortSignal(state, payload.options.signal)
        if (state.abortController.signal.aborted) {
          return
        }
        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, settings, locationLogger)
        if (!provider) {
          return
        }

        const currentSettings = settings
        const runInNeutralContext = createNeutralContextRunner(builder, logger)
        await runInNeutralContext(async () => {
          enqueueGeocodeLookup({
            photoKey: payload.photoKey,
            exif: payload.exif,
            state,
            settings: currentSettings,
            provider,
            overwrite: shouldOverwriteExisting,
            runInContext: runInNeutralContext,
          })
        })
      },
      afterPhotoProcess: async ({ builder, payload, runShared, logger }) => {
        if (!settings || !normalizedOptions.enable || payload.options.dryRun) {
          return
        }

        const { item } = payload.result
        if (!item) {
          return
        }

        const existingItem = payload.context.existingItem
        const fileReplaced = Boolean(
          existingItem && existingItem.lastModified !== payload.context.obj.LastModified?.toISOString(),
        )
        const shouldOverwriteExisting
          = payload.options.isForceMode || payload.options.isForceManifest || fileReplaced

        // 当已有位置信息且未强制刷新时，不重复调用地理编码
        if (item.location && !shouldOverwriteExisting) {
          return
        }

        const state = getOrCreateState(runShared)
        bindStateAbortSignal(state, payload.options.signal)
        const pending = state.pendingByKey.get(item.s3Key)
        if (pending) {
          const cached = state.cache.get(pending.cacheKey)
          if (cached) {
            item.location = cached
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

        const exif = item.exif ?? (fileReplaced ? null : existingItem?.exif ?? null)
        const currentSettings = settings
        const runInNeutralContext = createNeutralContextRunner(builder, logger)
        const queued = await runInNeutralContext(async () =>
          enqueueGeocodeLookup({
            photoKey: item.s3Key,
            exif,
            state,
            settings: currentSettings,
            provider,
            overwrite: shouldOverwriteExisting,
            runInContext: runInNeutralContext,
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
        if (!settings || !normalizedOptions.enable || payload.options.dryRun) {
          return
        }

        const currentSettings = settings
        const state = getOrCreateState(runShared)
        bindStateAbortSignal(state, payload.options.signal)
        if (state.abortController.signal.aborted) {
          await drainPendingJobs(state)
          return
        }
        const locationLogger = logger.main.withTag('LOCATION')
        const provider = ensureProvider(state, currentSettings, locationLogger)
        if (!provider) {
          await drainPendingJobs(state)
          return
        }

        const resultsByKey = new Map<string, NonNullable<(typeof payload.results)[number]['item']>>()
        for (const result of payload.results) {
          if (result?.item?.s3Key) {
            resultsByKey.set(result.item.s3Key, result.item)
          }
        }

        const runInNeutralContext = createNeutralContextRunner(builder, logger)
        await runInNeutralContext(async () => {
          let attempted = 0
          let updated = 0
          const shouldOverwriteExisting = payload.options.isForceMode || payload.options.isForceManifest
          const itemTasks: Array<Promise<void>> = []

          const applyLocation = (
            manifestItem: PhotoManifestItem,
            location: LocationInfo | null,
            overwrite: boolean,
          ) => {
            const resultItem = resultsByKey.get(manifestItem.s3Key)
            attempted++
            if (location) {
              manifestItem.location = location
              if (resultItem && resultItem !== manifestItem) {
                resultItem.location = location
              }
              updated++
            }
            else if (overwrite) {
              manifestItem.location = null
              if (resultItem && resultItem !== manifestItem) {
                resultItem.location = null
              }
            }
          }

          for (const item of payload.manifest) {
            if (!item) {
              continue
            }

            const pending = state.pendingByKey.get(item.s3Key)
            if (pending) {
              itemTasks.push(
                pending.promise.then((location) => {
                  applyLocation(item, location, pending.overwrite)
                }),
              )
              continue
            }

            if (item.location) {
              continue
            }

            const queued = enqueueGeocodeLookup({
              photoKey: item.s3Key,
              exif: item.exif,
              state,
              settings: currentSettings,
              provider,
              overwrite: shouldOverwriteExisting,
              runInContext: runInNeutralContext,
            })

            if (!queued.hadGps) {
              continue
            }

            if (queued.hasCached) {
              applyLocation(item, queued.cachedLocation, shouldOverwriteExisting)
              continue
            }

            const created = state.pendingByKey.get(item.s3Key)
            if (created) {
              itemTasks.push(
                created.promise.then((location) => {
                  applyLocation(item, location, created.overwrite)
                }),
              )
            }
          }

          await Promise.all(itemTasks)
          await drainPendingJobs(state)

          if (attempted > 0) {
            locationLogger.info(`📍 为 ${attempted} 张照片完成逆地理编码，成功 ${updated} 张`)
          }
        })
      },
      afterBuild: async ({ runShared }) => {
        const state = runShared.get(RUN_STATE_KEY) as GeocodingState | undefined
        if (state) {
          await drainPendingJobs(state)
          unbindStateAbortSignal(state)
        }
      },
      onError: async ({ payload, runShared }) => {
        const state = runShared.get(RUN_STATE_KEY) as GeocodingState | undefined
        if (state) {
          state.abortController.abort(payload.error)
          await drainPendingJobs(state)
          unbindStateAbortSignal(state)
        }
      },
    },
  }
}

export type { GeocodingPluginOptions }
