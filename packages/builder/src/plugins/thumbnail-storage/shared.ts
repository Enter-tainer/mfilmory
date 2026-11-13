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
