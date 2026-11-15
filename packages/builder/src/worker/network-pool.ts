import { Semaphore } from '../../../utils/src/semaphore.js'

export interface NetworkPoolOptions {
  downloadConcurrency: number
  uploadConcurrency: number
}

/**
 * 网络并发池：将下载与上传分别按各自连接上限限流，避免上传小文件被大批下载阻塞，
 * 也避免大量产物并发 PUT 触发存储端限流。
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

  download<T>(fn: () => Promise<T>): Promise<T> {
    return this.downloadLimiter.run(fn)
  }

  upload<T>(fn: () => Promise<T>): Promise<T> {
    return this.uploadLimiter.run(fn)
  }
}
