import { readFileSync } from 'node:fs'

import type { PhotoManifestItem } from '@afilmory/builder'
import { tsImport } from 'tsx/esm/api'
import type { Plugin } from 'vite'

import type { SiteConfig } from '../../../../site.config'
import { MANIFEST_PATH } from './__internal__/constants'

const { generateRSSFeed } = await tsImport('@afilmory/utils', import.meta.url)

export function createFeedSitemapPlugin(siteConfig: SiteConfig): Plugin {
  return {
    name: 'feed-sitemap-generator',
    apply: 'build',
    generateBundle() {
      try {
        const photosData: PhotoManifestItem[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')).data

        // Sort photos by date taken (newest first)
        const sortedPhotos = photosData.sort(
          (a, b) => new Date(b.dateTaken).getTime() - new Date(a.dateTaken).getTime(),
        )

        // Generate RSS feed
        const rssXml = generateRSSFeed(sortedPhotos, siteConfig)

        // Generate sitemap
        const sitemapXml = generateSitemap(sortedPhotos, siteConfig)

        // Emit RSS feed
        this.emitFile({
          type: 'asset',
          fileName: 'feed.xml',
          source: rssXml,
        })

        // Emit sitemap
        this.emitFile({
          type: 'asset',
          fileName: 'sitemap.xml',
          source: sitemapXml,
        })

        console.info(`Generated RSS feed with ${sortedPhotos.length} photos`)
        console.info(`Generated sitemap with ${sortedPhotos.length + 1} URLs`)
      } catch (error) {
        console.error('Error generating RSS feed and sitemap:', error)
      }
    },
  }
}

/**
 * `<loc>` 的根：`config.json` 的 `url` 允许写成「带结尾斜杠」「不带结尾斜杠」甚至子路径
 * （`https://host/gallery`）。以前的写法是 `${config.url}/photos/...`，只要作者在
 * `config.json` 里写了结尾斜杠，369 条 URL 就会变成 `https://host//photos/...` ——
 * 双斜杠路径在爬虫那里是另一个 URL（可能被当成重复内容或直接 404），而站点自己
 * 走的是 `https://host/photos/...`，两边对不上。
 */
function resolveSiteBase(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new Error('[feed-sitemap] site.url is empty — sitemap <loc> must be absolute')
  }
  try {
    // URL 会规范化 `https://host` 与 `https://host/`，并保留子路径
    return `${new URL(trimmed).href.replace(/\/+$/, '')}/`
  }
  catch {
    // 站点可能配置成相对路径（例如本地预览）；退化成字符串拼接，至少不会多一个斜杠
    return `${trimmed.replace(/\/+$/, '')}/`
  }
}

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * 构建期自检。没有它的话，`config.url` 少写/多写一个斜杠只会在搜索引擎侧静默降级
 * （369 条 URL 全对不上），构建日志里一个字都不会提。
 */
function assertSitemapUrls(xml: string, siteBase: string): void {
  const locs = Array.from(xml.matchAll(/<loc>([^<]*)<\/loc>/g), match => match[1])
  if (locs.length === 0) {
    throw new Error('[feed-sitemap] generated sitemap has no <loc> entries')
  }
  for (const loc of locs) {
    if (!loc.startsWith(siteBase)) {
      throw new Error(`[feed-sitemap] <loc> is not under site.url (${siteBase}): ${loc}`)
    }
    // 去掉 scheme 后不允许再出现 `//`：`https://host//photos/x` 这种「base 结尾斜杠 +
    // path 前导斜杠」是最容易复发的写法，而它在浏览器里通常还能打开，所以只能靠断言抓。
    if (loc.replace(/^[a-z]+:\/\//i, '').includes('//')) {
      throw new Error(`[feed-sitemap] <loc> contains a double slash: ${loc}`)
    }
    if (/^https?:\/\//.test(siteBase) && !/^https?:\/\//.test(loc)) {
      throw new Error(`[feed-sitemap] <loc> is not absolute: ${loc}`)
    }
  }
}

function generateSitemap(photos: PhotoManifestItem[], config: SiteConfig): string {
  const now = new Date().toISOString()
  const siteBase = resolveSiteBase(config.url)
  /** 拼站内绝对 URL；`path` 前导斜杠会被吃掉，保证 base 与 path 之间只有一个 `/` */
  const pageUrl = (path: string) => `${siteBase}${path.replace(/^\/+/, '')}`

  // Main page
  const mainPageXml = `  <url>
    <loc>${escapeXml(siteBase)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`

  // Photo pages
  const photoUrls = photos
    .map((photo) => {
      const lastmod = new Date(photo.lastModified || photo.dateTaken).toISOString()
      return `  <url>
    <loc>${escapeXml(pageUrl(`photos/${encodeURIComponent(photo.id)}`))}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`
    })
    .join('\n')

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${mainPageXml}
${photoUrls}
</urlset>`

  assertSitemapUrls(sitemapXml, siteBase)
  return sitemapXml
}
