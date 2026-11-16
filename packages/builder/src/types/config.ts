import type { BuilderPluginConfigEntry } from '../plugins/types.js'
import type { StorageConfig } from '../storage/interfaces.js'

export interface LoggingConfig {
  verbose: boolean
  level: 'info' | 'warn' | 'error' | 'debug'
  outputToFile: boolean
  logFilePath?: string
}

export interface XmpProcessingSettings {
  keywords: boolean
  regions: boolean
}

export interface SystemProcessingSettings {
  /**
   * 并发纯 CPU 任务槽位数（`'auto'` 默认取 CPU 逻辑核数）。
   */
  cpuConcurrency: number | 'auto'
  /**
   * 单个 sharp 任务内部使用的 libvips 线程数（透传到 `sharp.concurrency()`）。
   * - `'auto'`（默认）：待处理数 >= CPU 核数时取 `1`（总 CPU 开销最低）；小批量时自动放大（最高 4）以压低尾延迟。
   */
  sharpConcurrency: number | 'auto'
  /**
   * 纯 CPU 子进程数（`'auto'` 按核数拆出少数轻量子进程隔离 sharp/WASM 对主进程 libuv 的阻塞；`0` 表示同进程执行）。
   */
  cpuWorkerCount: number | 'auto'
  /**
   * 网络池并发上限（用于下载/上传限流）。
   * 优先级：`storage.downloadConcurrency` / `storage.uploadConcurrency` 优先于此值；
   * 构建期由 `NetworkPool` 统一单层限流，未配置 storage 并发时默认沿用此处配置。
   */
  networkConcurrency: number
  enableLivePhotoDetection: boolean
  xmp?: XmpProcessingSettings
  supportedFormats?: Set<string>
  digestSuffixLength?: number
  /**
   * Do not process input images where the number of pixels (width x height) exceeds this limit.
   * - `number`: An integral Number of pixels as the limit
   * - `false` or `0`: Remove limit entirely
   * - `true` or `undefined`: Use sharp's default limit of 268402689 (0x3FFF x 0x3FFF)
   * @default undefined (uses sharp's default: 268402689)
   */
  limitInputPixels?: number | boolean
}

export interface SystemObservabilitySettings {
  showProgress: boolean
  showDetailedStats: boolean
  logging: LoggingConfig
}

export interface SystemBuilderSettings {
  processing: SystemProcessingSettings
  observability: SystemObservabilitySettings
}

export interface UserBuilderSettings {
  storage: StorageConfig | null
}

export interface BuilderConfig {
  system: SystemBuilderSettings
  user: UserBuilderSettings | null
  plugins: BuilderPluginConfigEntry[]
}

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>
    }
  : T

export type BuilderConfigInput = {
  storage?: StorageConfig | null
  user?: DeepPartial<UserBuilderSettings>
  system?: DeepPartial<SystemBuilderSettings>
  plugins?: BuilderPluginConfigEntry[]
}
