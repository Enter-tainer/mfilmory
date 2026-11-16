import { loadConfig } from 'c12'
import consola from 'consola'

import type { StorageConfig } from '../storage/interfaces.js'
import type { BuilderConfig, BuilderConfigInput, UserBuilderSettings } from '../types/config.js'
import { clone } from '../utils/clone.js'
import { createDefaultBuilderConfig } from './defaults.js'

export interface LoadBuilderConfigOptions {
  cwd?: string
  configFile?: string
}

function normalizeIntSetting(
  value: unknown,
  min: number,
  name: string,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    consola.warn(`[config] system.processing.${name} 无效 (${String(value)})，将使用默认值`)
    return undefined
  }
  const floored = Math.floor(value)
  if (floored < min) {
    if (min === 1 && value > 0) {
      consola.warn(`[config] system.processing.${name}=${value} 小于 ${min}，已钳制为 ${min}`)
      return min
    }
    consola.warn(`[config] system.processing.${name}=${value} 无效（需 >= ${min}），将使用默认值`)
    return undefined
  }
  if (floored !== value) {
    consola.warn(`[config] system.processing.${name}=${value} 非整数，已取整为 ${floored}`)
  }
  return floored
}

function applySystemOverrides(target: BuilderConfig['system'], overrides?: BuilderConfigInput['system']): void {
  if (!overrides) { return }

  if (overrides.processing) {
    const { processing } = overrides
    if (processing.cpuConcurrency === 'auto') {
      target.processing.cpuConcurrency = 'auto'
    }
    else if (processing.cpuConcurrency !== undefined) {
      const normalized = normalizeIntSetting(processing.cpuConcurrency, 1, 'cpuConcurrency')
      if (normalized !== undefined) {
        target.processing.cpuConcurrency = normalized
      }
    }
    if (processing.sharpConcurrency === 'auto') {
      target.processing.sharpConcurrency = 'auto'
    }
    else if (processing.sharpConcurrency !== undefined) {
      const normalized = normalizeIntSetting(processing.sharpConcurrency, 1, 'sharpConcurrency')
      if (normalized !== undefined) {
        target.processing.sharpConcurrency = normalized
      }
    }
    if (processing.cpuWorkerCount === 'auto') {
      target.processing.cpuWorkerCount = 'auto'
    }
    else if (processing.cpuWorkerCount !== undefined) {
      const normalized = normalizeIntSetting(processing.cpuWorkerCount, 0, 'cpuWorkerCount')
      if (normalized !== undefined) {
        target.processing.cpuWorkerCount = normalized
      }
    }
    if (processing.networkConcurrency !== undefined) {
      const normalized = normalizeIntSetting(processing.networkConcurrency, 1, 'networkConcurrency')
      if (normalized !== undefined) {
        target.processing.networkConcurrency = normalized
      }
    }
    if (typeof processing.enableLivePhotoDetection === 'boolean') {
      target.processing.enableLivePhotoDetection = processing.enableLivePhotoDetection
    }
    if (processing.digestSuffixLength !== undefined) {
      target.processing.digestSuffixLength = processing.digestSuffixLength
    }
    if (processing.xmp) {
      target.processing.xmp = {
        ...(target.processing.xmp ?? { keywords: true, regions: true }),
        ...processing.xmp,
      }
    }
    if (processing.limitInputPixels !== undefined) {
      target.processing.limitInputPixels = processing.limitInputPixels
    }
    if (processing.supportedFormats) {
      target.processing.supportedFormats = new Set(processing.supportedFormats as Set<string>)
    }
  }

  if (overrides.observability) {
    const { observability } = overrides
    if (typeof observability.showProgress === 'boolean') {
      target.observability.showProgress = observability.showProgress
    }
    if (typeof observability.showDetailedStats === 'boolean') {
      target.observability.showDetailedStats = observability.showDetailedStats
    }
    if (observability.logging) {
      target.observability.logging = {
        ...target.observability.logging,
        ...observability.logging,
      }
    }
  }
}

function ensureUserSettings(target: BuilderConfig): UserBuilderSettings {
  if (!target.user) {
    target.user = {
      storage: null,
    }
  }
  return target.user
}

function applyUserOverrides(target: BuilderConfig, overrides?: BuilderConfigInput['user']): void {
  if (!overrides) { return }
  const user = ensureUserSettings(target)

  if (overrides.storage !== undefined) {
    user.storage = overrides.storage as StorageConfig | null
  }
}

function normalizeBuilderConfig(defaults: BuilderConfig, input: BuilderConfigInput): BuilderConfig {
  const next = clone(defaults)

  applySystemOverrides(next.system, input.system)
  applyUserOverrides(next, input.user)

  if (input.storage !== undefined) {
    ensureUserSettings(next).storage = input.storage ?? null
  }

  if (Array.isArray(input.plugins)) {
    next.plugins = [...input.plugins]
  }

  return next
}

export function resolveBuilderConfig(input: BuilderConfigInput, base?: BuilderConfig): BuilderConfig {
  const defaults = base ? clone(base) : createDefaultBuilderConfig()
  return normalizeBuilderConfig(defaults, input)
}

export async function loadBuilderConfig(options: LoadBuilderConfigOptions = {}): Promise<BuilderConfig> {
  const result = await loadConfig<BuilderConfigInput>({
    name: 'builder',
    cwd: options.cwd ?? process.cwd(),
    configFile: options.configFile,
    rcFile: false,
    dotenv: false,
  })

  const userConfig = result.config ?? {}

  const config = resolveBuilderConfig(userConfig)

  if (!config.user?.storage) {
    throw new Error('缺失存储配置，请配置 storage 字段')
  }

  if (process.env.DEBUG === '1') {
    const logger = consola.withTag('CONFIG')
    logger.info('Using builder config from', result.configFile ?? 'defaults')
    logger.info(config)
  }

  return config
}
