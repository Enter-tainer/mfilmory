/**
 * builder 自己的产物目录前缀。
 *
 * 缩略图 / 占位图 / OG 卡都是 `.avif` / `.webp`，而这两种扩展名同时也在
 * `SUPPORTED_FORMATS` 里（为了支持 AVIF / WebP 作为**输入**照片）。如果不显式排除，
 * `listImages()` 会把 builder 自己的产物当成待处理照片再走一遍完整管线：
 * 369 张照片会变成 1476 个「照片」（原图 + 缩略图 + 占位图 + OG 卡各 369），
 * manifest 会跟着膨胀，并开始生成「缩略图的缩略图」。
 *
 * 只用于**摄入**判定（`StorageManager.listImages`）；`listAllFiles` 保持原样，
 * 上传去重 / 清理 / Live Photo 配对仍然需要看到这些对象。
 */
const DERIVED_ASSET_PATTERN = /(^|\/)\.afilmory(\/|$)/

export function isDerivedAssetKey(key?: string | null): boolean {
  if (!key) {
    return false
  }
  return DERIVED_ASSET_PATTERN.test(key.replaceAll('\\', '/'))
}
