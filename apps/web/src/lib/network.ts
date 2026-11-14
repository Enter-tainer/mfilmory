/**
 * 网络状况探测 —— 用来决定「首屏之后的重活要不要做」。
 *
 * 目前只有一个消费者：`App.tsx` 里对 viewer 路由的 idle 预取。那个预取会下载
 * `_photoId_` chunk（≈186 KB）+ exiftool 的 esm（≈42 KB），在 Lighthouse 的
 * 「避免链接关键请求」里就是这两条把关键路径拉到了 2.8 s —— 慢网下它们在跟首屏缩略图抢带宽。
 *
 * 判据刻意保守：只有浏览器**明确说**「省流量模式」或「2G/3G」时才跳过；
 * 拿不到 `navigator.connection`（Firefox / Safari 目前没有）时一律照常预取。
 */

interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}

/** Chromium 的 effectiveType 枚举里这几个都算慢网 */
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g'])

export function shouldSkipHeavyPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false

  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  if (!connection) return false

  if (connection.saveData === true) return true

  const effectiveType = connection.effectiveType
  return typeof effectiveType === 'string' && SLOW_EFFECTIVE_TYPES.has(effectiveType)
}
