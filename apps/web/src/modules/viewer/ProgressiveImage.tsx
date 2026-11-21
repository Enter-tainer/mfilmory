import { clsxm } from '@afilmory/utils'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isPreviewImageLoaded, markPreviewImageLoaded } from '~/lib/preview-prewarm'
import type { LivePhotoVideoHandle } from '~/modules/media/LivePhotoVideo'

import { ContainedImageFrame } from './ContainedImageFrame'
import { getProgressiveImageVisualReady, isThumbnailElementVisuallyReady } from './entry-animation-state'
import { useImageLoader, useLivePhotoControls, useProgressiveImageState } from './hooks'
import { PhotoRegionsOverlay } from './PhotoRegionsOverlay'
import type { ProgressiveImageProps } from './types'

const HighResImageStage = lazy(() => import('./HighResImageStage').then(m => ({ default: m.HighResImageStage })))

const loadedThumbnailSrcSet = new Set<string>()
const PREVIEW_HIGHRES_FALLBACK_TIMEOUT_MS = 5000

export const ProgressiveImage = ({
  src,
  thumbnailSrc,
  alt,
  width,
  height,
  className,
  onError,
  onProgress,
  onZoomChange,
  onBlobSrcChange,
  onVisualReadyChange,
  onPreviewSettled,
  disableThumbnailTransition = false,
  canLoadPreview = true,
  eagerRevealPreview = false,
  enableZoom = true,
  enablePan = true,
  maxZoom = 20,
  minZoom = 1,
  isCurrentImage = false,
  shouldRenderHighRes = true,
  videoSource,
  shouldAutoPlayVideoOnce = false,
  regions = [],
  regionOrientation,
  regionAccentColor,
  regionLabelPlacement,
  activeRegionId,
  showAllRegions = false,
  enableRegionHover = true,
  onActiveRegionChange,
  loadingIndicatorRef,
}: ProgressiveImageProps) => {
  const { t } = useTranslation()

  const [state, setState] = useProgressiveImageState()
  const {
    blobSrc,
    highResLoaded,
    error,
    isHighResImageRendered,
    isThumbnailLoaded,
    isLivePhotoPlaying,
  } = state

  const [isThumbnailError, setIsThumbnailError] = useState(false)
  const [highResFallbackReady, setHighResFallbackReady] = useState(false)

  const isActiveImage = Boolean(isCurrentImage && shouldRenderHighRes)
  const hasVideo = Boolean(videoSource && videoSource.type !== 'none')

  const thumbnailRef = useRef<HTMLImageElement>(null)
  const livePhotoRef = useRef<LivePhotoVideoHandle | null>(null)

  const resolvedSrc = useMemo(() => {
    if (src.startsWith('/')) {
      return typeof window !== 'undefined' ? new URL(src, window.location.origin).toString() : src
    }
    return src
  }, [src])

  const isPreviewSettled = !thumbnailSrc || isThumbnailLoaded || isThumbnailError || isHighResImageRendered
  const shouldLoadHighRes = isCurrentImage && (isPreviewSettled || highResFallbackReady)

  useEffect(() => {
    if (!isCurrentImage || !thumbnailSrc || isPreviewSettled) {
      setHighResFallbackReady(false)
      return
    }
    const timer = window.setTimeout(() => {
      setHighResFallbackReady(true)
    }, PREVIEW_HIGHRES_FALLBACK_TIMEOUT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [isCurrentImage, isPreviewSettled, thumbnailSrc])

  const imageLoaderManagerRef = useImageLoader(
    resolvedSrc,
    isCurrentImage,
    shouldLoadHighRes,
    highResLoaded,
    error,
    onProgress,
    onError,
    onBlobSrcChange,
    loadingIndicatorRef,
    setState.setBlobSrc,
    setState.setHighResLoaded,
    setState.setError,
    setState.setIsHighResImageRendered,
    setState.setGainMap,
  )

  const { handleLongPressStart, handleLongPressEnd } = useLivePhotoControls(hasVideo, isLivePhotoPlaying, livePhotoRef)

  const handleThumbnailLoad = useCallback(() => {
    if (thumbnailSrc) {
      loadedThumbnailSrcSet.add(thumbnailSrc)
      markPreviewImageLoaded(thumbnailSrc)
    }
    setIsThumbnailError(false)
    setState.setIsThumbnailLoaded(true)
  }, [setState, thumbnailSrc])

  const handleThumbnailError = useCallback(() => {
    setIsThumbnailError(true)
  }, [])

  useLayoutEffect(() => {
    setIsThumbnailError(false)

    if (!thumbnailSrc) {
      setState.setIsThumbnailLoaded(false)
      return
    }

    const thumbnailElement = thumbnailRef.current
    const isAlreadyLoaded
      = loadedThumbnailSrcSet.has(thumbnailSrc)
        || isPreviewImageLoaded(thumbnailSrc)
        || isThumbnailElementVisuallyReady({
          currentSrc: thumbnailElement?.currentSrc,
          naturalWidth: thumbnailElement?.naturalWidth,
          src: thumbnailElement?.src,
          thumbnailSrc,
        })

    if (isAlreadyLoaded) {
      loadedThumbnailSrcSet.add(thumbnailSrc)
      markPreviewImageLoaded(thumbnailSrc)
      setState.setIsThumbnailLoaded(true)
      return
    }

    setState.setIsThumbnailLoaded(false)
  }, [canLoadPreview, setState, thumbnailSrc])

  const hasRegions = regions.length > 0
  const shouldRenderThumbnailPhase = Boolean(thumbnailSrc && (!highResLoaded || !blobSrc || !isActiveImage || error))

  const isVisualReady = getProgressiveImageVisualReady({
    isHighResImageRendered,
    isThumbnailLoaded,
    thumbnailSrc,
  })

  useLayoutEffect(() => {
    onVisualReadyChange?.(isVisualReady)
  }, [isVisualReady, onVisualReadyChange])

  useLayoutEffect(() => {
    if (isCurrentImage) {
      onPreviewSettled?.(isPreviewSettled)
    }
  }, [isCurrentImage, isPreviewSettled, onPreviewSettled])

  const handleHighResRendered = useCallback(() => {
    setState.setIsHighResImageRendered(true)
  }, [setState])

  const handleHighResError = useCallback(() => {
    setState.setError(true)
    onError?.()
  }, [onError, setState])

  return (
    <div
      className={clsxm('relative overflow-hidden', className)}
      onMouseDown={handleLongPressStart}
      onMouseUp={handleLongPressEnd}
      onMouseLeave={handleLongPressEnd}
      onTouchStart={handleLongPressStart}
      onTouchEnd={handleLongPressEnd}
    >
      {/* 缩略图 / preview 占位图 - 在高分辨率图片未加载或加载失败时显示 */}
      {thumbnailSrc && canLoadPreview && (!isHighResImageRendered || error) && (
        <ContainedImageFrame
          width={width}
          height={height}
          className="absolute inset-0 flex h-full w-full items-center justify-center overflow-visible"
        >
          <img
            ref={thumbnailRef}
            src={thumbnailSrc}
            key={thumbnailSrc}
            alt={alt}
            fetchPriority={isCurrentImage ? 'high' : 'low'}
            loading={isCurrentImage ? 'eager' : 'lazy'}
            decoding={isCurrentImage ? 'sync' : 'async'}
            className={clsxm(
              'block size-full object-contain transition-opacity duration-300',
              (disableThumbnailTransition || eagerRevealPreview) && 'transition-none',
              isThumbnailLoaded || (eagerRevealPreview && !isThumbnailError) ? 'opacity-100' : 'opacity-0',
            )}
            onLoad={handleThumbnailLoad}
            onError={handleThumbnailError}
          />
          {hasRegions && shouldRenderThumbnailPhase && (
            <PhotoRegionsOverlay
              regions={regions}
              photoWidth={width}
              photoHeight={height}
              orientation={regionOrientation}
              accentColor={regionAccentColor}
              labelPlacement={regionLabelPlacement}
              activeRegionId={activeRegionId}
              showAllBoxes={showAllRegions}
              interactive={enableRegionHover}
              onActiveRegionChange={onActiveRegionChange}
            />
          )}
        </ContainedImageFrame>
      )}

      {/* 高分辨率 WebGL 舞台 - 按需懒加载，不阻塞首帧 preview 图绘制 */}
      {highResLoaded && blobSrc && isActiveImage && !error && (
        <Suspense fallback={null}>
          <HighResImageStage
            blobSrc={blobSrc}
            gainMap={state.gainMap}
            alt={alt}
            width={width}
            height={height}
            enableZoom={enableZoom}
            enablePan={enablePan}
            minZoom={minZoom}
            maxZoom={maxZoom}
            isCurrentImage={isCurrentImage}
            hasVideo={hasVideo}
            videoSource={videoSource}
            shouldAutoPlayVideoOnce={shouldAutoPlayVideoOnce}
            isLivePhotoPlaying={isLivePhotoPlaying}
            imageLoaderManagerRef={imageLoaderManagerRef}
            loadingIndicatorRef={loadingIndicatorRef}
            livePhotoRef={livePhotoRef}
            regions={regions}
            regionOrientation={regionOrientation}
            regionAccentColor={regionAccentColor}
            regionLabelPlacement={regionLabelPlacement}
            activeRegionId={activeRegionId}
            showAllRegions={showAllRegions}
            enableRegionHover={enableRegionHover}
            onActiveRegionChange={onActiveRegionChange}
            onHighResRendered={handleHighResRendered}
            onError={handleHighResError}
            onZoomChange={onZoomChange}
            onLivePhotoPlayingChange={setState.setIsLivePhotoPlaying}
          />
        </Suspense>
      )}

      {/* 操作提示 */}
      {!hasVideo && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded bg-black/50 px-2 py-1 text-xs text-white opacity-0 duration-200 group-hover:opacity-50">
          {t('photo.zoom.hint')}
        </div>
      )}
    </div>
  )
}

export type { ProgressiveImageProps } from './types'
