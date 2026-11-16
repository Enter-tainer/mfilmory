import { backoffDelay, sleep } from '../../../../utils/src/backoff.js'
import type { StorageRetryConfig } from '../interfaces.js'

/** HTTP 状态错误，供 `isRetryableError` 区分瞬时错误和配置/权限错误。 */
export class StorageHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'StorageHttpError'
    this.status = status
  }
}

export interface ResolvedRetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  uploadTimeoutMs: number
}

function normalizeNonNegNumber(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback
}

export function resolveRetryOptions(config?: StorageRetryConfig): ResolvedRetryOptions {
  return {
    maxAttempts: normalizeNonNegNumber(config?.maxAttempts, 3, 1),
    baseDelayMs: normalizeNonNegNumber(config?.retryBaseDelayMs, 300, 0),
    maxDelayMs: normalizeNonNegNumber(config?.retryMaxDelayMs, 4000, 0),
    uploadTimeoutMs: normalizeNonNegNumber(config?.uploadTimeoutMs, 60_000, 0),
  }
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * 只重试瞬时错误：网络错误 / 超时 / 408 / 425 / 429 / 5xx。
 * 401/403/404/422 这类配置或权限错误直接抛出，避免把错误延迟 maxAttempts 倍。
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  if (error instanceof StorageHttpError) {
    return isRetryableHttpStatus(error.status)
  }

  const candidate = error as {
    code?: unknown
    name?: unknown
    message?: unknown
    cause?: { code?: unknown }
    status?: unknown
  }

  if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') {
    return true
  }

  const status = typeof candidate.status === 'number' ? candidate.status : undefined
  if (status !== undefined) {
    return isRetryableHttpStatus(status)
  }

  const code = candidate.code ?? candidate.cause?.code
  if (typeof code === 'string') {
    if (code.startsWith('UND_ERR_') || RETRYABLE_CODES.has(code)) {
      return true
    }
  }

  const message = typeof candidate.message === 'string' ? candidate.message : ''
  if (candidate.name === 'TypeError' && /fetch failed|network/i.test(message)) {
    return true
  }

  return /ECONNRESET|ETIMEDOUT|socket hang up|other side closed|premature close/i.test(message)
}

export interface RetryLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}

export interface WithRetryOptions extends ResolvedRetryOptions {
  label: string
  logger?: RetryLogger
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, label, logger } = options

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt)
    }
    catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error
      }

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs)
      logger?.warn(`${label} 失败（attempt ${attempt}/${maxAttempts}，${delay}ms 后重试）`, error)
      await sleep(delay)
    }
  }
}

/** 上传请求的 AbortSignal（`uploadTimeoutMs = 0` 表示不限制）。 */
export function uploadAbortSignal(uploadTimeoutMs: number): AbortSignal | undefined {
  return uploadTimeoutMs > 0 ? AbortSignal.timeout(uploadTimeoutMs) : undefined
}
