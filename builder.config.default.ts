import { defineBuilderConfig, githubRepoSyncPlugin } from '@afilmory/builder'

import { env } from './env.js'

export default defineBuilderConfig(() => ({
  storage: {
    // "provider": "local",
    // "basePath": "./apps/web/public/photos",
    // "baseUrl": "/photos"

    provider: 's3',
    bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
    customDomain: env.S3_CUSTOM_DOMAIN,
    excludeRegex: env.S3_EXCLUDE_REGEX,
    keepAlive: true,
    maxSockets: 64,
    connectionTimeoutMs: 5_000,
    socketTimeoutMs: 30_000,
    requestTimeoutMs: 20_000,
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 60_000,
    retryMode: 'standard',
    // 下载/上传共用：只对网络错误和 408/425/429/5xx 重试，4xx 直接失败
    maxAttempts: 3,
    retryBaseDelayMs: 300,
    retryMaxDelayMs: 4_000,
    uploadTimeoutMs: 60_000,
    downloadConcurrency: 16,
  },
  system: {
    processing: {
      cpuConcurrency: 'auto',
      sharpConcurrency: 'auto',
      cpuWorkerCount: 'auto',
      networkConcurrency: 16,
      enableLivePhotoDetection: true,
      digestSuffixLength: 8,
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
  // plugins: [thumbnailStoragePlugin()],
  //
  // OG image plugin (optional): renders `.afilmory/og-images/<id>.webp`（就是照片本身，
  // 长边上限 1200）并在 `pnpm build` 时上传。分享卡片用的 og:title / og:description /
  // og:image 由 apps/web 的 `ssg-prerender` 在构建期写进每张 `photos/<id>.html`；
  // 站点没有 Cloudflare Pages Functions。
  //
  // Import it from '@afilmory/builder' first, then uncomment:
  // ogImagePlugin(),
  plugins: [
    githubRepoSyncPlugin({
      repo: {
        enable: false,
        url: process.env.BUILDER_REPO_URL ?? '',
        token: env.GIT_TOKEN,
        branch: process.env.BUILDER_REPO_BRANCH ?? 'main',
      },
    }),
  ],
}))
