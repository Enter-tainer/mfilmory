import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import type { Plugin } from 'vite'

import { MANIFEST_PATH } from './__internal__/constants'

const MANIFEST_PLACEHOLDER = '<script id="manifest"></script>'
const MANIFEST_FILE_BASENAME = 'photos-manifest'

/**
 * 首屏（网格第一行）至少有 4-8 张缩略图，但它们的 URL 只存在于 manifest 里 ——
 * 也就是说浏览器要等 HTML → manifest → JS 执行 → React 渲染之后才发起图片请求。
 * 把前几张的 URL 直接写进 HTML 的 preload，图片就能和 manifest/JS 并行下载。
 *
 * 代价：非 `/` 的落地页（比如 `/map`）用不上这几张，会白下载几十 KB，
 * 所以数量取小一点，只覆盖「第一行最可能出现在 LCP 里的那几张」。
 *
 * 必须和 `MasonryPhotoItem.tsx` 里的 `EAGER_IMAGE_COUNT` 保持一致。
 */
const PRELOADED_THUMBNAIL_COUNT = 4

type ManifestMode = 'inline' | 'external'

/**
 * `AFILMORY_EMBED_MANIFEST`:
 *   - `true`  → 老行为：整份 manifest 内联进 HTML（769 KB，HTML 不可缓存）
 *   - `false` → 外置成可缓存的 JSON
 *   - 未设置  → build 时外置，dev 时内联（dev 没有构建产物，内联才能热更新）
 */
function resolveMode(command: 'serve' | 'build'): ManifestMode {
  const flag = process.env.AFILMORY_EMBED_MANIFEST?.trim().toLowerCase()
  if (flag === 'true') {
    return 'inline'
  }
  if (flag === 'false') {
    return 'external'
  }
  return command === 'serve' ? 'inline' : 'external'
}

type RawPhoto = Record<string, unknown> & {
  thumbnailUrl?: unknown
  lastModified?: unknown
  exif?: { DateTimeOriginal?: unknown } | null
}

/**
 * 构建期才有意义、运行时永远不读的字段。
 *
 * - `digest`：内容 sha256 前缀，64 位随机 hex，**几乎不可压缩** —— 单它一项就占
 *   整份 manifest brotli 后 64.3 KB 里的 13.4 KB（21%）。运行时没有任何代码读它，
 *   只有流水线自己用它做去重/命名；源文件 `apps/web/src/data/photos-manifest.json`
 *   里仍然保留，`scripts/cleanup-stale-assets.ts` 和 OG 中间件读的是源文件。
 * - `ogImageUrl`：只有构建期的 Cloudflare 中间件用。
 *
 * **不要往这个列表里加运行时字段**：首屏网格/列表/筛选/地图/大图 EXIF 面板读到的
 * 每一个字段都必须留着，裁剪掉任何一个都是静默功能回归（`location` 会被列表视图的
 * 位置行和 Cmd-K 的地点搜索读，完整 `exif` 会被 hover 卡、筛选和 EXIF 面板读）。
 */
const FIELDS_UNUSED_BY_WEB = ['digest', 'ogImageUrl'] as const

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

function parsePhotos(manifestRaw: string): RawPhoto[] | null {
  try {
    const parsed = JSON.parse(manifestRaw) as { data?: RawPhoto[] }
    return Array.isArray(parsed.data) ? parsed.data : null
  }
  catch {
    return null
  }
}

/** 裁掉只对构建期有意义的字段。返回新字符串，不改动入参。 */
function stripBuildOnlyFields(manifestRaw: string): string {
  try {
    const parsed = JSON.parse(manifestRaw) as { data?: RawPhoto[] }
    if (!Array.isArray(parsed.data)) {
      return JSON.stringify(parsed)
    }
    for (const photo of parsed.data) {
      for (const field of FIELDS_UNUSED_BY_WEB) {
        delete photo[field]
      }
    }
    return JSON.stringify(parsed)
  }
  catch (error) {
    console.warn('[manifest-inject] failed to strip build-only fields:', error)
    return manifestRaw
  }
}

/**
 * 图片 CDN 与站点不同源（R2 自定义域名），首次连接要额外付 DNS + TCP + TLS。
 * preload 只是让请求早点排队，先 preconnect 能把这三次握手也提前做掉。
 * 注意不要加 `crossorigin`：`<img>` 没有 crossorigin 属性，属于 no-cors 请求，
 * 加了 crossorigin 反而会建立一条用不上的 CORS 连接。
 */
function buildImageOriginPreconnect(photos: RawPhoto[]): string {
  const thumbnailUrl = photos.find(photo => typeof photo.thumbnailUrl === 'string')?.thumbnailUrl
  if (typeof thumbnailUrl !== 'string') {
    return ''
  }

  try {
    const { origin } = new URL(thumbnailUrl)
    return origin ? `<link rel="preconnect" href="${escapeAttribute(origin)}">` : ''
  }
  catch {
    return ''
  }
}

