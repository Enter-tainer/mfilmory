import type { Plugin } from 'vite'

import { cleanupOldOGImages } from '../../../../scripts/cleanup-og-images.js'
import { generateFavicons } from '../../../../scripts/generate-favicon.js'
import { buildHomeOgCopy, generateOGImage } from '../../../../scripts/generate-og-image.js'

interface OGImagePluginOptions {
  title?: string
  description?: string
  siteName?: string
  siteUrl?: string
}

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * 站点级 OG 图与社交卡片 meta。
 *
 * 图片本身只有照片（见 `scripts/generate-og-image.ts`）；标题、描述交给分享平台
 * 原生渲染。`<title>` 和 `name=description` 由 `index.html` / `createHtmlPlugin`
 * 负责，这里不再重复注入——之前这里也塞了一份 description，结果构建出的
 * `index.html` 里有两个 `meta[name=description]`。
 *
 * 单张照片页的 og:title / og:description 由 Cloudflare 中间件在边缘改写
 * （见 `packages/builder/src/plugins/og-image-storage/vendors/`）。
 */
export function ogImagePlugin(options: OGImagePluginOptions = {}): Plugin {
  const {
    title = 'Afilmory',
    description = 'A photo gallery.',
    siteName = title,
    siteUrl,
  } = options

  let ogImagePath = ''

  return {
    name: 'og-image-plugin',
    async buildStart() {
      // 在构建开始时生成 OG 图片
      const fileName = `og-image-${Date.now()}.webp`

      try {
        // 生成 favicon
        await generateFavicons()

        // 生成 OG 图片（一张满幅照片，没有底色和文字）
        ogImagePath = await generateOGImage({ outputPath: fileName })

        // 清理旧的 OG 图片
        await cleanupOldOGImages(3)
      }
      catch (error) {
        console.error('Failed to generate OG image:', error)
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!ogImagePath) {
          console.warn('⚠️  No OG image path available')
          return html
        }

        const copy = buildHomeOgCopy({ siteName, siteDescription: description })
        const pageUrl = siteUrl ?? '/'
        const imageUrl = siteUrl ? new URL(ogImagePath, siteUrl).href : ogImagePath

        // 生成 meta 标签
        const metaTags = `
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeAttribute(pageUrl)}" />
    <meta property="og:title" content="${escapeAttribute(copy.title)}" />
    <meta property="og:description" content="${escapeAttribute(copy.description)}" />
    <meta property="og:image" content="${escapeAttribute(imageUrl)}" />
    <meta property="og:site_name" content="${escapeAttribute(siteName)}" />

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:url" content="${escapeAttribute(pageUrl)}" />
    <meta property="twitter:title" content="${escapeAttribute(copy.title)}" />
    <meta property="twitter:description" content="${escapeAttribute(copy.description)}" />
    <meta property="twitter:image" content="${escapeAttribute(imageUrl)}" />

    <!-- Additional meta tags -->
    <meta name="author" content="${escapeAttribute(siteName)}" />
    <meta name="generator" content="Vite + React" />
    <meta name="robots" content="index, follow" />
    <meta name="theme-color" content="#0a0a0a" />
    <meta name="msapplication-TileColor" content="#0a0a0a" />

    <!-- Favicon and app icons -->
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="shortcut icon" href="/favicon.ico" />
        `

        // 在 </head> 标签前插入 meta 标签
        return html.replace('</head>', `${metaTags}\n  </head>`)
      },
    },
  }
}
