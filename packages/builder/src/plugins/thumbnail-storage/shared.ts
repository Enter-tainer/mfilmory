import type { Buffer } from 'node:buffer'

export const THUMBNAIL_PLUGIN_DATA_KEY = 'afilmory:thumbnail-storage:data'
/** 阅览器占位图（大图加载前的预览）单独走一份数据 */
export const PREVIEW_PLUGIN_DATA_KEY = 'afilmory:preview-storage:data'

/**
 * Unique symbol identifier for the thumbnail storage plugin.
 * Used for reliable plugin detection without fragile string matching.
 */
export const THUMBNAIL_PLUGIN_SYMBOL = Symbol.for('afilmory:thumbnail-storage')

export interface ThumbnailPluginData {
  photoId: string
  fileName: string
  buffer: Buffer | null
  localUrl: string | null
}
export const DEFAULT_DIRECTORY = '.afilmory/thumbnails'
export const DEFAULT_PREVIEW_DIRECTORY = '.afilmory/previews'
export const DEFAULT_CONTENT_TYPE = 'image/avif'

/**
 * 缩略图 / 占位图上传时写进对象元数据的 Cache-Control。
 *
 * 这些产物的文件名是固定的（`<photoId>.avif`），照片重新处理时会被原地覆盖，所以不能给
 * `immutable`；但完全不给 Cache-Control 时浏览器只会用启发式缓存（≈10% 的文件年龄），
 * 刚上传的照片几乎每次访问都要重新下载一遍（这批图恰好是打开率最高的首屏图）。
 *
 * 折中：浏览器缓存 1 天，之后用 stale-while-revalidate 在后台刷新的同时先回旧图。
 * 换照片后最多 1 天看到旧缩略图，代价可以接受。
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800'

const CONTENT_TYPES: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
}

/**
 * 从文件名推断 content-type。
 *
 * 上传时的 content-type 直接决定 CDN 响应的 `Content-Type`，写错会让浏览器
 * 拒绝解码（例如把 AVIF 标成 image/jpeg）。所以以真实文件名为准，只有在
 * 调用方显式传入 `contentType` 时才覆盖。
 */
export function contentTypeFromFilename(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE
}
