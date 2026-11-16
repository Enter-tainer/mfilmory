import type { BuilderConfig } from '../types/config.js'

export function createDefaultBuilderConfig(): BuilderConfig {
  return {
    system: {
      processing: {
        cpuConcurrency: 'auto',
        sharpConcurrency: 'auto',
        cpuWorkerCount: 'auto',
        networkConcurrency: 16,
        enableLivePhotoDetection: true,
        digestSuffixLength: 0,
        xmp: {
          keywords: true,
          regions: true,
        },
      },
      observability: {
        showProgress: true,
        showDetailedStats: true,
        logging: {
          verbose: false,
          level: 'info',
          outputToFile: false,
        },
      },
    },
    user: null!,
    plugins: [],
  }
}
