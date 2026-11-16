import { AsyncLocalStorage } from 'node:async_hooks'

import { Semaphore } from '../../../utils/src/semaphore.js'

const networkPoolStorage = new AsyncLocalStorage<boolean>()

/**
 * 标记当前异步调用栈是否已受外层 `NetworkPool` 限流。
 * `S3StorageProvider` 等底层存储实现藉此避免重复排队两层 semaphore，
 * 而脱离 builder 单独调用时仍保留自身并发上限。
 */
export function isManagedByNetworkPool(): boolean {
  return networkPoolStorage.getStore() === true
}

export interface NetworkPoolOptions {
  downloadConcurrency: number
  uploadConcurrency: number
}

/**
 * 网络并发池：将下载与上传分别按各自连接上限限流，避免上传小文件被大批下载阻塞，
 * 也避免大量产物并发 PUT 触发存储端限流。
 *
 * 优先级：`storage.downloadConcurrency` / `storage.uploadConcurrency` 优先于
 * `system.processing.networkConcurrency`；构建期由本池做单层权威限流。
 */
export class NetworkPool {
  readonly downloadLimiter: Semaphore
  readonly uploadLimiter: Semaphore
  readonly downloadConcurrency: number
  readonly uploadConcurrency: number

  constructor(options: NetworkPoolOptions) {
    this.downloadConcurrency = Number.isFinite(options.downloadConcurrency) && options.downloadConcurrency > 0
      ? Math.max(1, Math.floor(options.downloadConcurrency))
      : 16
    this.uploadConcurrency = Number.isFinite(options.uploadConcurrency) && options.uploadConcurrency > 0
      ? Math.max(1, Math.floor(options.uploadConcurrency))
      : 16
    this.downloadLimiter = new Semaphore(this.downloadConcurrency)
    this.uploadLimiter = new Semaphore(this.uploadConcurrency)
  }

  download<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.downloadLimiter.run(() => networkPoolStorage.run(true, fn), signal)
  }

  upload<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.uploadLimiter.run(() => networkPoolStorage.run(true, fn), signal)
  }
}
