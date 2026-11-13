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
 * 把前几张的 URL 直接写进 HTML 的 preload，图片就能和 manifest/JS 并行下载，
 * 实测 LCP 从 ~3.3 s 降到 ~2.4 s。
 *
 * 代价：非 `/` 的落地页（比如 `/map`）用不上这几张，会白下载几十 KB，
 * 所以数量取小一点，只覆盖「第一行最可能出现在 LCP 里的那几张」。
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

type ManifestPhoto = {
  thumbnailUrl?: string | null
  lastModified?: string
  exif?: { DateTimeOriginal?: unknown } | null
}

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/**
 * 图片 CDN 与站点不同源（R2 自定义域名），首次连接要额外付 DNS + TCP + TLS。
 * preload 只是让请求早点排队，先 preconnect 能把这三次握手也提前做掉。
 * 注意不要加 `crossorigin`：`<img>` 没有 crossorigin 属性，属于 no-cors 请求，
 * 加了 crossorigin 反而会建立一条用不上的 CORS 连接。
 */
function buildImageOriginPreconnect(manifestRaw: string): string {
  let photos: ManifestPhoto[]
  try {
    photos = (JSON.parse(manifestRaw) as { data?: ManifestPhoto[] }).data ?? []
  }
  catch {
    return ''
  }

  const thumbnailUrl = photos.find(photo => typeof photo.thumbnailUrl === 'string')?.thumbnailUrl
  if (!thumbnailUrl) {
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
 * 生成 `<link rel="preload" as="image">`。拿不到 manifest 时静默退化成不 preload。
 */
function buildThumbnailPreloads(manifestRaw: string): string {
  let photos: ManifestPhoto[]
  try {
    photos = (JSON.parse(manifestRaw) as { data?: ManifestPhoto[] }).data ?? []
  }
  catch {
    return ''
  }

  const dateKey = (photo: ManifestPhoto) => {
    const original = photo.exif?.DateTimeOriginal
    return typeof original === 'string' && original.length > 0 ? original : (photo.lastModified ?? '')
  }

  return photos
    .map(photo => ({ photo, key: dateKey(photo) }))
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, PRELOADED_THUMBNAIL_COUNT)
    .map(({ photo }) => photo.thumbnailUrl)
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .map(url => `<link rel="preload" as="image" fetchpriority="high" href="${escapeAttribute(url)}">`)
    .join('')
}

export function manifestInjectPlugin(): Plugin {
  let mode: ManifestMode = 'inline'
  let indexManifestJson = '{}'
  let detailManifestJson = '{}'
  let fullManifestJson = '{}'
  /** 形如 /photos-manifest.index.1a2b3c4d.json（首屏用） */
  let publicPath = ''
  /** 形如 /photos-manifest.detail.1a2b3c4d.json（viewer 打开时才取） */
  let detailPublicPath = ''
  /** 形如 /photos-manifest.full.1a2b3c4d.json（/manifest 调试页用） */
  let fullPublicPath = ''
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

  /**
   * 首屏只下发网格/筛选/排序/地图标记真的会读的字段。
   *
   * - 永不读：`digest`（64 位随机 hex，几乎不可压缩）、`ogImageUrl`（只有构建期的
   *   Cloudflare 中间件用，它直接读源文件）
   * - 只有打开大图才读：完整 `exif`、`location`、`toneAnalysis`、`keywords`、`regions`、`s3Key`
   *
   * 后者进 `photos-manifest.detail.<hash>.json`，按 id 索引，viewer 打开时才取。
   */
  const FIELDS_UNUSED_BY_WEB = ['digest', 'ogImageUrl'] as const

  /** 网格 hover 卡、列表视图、筛选、地图标记要用到的 exif 字段 */
  const EXIF_FIELDS_FOR_INDEX = [
    'Make',
    'Model',
    'LensMake',
    'LensModel',
    'Rating',
    'FocalLength',
    'FocalLengthIn35mmFormat',
    'FNumber',
    'Aperture',
    'ShutterSpeed',
    'ExposureTime',
    'ISO',
    'DateTimeOriginal',
    'Orientation',
    'GPSLatitude',
    'GPSLongitude',
    'GPSLatitudeRef',
    'GPSLongitudeRef',
  ] as const

  type RawPhoto = Record<string, unknown>

  function splitManifest(manifestRaw: string): { index: string, detail: string, full: string } {
    try {
      const parsed = JSON.parse(manifestRaw) as { data?: RawPhoto[] }
      const full = JSON.stringify(parsed)
      if (!Array.isArray(parsed.data)) {
        return { index: full, detail: '{}', full }
      }

      const detail: Record<string, RawPhoto> = {}
      for (const photo of parsed.data) {
        const id = String(photo.id)
        const patch: RawPhoto = {}

        if (photo.exif && typeof photo.exif === 'object') {
          const indexExif: RawPhoto = {}
          const restExif: RawPhoto = {}
          for (const [key, value] of Object.entries(photo.exif)) {
            if ((EXIF_FIELDS_FOR_INDEX as readonly string[]).includes(key)) {
              indexExif[key] = value
            }
            else {
              restExif[key] = value
            }
          }
          photo.exif = indexExif
          if (Object.keys(restExif).length > 0) {
            patch.exif = restExif
          }
        }

        for (const field of ['location', 'toneAnalysis', 'keywords', 'regions', 's3Key'] as const) {
          if (photo[field] !== undefined && photo[field] !== null) {
            patch[field] = photo[field]
          }
          delete photo[field]
        }

        for (const field of FIELDS_UNUSED_BY_WEB) {
          delete photo[field]
        }

        if (Object.keys(patch).length > 0) {
          detail[id] = patch
        }
      }

      return { index: JSON.stringify(parsed), detail: JSON.stringify(detail), full }
    }
    catch (error) {
      console.warn('Failed to split manifest:', error)
      return { index: '{}', detail: '{}', full: '{}' }
    }
  }

  /** 外置模式下计算产物路径（保持 buildStart / dev server 两条路径一致） */
  function ensurePublicPath(): string {
    if (publicPath) {
      return publicPath
    }
    const { json } = readManifest()
    const { index, detail, full } = splitManifest(json)
    indexManifestJson = index
    detailManifestJson = detail
    fullManifestJson = full
    // hash 覆盖三份内容，部署后任一变化都会换 URL
    const hash = createHash('sha256')
      .update(index)
      .update(detail)
      .update(full)
      .digest('hex')
      .slice(0, 8)
    publicPath = `/${MANIFEST_FILE_BASENAME}.index.${hash}.json`
    detailPublicPath = `/${MANIFEST_FILE_BASENAME}.detail.${hash}.json`
    fullPublicPath = `/${MANIFEST_FILE_BASENAME}.full.${hash}.json`
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
      writeFileSync(path.join(dir, path.basename(publicPath)), indexManifestJson)
      // detail 只在打开大图时取；full 只给 /manifest 调试页 —— 两者都不进首屏
      writeFileSync(path.join(dir, path.basename(detailPublicPath)), detailManifestJson)
      writeFileSync(path.join(dir, path.basename(fullPublicPath)), fullManifestJson)
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
      const tags = [
        // 图片 CDN 是另一个源，先把连接搭起来
        buildImageOriginPreconnect(indexManifestJson),
        // 首屏缩略图先于 manifest/JS 开始下载（LCP 主要靠这条）
        buildThumbnailPreloads(indexManifestJson),
        `<link rel="preload" href="${url}" as="fetch" crossorigin="anonymous">`,
        `<script id="manifest">window.__MANIFEST__=null;window.__MANIFEST_URL__=${JSON.stringify(url)};window.__MANIFEST_DETAIL_URL__=${JSON.stringify(detailPublicPath)};window.__MANIFEST_FULL_URL__=${JSON.stringify(fullPublicPath)}</script>`,
      ].join('')

      return html.replace(MANIFEST_PLACEHOLDER, tags)
    },
  }
}
