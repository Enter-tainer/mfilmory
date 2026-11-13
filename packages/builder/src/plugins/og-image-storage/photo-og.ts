import type { Buffer } from 'node:buffer'

import sharp from 'sharp'

/**
 * 照片直放（photo-straight）分享图。
 *
 * 链接预览卡（Twitter/X、WhatsApp、Telegram、iMessage、Slack、Discord）都是
 * 「一张图 + 平台自己渲染的标题/描述」。卡片里再画一遍站名/标题，等于同一句
 * 话说两遍；套一层黑底或留白又会让照片缩成卡片里的小图。所以这里只做两件事：
 * 把照片铺满 1.91:1 的卡片比例，然后编码成 WebP。没有背景色、没有文字、没有边框。
 *
 * 文字全部交给 og:title / og:description（见 `photo-text.ts` 与
 * `vendors/cloudflare-moddleware.ts`）。
 */
export const PHOTO_OG_SIZE = { width: 1200, height: 630 } as const
export const PHOTO_OG_WEBP_QUALITY = 88

export interface PhotoOgRenderOptions {
  /**
   * - `cover`（默认）：满幅裁切到 1.91:1，卡片里不留任何底色。
   * - `inside`：保留原构图，只把长边缩到 1600px，裁切交给分享平台。
   */
  fit?: 'cover' | 'inside'
}

export async function renderPhotoOgImage(input: Buffer, options: PhotoOgRenderOptions = {}): Promise<Buffer> {
  const { fit = 'cover' } = options

  const pipeline = sharp(input, { limitInputPixels: false }).rotate()

  const resized
    = fit === 'cover'
      // attention 会挑视觉重心，而竖构图里居中裁切经常把主体切掉
      ? pipeline.resize(PHOTO_OG_SIZE.width, PHOTO_OG_SIZE.height, {
          fit: 'cover',
          position: sharp.strategy.attention,
        })
      : pipeline.resize({
          width: 1600,
          height: 1600,
          fit: 'inside',
          withoutEnlargement: true,
        })

  return resized.webp({ quality: PHOTO_OG_WEBP_QUALITY, effort: 4 }).toBuffer()
}
