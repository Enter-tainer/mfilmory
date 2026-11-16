import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { LocationInfo, PickedExif } from '@afilmory/typing'

import { getGlobalLoggers } from './logger-adapter.js'

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error(typeof reason === 'string' ? reason : 'Geocoding aborted')
  error.name = 'AbortError'
  return error
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal.reason))
  }
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function combineAbortSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

const getBackoffDelay = (attempt: number, baseDelay: number): number => {
  const exponential = baseDelay * 2 ** (attempt - 1)
  const jitter = Math.random() * baseDelay
  return exponential + jitter
}

class NonRetryableGeocodeError extends Error {
  readonly isNotFound: boolean

  constructor(message: string, isNotFound = false) {
    super(message)
    this.name = 'NonRetryableGeocodeError'
    this.isNotFound = isNotFound
  }
}

const INTERPROCESS_RATE_LIMIT_DIR = path.join(os.tmpdir(), 'afilmory-geocoding-rate-limit')
const LOCK_RETRY_DELAY_MS = 50
const LOCK_STALE_TIMEOUT_MS = 5 * 60_000
let rateLimitDirReady: Promise<void> | null = null

const ensureRateLimitDir = async (): Promise<void> => {
  if (!rateLimitDirReady) {
    rateLimitDirReady = fs.mkdir(INTERPROCESS_RATE_LIMIT_DIR, { recursive: true }).then(() => {})
  }
  await rateLimitDirReady
}

const hashKey = (key: string): string => createHash('sha1').update(key).digest('hex')

const getRateLimitPaths = (key: string): { lockPath: string, timestampPath: string } => {
  const hashedKey = hashKey(key)
  return {
    lockPath: path.join(INTERPROCESS_RATE_LIMIT_DIR, `${hashedKey}.lock`),
    timestampPath: path.join(INTERPROCESS_RATE_LIMIT_DIR, `${hashedKey}.ts`),
  }
}

async function tryRemoveLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true }).catch(() => {})
}

const isLockStale = async (lockPath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(lockPath)
    return Date.now() - stat.mtimeMs > LOCK_STALE_TIMEOUT_MS
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function withInterprocessLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await ensureRateLimitDir()
  const { lockPath } = getRateLimitPaths(key)

  while (true) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }

    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.write(`${process.pid}:${Date.now()}`)
      await handle.close()

      try {
        return await fn()
      }
      finally {
        await tryRemoveLock(lockPath)
      }
    }
    catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'EEXIST') {
        if (await isLockStale(lockPath)) {
          await tryRemoveLock(lockPath)
          continue
        }
        await abortableSleep(LOCK_RETRY_DELAY_MS, signal)
        continue
      }
      throw error
    }
  }
}

const applyInterprocessRateLimit = async (
  key: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  const { timestampPath } = getRateLimitPaths(key)

  await withInterprocessLock(
    key,
    async () => {
      let lastRequestTime = 0
      try {
        const stat = await fs.stat(timestampPath)
        lastRequestTime = stat.mtimeMs
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      const now = Date.now()
      const elapsed = now - lastRequestTime
      if (elapsed < intervalMs) {
        await abortableSleep(intervalMs - elapsed, signal)
      }

      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      await fs.writeFile(timestampPath, `${Date.now()}`)
    },
    signal,
  )
}

class SequentialRateLimiter {
  private queue: Promise<void> = Promise.resolve()
  private lastTimestamp = 0

  constructor(private readonly intervalMs: number) {}

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal.reason))
    }

    const next = this.queue.then(async () => {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      const now = Date.now()
      const elapsed = now - this.lastTimestamp
      const delay = elapsed < this.intervalMs ? this.intervalMs - elapsed : 0

      if (delay > 0) {
        await abortableSleep(delay, signal)
      }

      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      this.lastTimestamp = Date.now()
    })

    // Prevent an aborted waiter from breaking subsequent callers in the chain
    this.queue = next.catch(() => {})
    return next
  }
}

interface RateLimiterRegistryGlobal {
  __afilmoryGeocodingRateLimiters?: Map<string, SequentialRateLimiter>
}