/**
 * 取默认排序（拍摄时间倒序，与 `usePhotoViewer.filterAndSortPhotos` 一致）的前 N 张，
 * 生成 `<link rel="preload" as="image">`。
 *
 * 先 filter 再 slice：否则前 4 张里只要有一张没有缩略图，preload 数量就会少于 N，
 * 而又没有任何报错。
 */
function buildThumbnailPreloads(photos: RawPhoto[]): string {
  const dateKey = (photo: RawPhoto) => {
    const original = photo.exif?.DateTimeOriginal
    if (typeof original === 'string' && original.length > 0) {
      return original
    }
    return typeof photo.lastModified === 'string' ? photo.lastModified : ''
  }

  return photos
    .filter((photo): photo is RawPhoto & { thumbnailUrl: string } => typeof photo.thumbnailUrl === 'string' && photo.thumbnailUrl.length > 0)
    .map(photo => ({ photo, key: dateKey(photo) }))
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, PRELOADED_THUMBNAIL_COUNT)
    .map(({ photo }) => `<link rel="preload" as="image" fetchpriority="high" href="${escapeAttribute(photo.thumbnailUrl)}">`)
    .join('')
}

export function manifestInjectPlugin(): Plugin {
  let mode: ManifestMode = 'inline'
  let manifestJson = '{}'
  /** 形如 /photos-manifest.1a2b3c4d.json */
  let publicPath = ''
  let outDir = ''

  function readManifest(): { text: string, json: string } {
    try {
      const text = readFileSync(MANIFEST_PATH, 'utf-8')
      // 构建产物是格式化过的 JSON；压缩后 brotli 收益仍在，且解析更快
      return { text, json: JSON.stringify(JSON.parse(text)) }
    }
    catch (error) {
      console.warn('Failed to read manifest file:', error)
      return { text: '{}', json: '{}' }
    }
  }

  /** 外置模式下计算产物路径（保持 buildStart / dev server 两条路径一致） */
  function ensurePublicPath(): string {
    if (publicPath) {
      return publicPath
    }
    const { json } = readManifest()
    manifestJson = stripBuildOnlyFields(json)
    const hash = createHash('sha256').update(manifestJson).digest('hex').slice(0, 8)
    publicPath = `/${MANIFEST_FILE_BASENAME}.${hash}.json`
    return publicPath
  }

  return {
    name: 'manifest-inject',

    configResolved(config) {
      mode = resolveMode(config.command as 'serve' | 'build')
      outDir = path.resolve(config.root, config.build.outDir)
    },

    buildStart() {
      if (mode !== 'external') {
        return
      }
      ensurePublicPath()
    },

    writeBundle(options) {
      if (mode !== 'external' || !publicPath) {
        return
      }
      const dir = options.dir ? path.resolve(options.dir) : outDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, path.basename(publicPath)), manifestJson)
    },

    configureServer(server) {
      if (mode !== 'inline') {
        return
      }

      // 监听 manifest 文件变化
      server.watcher.add(MANIFEST_PATH)

      server.watcher.on('change', (file) => {
        if (file === MANIFEST_PATH) {
          // eslint-disable-next-line no-console
          console.info('[manifest-inject] Manifest file changed, triggering HMR...')
          // 触发页面重新加载
          server.ws.send({
            type: 'full-reload',
          })
        }
      })
    },

    transformIndexHtml(html, ctx) {
      const command: 'serve' | 'build' = ctx?.server ? 'serve' : 'build'
      mode = resolveMode(command)

      if (mode === 'inline') {
        const { text } = readManifest()
        return html.replace(MANIFEST_PLACEHOLDER, `<script id="manifest">window.__MANIFEST__ = ${text};</script>`)
      }

      // 外置：HTML 里只留 URL + 一条 preload，让 JSON 和 HTML/CSS/JS 并行下载
      const url = ensurePublicPath()
      const photos = parsePhotos(manifestJson) ?? []
      const tags = [
        // 图片 CDN 是另一个源，先把连接搭起来
        buildImageOriginPreconnect(photos),
        // 首屏缩略图先于 manifest/JS 开始下载（LCP 主要靠这条）
        buildThumbnailPreloads(photos),
        `<link rel="preload" href="${url}" as="fetch" crossorigin="anonymous">`,
        `<script id="manifest">window.__MANIFEST__=null;window.__MANIFEST_URL__=${JSON.stringify(url)}</script>`,
      ].join('')

      return html.replace(MANIFEST_PLACEHOLDER, tags)
    },
  }
}
