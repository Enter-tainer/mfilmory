interface ResolvePhotoViewerEntryStateParams {
  hasTransitionTrigger: boolean
  isCurrentImageVisualReady: boolean
  isEntryTransitionActive: boolean
  isOpen: boolean
  isViewerContentVisible: boolean
}

interface ResolvePhotoViewerEntryStateResult {
  shouldMountImageStage: boolean
  shouldShowEntryImageCatchup: boolean
}

interface ProgressiveImageVisualReadyParams {
  isHighResImageRendered: boolean
  isThumbnailLoaded: boolean
  thumbnailSrc?: string
}

interface ThumbnailElementVisualReadyParams {
  currentSrc?: string
  naturalWidth?: number
  src?: string
  thumbnailSrc?: string
}

interface ShouldHideCurrentViewerImageParams {
  isCurrentImage: boolean
  isEntryImageCatchupVisible: boolean
}

export const resolvePhotoViewerEntryState = ({
  hasTransitionTrigger,
  isCurrentImageVisualReady,
  isEntryTransitionActive,
  isOpen,
  isViewerContentVisible,
}: ResolvePhotoViewerEntryStateParams): ResolvePhotoViewerEntryStateResult => {
  const shouldMountImageStage = isOpen && (isViewerContentVisible || !hasTransitionTrigger)
  const shouldShowEntryImageCatchup = Boolean(
    isOpen && hasTransitionTrigger && isViewerContentVisible && (isEntryTransitionActive || !isCurrentImageVisualReady),
  )

  return {
    shouldMountImageStage,
    shouldShowEntryImageCatchup,
  }
}

export const getProgressiveImageVisualReady = ({
  isHighResImageRendered,
  isThumbnailLoaded,
  thumbnailSrc,
}: ProgressiveImageVisualReadyParams) => {
  return Boolean((thumbnailSrc && isThumbnailLoaded) || isHighResImageRendered)
}

function normalizeUrlForComparison(value: string): string {
  try {
    return new URL(value, 'http://localhost').href
  }
  catch {
    try {
      return decodeURIComponent(value)
    }
    catch {
      return value
    }
  }
}

function urlMatchesThumbnail(candidate: string | undefined, thumbnailSrc: string): boolean {
  if (!candidate) {
    return false
  }
  if (candidate.includes(thumbnailSrc) || candidate === thumbnailSrc) {
    return true
  }
  const normalizedCandidate = normalizeUrlForComparison(candidate)
  const normalizedThumbnail = normalizeUrlForComparison(thumbnailSrc)
  return normalizedCandidate === normalizedThumbnail || normalizedCandidate.includes(normalizedThumbnail)
}

export const isThumbnailElementVisuallyReady = ({
  currentSrc,
  naturalWidth,
  src,
  thumbnailSrc,
}: ThumbnailElementVisualReadyParams) => {
  if (!thumbnailSrc || !naturalWidth || naturalWidth <= 0) {
    return false
  }

  return urlMatchesThumbnail(currentSrc, thumbnailSrc) || urlMatchesThumbnail(src, thumbnailSrc)
}

export const shouldHideCurrentViewerImage = ({
  isCurrentImage,
  isEntryImageCatchupVisible,
}: ShouldHideCurrentViewerImageParams) => {
  return Boolean(isCurrentImage && isEntryImageCatchupVisible)
}
