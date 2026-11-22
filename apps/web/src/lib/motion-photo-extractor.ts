/**
 * Motion Photo 视频提取工具
 * 从包含嵌入视频的图片中提取 MP4 视频数据。
 *
 * 提取出的 Blob URL 由模块级 LRU 缓存统一管理与自动回收（`URL.revokeObjectURL`），
 * 调用方无需也不要手动 revoke，以免影响缓存复用。
 */

import { LRUCache } from './lru-cache'

interface MotionPhotoMetadata {
  motionPhotoOffset: number
  motionPhotoVideoSize?: number
  presentationTimestampUs?: number
}

const motionPhotoVideoCache = new LRUCache<string, string>(10, (blobUrl) => {
  if (blobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(blobUrl)
  }
})

const inFlightExtractions = new Map<string, Promise<string | null>>()

/**
 * 从图片 URL 中提取嵌入的 MP4 视频（命中 LRU 缓存或去重并发提取）
 * @param imageUrl 原图片 URL
 * @param metadata Motion Photo 元数据（包含 offset 和可选的 size）
 * @returns 视频的 Blob URL，可直接用于 video 元素
 */
export async function extractMotionPhotoVideo(imageUrl: string, metadata: MotionPhotoMetadata): Promise<string | null> {
  const cacheKey = `${imageUrl}#${metadata.motionPhotoOffset}:${metadata.motionPhotoVideoSize ?? ''}`

  const cachedUrl = motionPhotoVideoCache.get(cacheKey)
  if (cachedUrl) {
    return cachedUrl
  }

  const existingPromise = inFlightExtractions.get(cacheKey)
  if (existingPromise) {
    return existingPromise
  }

  const extractionPromise = extractMotionPhotoVideoUncached(imageUrl, metadata)
    .then((blobUrl) => {
      if (blobUrl) {
        motionPhotoVideoCache.set(cacheKey, blobUrl)
      }
      return blobUrl
    })
    .finally(() => {
      inFlightExtractions.delete(cacheKey)
    })

  inFlightExtractions.set(cacheKey, extractionPromise)
  return extractionPromise
}

async function extractMotionPhotoVideoUncached(
  imageUrl: string,
  metadata: MotionPhotoMetadata,
): Promise<string | null> {
  try {
    const { motionPhotoOffset, motionPhotoVideoSize } = metadata

    // 尝试使用 Range Request 仅获取视频部分
    if (motionPhotoVideoSize && motionPhotoVideoSize > 0) {
      try {
        const videoBlob = await fetchVideoWithRange(imageUrl, motionPhotoOffset, motionPhotoVideoSize)
        if (videoBlob) {
          return URL.createObjectURL(videoBlob)
        }
      }
      catch (rangeError) {
        console.warn('[motion-photo] Range request failed, falling back to full fetch:', rangeError)
      }
    }

    // Fallback: 下载完整图片并提取视频部分
    const videoBlob = await fetchVideoWithFullDownload(imageUrl, motionPhotoOffset, motionPhotoVideoSize)
    if (videoBlob) {
      return URL.createObjectURL(videoBlob)
    }

    return null
  }
  catch (error) {
    console.error('[motion-photo] Failed to extract video:', error)
    return null
  }
}

/**
 * 使用 Range Request 获取视频部分（需要服务器支持）
 */
async function fetchVideoWithRange(imageUrl: string, offset: number, size: number): Promise<Blob | null> {
  const endByte = offset + size - 1
  const response = await fetch(imageUrl, {
    headers: {
      Range: `bytes=${offset}-${endByte}`,
    },
  })

  // 检查是否支持 Range Request
  if (response.status !== 206) {
    throw new Error('Range request not supported')
  }

  const blob = await response.blob()

  // 验证是否为有效的 MP4
  if (!(await isValidMp4(blob))) {
    throw new Error('Invalid MP4 data')
  }

  return new Blob([blob], { type: 'video/mp4' })
}

/**
 * 下载完整图片并提取视频部分（Fallback 方案）
 */
async function fetchVideoWithFullDownload(imageUrl: string, offset: number, size?: number): Promise<Blob | null> {
  const response = await fetch(imageUrl)
  const arrayBuffer = await response.arrayBuffer()

  // 提取视频部分
  const videoData = size ? arrayBuffer.slice(offset, offset + size) : arrayBuffer.slice(offset)

  const blob = new Blob([videoData], { type: 'video/mp4' })

  // 验证是否为有效的 MP4
  if (!(await isValidMp4(blob))) {
    console.error('[motion-photo] Extracted data is not a valid MP4')
    return null
  }

  return blob
}

/**
 * 验证 Blob 是否为有效的 MP4 文件
 * 检查 MP4 文件头中的 'ftyp' 标识
 */
async function isValidMp4(blob: Blob): Promise<boolean> {
  if (blob.size < 32) {
    return false
  }

  const header = await blob.slice(0, 32).arrayBuffer()
  const headerBytes = new Uint8Array(header)

  // 在前 32 字节中查找 'ftyp' (0x66 0x74 0x79 0x70)
  const ftypSignature = [0x66, 0x74, 0x79, 0x70]

  for (let i = 0; i <= headerBytes.length - 4; i++) {
    if (
      headerBytes[i] === ftypSignature[0]
      && headerBytes[i + 1] === ftypSignature[1]
      && headerBytes[i + 2] === ftypSignature[2]
      && headerBytes[i + 3] === ftypSignature[3]
    ) {
      return true
    }
  }

  return false
}
