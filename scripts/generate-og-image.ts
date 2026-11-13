import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { workdir } from '../packages/builder/src/path.js'
import { buildTimePhotoLoader } from './photo-loader.js'

/**
 * 站点级（首页）分享图。
 *
 * 与单张照片一样「照片直放」：一张横向照片满幅铺进 1200×630，不加底色、
 * 不叠站名和标题。分享平台会在图下面原生渲染 og:title / og:description，
 * 所以图里再画一遍文字只会把照片挤小。
 */

/** 1.91:1，Twitter/X `summary_large_image`、WhatsApp、Telegram、Facebook 通用尺寸。 */
export const HOME_OG_SIZE = { width: 1200, height: 630 } as const
export const HOME_OG_WEBP_QUALITY = 88

/**
 * 只挑横向照片当封面：竖构图裁成 1.91:1 会只剩中间一条，
 * 全景（>2.6:1）裁完又只剩中间一块，都不适合做横幅。
 */
const BANNER_ASPECT = { min: 1.45, max: 2.6 }

interface PhotoLike {
  id: string
  width: number
  height: number
  previewUrl?: string | null
  thumbnailUrl?: string | null
  dateTaken?: string
  lastModified?: string
  exif?: { DateTimeOriginal?: string } | null
}

function photoTime(photo: PhotoLike): number {
  return Date.parse(String(photo.exif?.DateTimeOriginal ?? ''))
    || Date.parse(photo.lastModified ?? '')
    || Date.parse(photo.dateTaken ?? '')
    || 0
}

/** 新→旧找第一张适合做横幅的照片；一张都没有时退回最新的一张。 */
function pickCoverPhoto(photos: PhotoLike[]): PhotoLike | null {
  const sorted = [...photos].sort((a, b) => photoTime(b) - photoTime(a))
  const isBannerFriendly = (photo: PhotoLike) => {
    if (!photo.width || !photo.height) return false
    const ratio = photo.width / photo.height
    return ratio >= BANNER_ASPECT.min && ratio <= BANNER_ASPECT.max
  }
  return sorted.find(isBannerFriendly) ?? sorted[0] ?? null
}

/** 优先用流水线留在 public/ 的本地缓存，最后才回落到 CDN（构建期少一次网络抖动）。 */
async function resolveCoverSource(photo: PhotoLike): Promise<string | Buffer | null> {
  const localCandidates = [
    join(workdir, 'public/previews', `${photo.id}.avif`),
    join(workdir, 'public/thumbnails', `${photo.id}.avif`),
  ]

  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate
  }

  for (const url of [photo.previewUrl, photo.thumbnailUrl]) {
    if (!url || !/^https?:\/\//i.test(url)) { continue }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (response.ok) return Buffer.from(await response.arrayBuffer())
    }
    catch {
      // 构建期拿不到远端图时不阻塞构建，继续尝试下一个来源
    }
  }

  return null
}

/**
 * 生成站点级分享图。
 *
 * 返回的是**相对 public 的路径**（`/og-image-<ts>.webp`）：Cloudflare 中间件
 * 靠 `og-image*.webp` 这个 pattern 认出「这是站点级卡片」再换成单张照片的图，
 * 文件名格式不能改。
 */
export async function generateOGImage({ outputPath }: { outputPath: string }): Promise<string> {
  const fullOutputPath = join(workdir, 'public', outputPath)
  await mkdir(join(workdir, 'public'), { recursive: true })

  const coverPhoto = pickCoverPhoto(buildTimePhotoLoader.getPhotos() as PhotoLike[])
  const source = coverPhoto ? await resolveCoverSource(coverPhoto) : null

  if (source) {
    const webp = await sharp(source, { limitInputPixels: false })
      .rotate()
      .resize(HOME_OG_SIZE.width, HOME_OG_SIZE.height, { fit: 'cover', position: sharp.strategy.attention })
      .webp({ quality: HOME_OG_WEBP_QUALITY, effort: 4 })
      .toBuffer()

    await sharp(webp).toFile(fullOutputPath)
    console.info(`🖼️  Homepage OG image: ${coverPhoto?.id} (${Math.round(webp.length / 1024)}KB)`)
  }
  else {
    // manifest 为空（例如 demo 首次构建）时没有照片可放；留一张纯色兜底，避免构建失败
    await sharp({
      create: { width: HOME_OG_SIZE.width, height: HOME_OG_SIZE.height, channels: 3, background: '#0a0a0a' },
    })
      .webp({ quality: HOME_OG_WEBP_QUALITY })
      .toFile(fullOutputPath)
    console.warn('🖼️  Homepage OG image: no photo available, wrote a blank card')
  }

  return `/${outputPath}`
}

export interface HomeOgCopy {
  title: string
  description: string
}

/**
 * 站点级分享卡的文字。
 *
 * 图里没有字之后，卡片上就只剩平台原生渲染的这两行。描述沿用 `config.json` 的
 * description（站主自己写的那句），再接上照片数量和最近更新月份，让第一次点开
 * 的人知道这个站多大、还活着。
 */
export function buildHomeOgCopy(input: { siteName: string, siteDescription?: string }): HomeOgCopy {
  const photos = buildTimePhotoLoader.getPhotos() as PhotoLike[]
  const parts: string[] = []

  const description = input.siteDescription?.trim()
  if (description) { parts.push(description) }

  if (photos.length > 0) {
    parts.push(`${photos.length} 张照片`)
  }

  const latestTimestamp = photos.reduce((latest, photo) => Math.max(latest, photoTime(photo)), 0)
  if (latestTimestamp > 0) {
    const latest = new Date(latestTimestamp)
    parts.push(`最近更新 ${latest.getFullYear()} 年 ${latest.getMonth() + 1} 月`)
  }

  return {
    title: input.siteName,
    description: parts.join(' · ') || input.siteName,
  }
}