const getGlobalRateLimiter = (key: string, intervalMs: number): SequentialRateLimiter => {
  const globalObject = globalThis as typeof globalThis & RateLimiterRegistryGlobal

  if (!globalObject.__afilmoryGeocodingRateLimiters) {
    globalObject.__afilmoryGeocodingRateLimiters = new Map()
  }

  const existing = globalObject.__afilmoryGeocodingRateLimiters.get(key)
  if (existing) {
    return existing
  }

  const limiter = new SequentialRateLimiter(intervalMs)
  globalObject.__afilmoryGeocodingRateLimiters.set(key, limiter)
  return limiter
}

async function runGeocodeWithRetries(params: {
  providerLabel: string
  maxRetries: number
  retryBaseDelayMs: number
  signal?: AbortSignal
  applyRateLimit: (signal?: AbortSignal) => Promise<void>
  attemptRequest: (requestSignal: AbortSignal) => Promise<LocationInfo | null>
}): Promise<LocationInfo | null> {
  const log = getGlobalLoggers().location
  const { providerLabel, maxRetries, retryBaseDelayMs, signal, applyRateLimit, attemptRequest } = params

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return null
    }

    try {
      await applyRateLimit(signal)
      const requestSignal = combineAbortSignals(15_000, signal)
      return await attemptRequest(requestSignal)
    }
    catch (error) {
      if (signal?.aborted) {
        return null
      }

      if (error instanceof NonRetryableGeocodeError) {
        if (error.isNotFound) {
          log.warn(error.message)
        }
        else {
          log.error(error.message)
        }
        return null
      }

      const isLastAttempt = attempt === maxRetries
      if (isLastAttempt) {
        log.error(`${providerLabel} 反向地理编码失败:`, error)
        break
      }

      const delay = getBackoffDelay(attempt, retryBaseDelayMs)
      log.warn(`${providerLabel} API 调用失败，${Math.round(delay)}ms 后重试 (${attempt}/${maxRetries})`, error)
      try {
        await abortableSleep(delay, signal)
      }
      catch {
        if (signal?.aborted) {
          return null
        }
      }
    }
  }

  return null
}

/**
 * 地理编码提供者接口
 */
export interface GeocodingProvider {
  reverseGeocode: (lat: number, lon: number, signal?: AbortSignal) => Promise<LocationInfo | null>
}

/**
 * Mapbox 地理编码提供者
 * 高精度商业地理编码服务，支持全球范围和多语言
 */
export class MapboxGeocodingProvider implements GeocodingProvider {
  private readonly accessToken: string
  private readonly language: string | null
  private readonly baseUrl = 'https://api.mapbox.com'
  private readonly rateLimitMs = 100 // Mapbox 速率限制：1000次/分钟
  private readonly rateLimiter: SequentialRateLimiter
  private readonly interprocessKey: string
  private readonly maxRetries = 3
  private readonly retryBaseDelayMs = 500

  constructor(accessToken: string, language?: string | null) {
    this.accessToken = accessToken
    this.language = language ?? null
    this.rateLimiter = getGlobalRateLimiter(`mapbox:${accessToken}`, this.rateLimitMs)
    this.interprocessKey = `mapbox:${accessToken}`
  }

