import type { PhotoManifestItem } from '@afilmory/typing'

const MAX_FAILURES = 10
const MAX_MESSAGE_LENGTH = 300

/**
 * 记录一次产物上传失败。
 *
 * `lastProcessSuccess = false` 会被 `shouldProcessPhoto` / `filterTaskImages` 识别，
 * 让这张照片在下一次增量构建时重新处理（而不是因为 lastModified 没变被跳过）。
 */
export function recordUploadFailure(
  item: PhotoManifestItem | null | undefined,
  kind: 'thumbnail' | 'preview' | 'og-image',
  error: unknown,
): void {
  if (!item) {
    return
  }

  const text = error instanceof Error ? error.message : String(error)
  const message = `${kind}: ${text.slice(0, MAX_MESSAGE_LENGTH)}`
  item.lastProcessSuccess = false
  item.uploadFailures = [...(item.uploadFailures ?? []), message].slice(-MAX_FAILURES)
}
