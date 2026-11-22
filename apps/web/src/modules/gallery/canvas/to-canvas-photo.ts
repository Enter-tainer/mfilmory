import type { CanvasPhoto } from '@afilmory/photo-canvas'
import { decompressUint8Array } from '@afilmory/utils'

import type { PhotoManifest } from '~/types/photo'

const MIN_ASPECT_RATIO = 0.05
const MAX_ASPECT_RATIO = 20

const cameraOf = (photo: PhotoManifest) => {
  const make = photo.exif?.Make?.trim()
  const model = photo.exif?.Model?.trim()
  return make && model ? `${make} ${model}` : null
}

const thumbHashOf = (photo: PhotoManifest) => {
  if (!photo.thumbHash) {
    return null
  }
  try {
    return decompressUint8Array(photo.thumbHash)
  }
  catch {
    return null
  }
}

const aspectOf = (photo: PhotoManifest) => {
  const ratio = photo.aspectRatio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
    return 1
  }
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, ratio))
}

export const toCanvasPhoto = (photo: PhotoManifest): CanvasPhoto => ({
  id: photo.id,
  aspectRatio: aspectOf(photo),
  thumbnailUrl: photo.thumbnailUrl,
  thumbHash: thumbHashOf(photo),
  dateTaken: photo.dateTaken,
  camera: cameraOf(photo),
  tags: photo.tags ?? [],
  place: photo.location?.city || photo.location?.country || null,
})