  async reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<LocationInfo | null> {
    const log = getGlobalLoggers().location

    return await runGeocodeWithRetries({
      providerLabel: 'Mapbox',
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      signal,
      applyRateLimit: abortSignal => this.applyRateLimit(abortSignal),
      attemptRequest: async (requestSignal) => {
        const url = new URL('/search/geocode/v6/reverse', this.baseUrl)
        url.searchParams.set('access_token', this.accessToken)
        url.searchParams.set('longitude', lon.toString())
        url.searchParams.set('latitude', lat.toString())
        if (this.language) {
          url.searchParams.set('language', this.language)
        }

        log.info(`调用 Mapbox API: ${lat}, ${lon}`)

        const response = await fetch(url.toString(), {
          signal: requestSignal,
        })

        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          const message = `Mapbox API 错误: ${response.status} ${response.statusText}`
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new NonRetryableGeocodeError(message)
          }
          throw new Error(message)
        }

        const data = await response.json()

        if (!data || !data.features || data.features.length === 0) {
          log.warn('Mapbox API 未返回结果')
          return null
        }

        // 取第一个最相关的结果
        const feature = data.features[0]
        const properties = feature.properties || {}
        const context = properties.context || {}

        // 提取国家信息
        const country = context.country?.name

        // 提取城市信息 - 拼接多个层级（从小到大）
        const cityParts = [
          context.locality?.name,
          context.neighborhood?.name,
          context.district?.name,
          context.place?.name,
          context.region?.name,
        ].filter(Boolean)

        // 去重并拼接（保持顺序，最多取2个层级）
        const uniqueCityParts = [...new Set(cityParts)].slice(0, 2)
        const city = uniqueCityParts.length > 0 ? uniqueCityParts.join(', ') : undefined

        // 构建位置名称
        const locationName = properties.place_formatted || properties.name

        log.success(`成功获取位置: ${city}, ${country}`)

        return {
          latitude: lat,
          longitude: lon,
          country,
          city,
          locationName,
        }
      },
    })
  }

  private async applyRateLimit(signal?: AbortSignal): Promise<void> {
    await this.rateLimiter.wait(signal)
    await applyInterprocessRateLimit(this.interprocessKey, this.rateLimitMs, signal)
  }
}

/**
 * OpenStreetMap Nominatim API 地理编码提供者
 * 免费的地理编码服务，适合开发和小规模使用
 */
export class NominatimGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl: string
  private readonly language: string | null
  private readonly userAgent = 'afilmory/1.0'
  private readonly rateLimitMs = 1000 // Nominatim 要求至少1秒间隔
  private readonly rateLimiter: SequentialRateLimiter
  private readonly interprocessKey: string
  private readonly maxRetries = 3
  private readonly retryBaseDelayMs = 1000

  constructor(baseUrl?: string, language?: string | null) {
    this.baseUrl = baseUrl || 'https://nominatim.openstreetmap.org'
    this.language = language ?? null
    this.rateLimiter = getGlobalRateLimiter(`nominatim:${this.baseUrl}`, this.rateLimitMs)
    this.interprocessKey = `nominatim:${this.baseUrl}`
  }

  async reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<LocationInfo | null> {
    const log = getGlobalLoggers().location

    return await runGeocodeWithRetries({
      providerLabel: 'Nominatim',
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      signal,
      applyRateLimit: abortSignal => this.applyRateLimit(abortSignal),
      attemptRequest: async (requestSignal) => {
        const url = new URL('/reverse', this.baseUrl)
        url.searchParams.set('lat', lat.toString())
        url.searchParams.set('lon', lon.toString())
        url.searchParams.set('format', 'json')
        url.searchParams.set('addressdetails', '1')
        if (this.language) {
          url.searchParams.set('accept-language', this.language)
        }

        log.info(`调用 Nominatim API: ${lat}, ${lon}`)

        const response = await fetch(url.toString(), {
          signal: requestSignal,
          headers: {
            'User-Agent': this.userAgent,
            ...(this.language ? { 'Accept-Language': this.language } : {}),
          },
        })

        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          const message = `Nominatim API 错误: ${response.status} ${response.statusText}`
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new NonRetryableGeocodeError(message)
          }
          throw new Error(message)
        }

        const data = await response.json()

        if (!data || data.error) {
          const errorText = String(data?.error ?? '未知错误')
          if (/unable to geocode/i.test(errorText)) {
            throw new NonRetryableGeocodeError(`Nominatim 无法解析坐标: ${errorText}`, true)
          }
          throw new Error(`Nominatim API 返回错误: ${errorText}`)
        }

        const address = data.address || {}

        // 提取国家信息
        const country = address.country || address.country_code?.toUpperCase()

        // 提取城市信息 - 拼接多个层级（从小到大）
        const cityParts = [
          address.village,
          address.hamlet,
          address.neighbourhood,
          address.suburb,
          address.district,
          address.city,
          address.town,
          address.county,
          address.state,
        ].filter(Boolean)

        // 去重并拼接（保持顺序，最多取2个层级）
        const uniqueCityParts = [...new Set(cityParts)].slice(0, 2)
        const city = uniqueCityParts.length > 0 ? uniqueCityParts.join(', ') : undefined

        // 构建位置名称
        const locationName = data.display_name

        log.success(`成功获取位置: ${city}, ${country}`)

        return {
          latitude: lat,
          longitude: lon,
          country,
          city,
          locationName,
        }
      },
    })
  }

  private async applyRateLimit(signal?: AbortSignal): Promise<void> {
    await this.rateLimiter.wait(signal)
    await applyInterprocessRateLimit(this.interprocessKey, this.rateLimitMs, signal)
  }
}

