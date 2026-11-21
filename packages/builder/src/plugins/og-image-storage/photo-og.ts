import type { Buffer } from 'node:buffer'

import sharp from 'sharp'

/**
 * 照片直放（photo-straight）分享图。
 *
 * 链接预览卡（Twitter/X、WhatsApp、Telegram、iMessage、Slack、Discord）都是
 * 「一张图 + 平台自己渲染的标题/描述」。卡片里再画一遍站名/标题，等于同一句
 * 话说两遍；套一层黑底或留白又会让照片缩成卡片里的小图。所以这里只做一件事：
 * 把照片按原图比例缩到合适宽度，编码成 WebP。没有背景色、没有文字、没有边框。
 *
 * 尺寸规则（不区分横竖、不裁切）：
 *
 * - 横边 > 1200：缩到 1200，纵边按比例；
 * - 横边 ≤ 1200：保持原尺寸，不放大（原图本身没有更多像素）。
 *
 * 依据：聊天软件里预览图的展示宽度受气泡/卡片列宽限制（桌面约 400–600 CSS px，
 * 移动端 300–400），源图横边 1200 足够覆盖 2× DPR；再大的宽度只会让文件变大。
 * 高度不再固定：3:4 竖图就是 1200×1600，3:2 横图就是 1200×800。
 *
 * 平台差异（平台侧行为，单张 og:image 无法全部满足）：
 *
 * - Telegram / iMessage / Slack 按卡片宽度等比缩放，竖图能完整显示；
 * - Discord 大图有约 400×300 的展示上限，高图会被缩小；
 * - X / Facebook / LinkedIn 会按 1.91:1–2:1 裁切，竖图必被裁。
 *
 * 文字全部交给 og:title / og:description（见 `photo-text.ts`；由 `ssg-prerender` 在构建期写进静态页）。
 */
export const PHOTO_OG_WIDTH = 1200
export const PHOTO_OG_WEBP_QUALITY = 88
/**
 * 尺寸规则版本。
 *
 * 分享图文件名固定是 `<photoId>.webp`，改完规则后光看文件在不在判断不了卡片是不是
 * 新参数生成的。签名（`index.ts` 里的 `ogSignature`）带上这个常量，递增它就会让
 * 增量构建重渲染旧卡片，而不是继续复用旧图。
 */
export const PHOTO_OG_LAYOUT_VERSION = 'width-cap-1200-v2'

export async function renderPhotoOgImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: false })
    .rotate()
    .resize({ width: PHOTO_OG_WIDTH, withoutEnlargement: true })
    .webp({ quality: PHOTO_OG_WEBP_QUALITY, effort: 4 })
    .toBuffer()
}