/**
 * 创建地理编码提供者实例
 * @param provider 提供者类型
 * @param mapboxToken Mapbox access token（可选）
 * @param nominatimBaseUrl Nominatim 基础 URL（可选）
 * @param language 首选语言（可选，逗号分隔的 BCP47 列表）
 */
export function createGeocodingProvider(
  provider: 'mapbox' | 'nominatim' | 'auto',
  mapboxToken?: string,
  nominatimBaseUrl?: string,
  language?: string | null,
): GeocodingProvider | null {
  // 如果指定了 Mapbox 或自动模式且有 token，使用 Mapbox
  if ((provider === 'mapbox' || provider === 'auto') && mapboxToken) {
    return new MapboxGeocodingProvider(mapboxToken, language)
  }

  // 使用 Nominatim
  if (provider === 'nominatim' || provider === 'auto') {
    return new NominatimGeocodingProvider(nominatimBaseUrl, language)
  }

  return null
}

/**
 * 从 EXIF GPS 数据中提取坐标
 * @param exif EXIF 数据
 * @returns 十进制坐标（latitude, longitude）
 */
export function parseGPSCoordinates(exif: PickedExif): {
  latitude?: number
  longitude?: number
} {
  const log = getGlobalLoggers().location

  try {
    let latitude: number | undefined
    let longitude: number | undefined

    // 从 GPSLatitude 和 GPSLongitude 提取
    const rawLat = exif.GPSLatitude
    const rawLon = exif.GPSLongitude
    if (
      rawLat !== undefined
      && rawLat !== null
      && rawLon !== undefined
      && rawLon !== null
      && String(rawLat).trim() !== ''
      && String(rawLon).trim() !== ''
    ) {
      const parsedLat = Number(rawLat)
      const parsedLon = Number(rawLon)
      if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
        latitude = parsedLat
        longitude = parsedLon
      }
    }

    if (latitude === undefined || longitude === undefined) {
      return {}
    }

    // 应用 GPS 参考（南纬为负，西经为负）
    if (exif.GPSLatitudeRef === 'S' || exif.GPSLatitudeRef === 'South') {
      latitude = -Math.abs(latitude)
    }
    if (exif.GPSLongitudeRef === 'W' || exif.GPSLongitudeRef === 'West') {
      longitude = -Math.abs(longitude)
    }

    return { latitude, longitude }
  }
  catch (error) {
    log.error('解析 GPS 坐标失败:', error)
    return {}
  }
}

/**
 * 从 GPS 坐标提取位置信息（反向地理编码）
 * @param latitude 纬度
 * @param longitude 经度
 * @param provider 地理编码提供者
 * @param signal 可选中止信号
 * @returns 位置信息
 */
export async function extractLocationFromGPS(
  latitude: number,
  longitude: number,
  provider: GeocodingProvider,
  signal?: AbortSignal,
): Promise<LocationInfo | null> {
  const log = getGlobalLoggers().location

  // 验证坐标范围
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    log.warn(`无效的 GPS 坐标: ${latitude}, ${longitude}`)
    return null
  }

  if (signal?.aborted) {
    return null
  }

  log.info(`反向地理编码坐标: ${latitude}, ${longitude}`)

  try {
    const locationInfo = await provider.reverseGeocode(latitude, longitude, signal)

    if (signal?.aborted) {
      return null
    }

    if (locationInfo) {
      log.success(`位置已找到: ${locationInfo.city}, ${locationInfo.country}`)
    }
    else {
      log.warn('未找到位置信息')
    }

    return locationInfo
  }
  catch (error) {
    if (signal?.aborted) {
      return null
    }
    log.error('位置提取失败:', error)
    return null
  }
}
