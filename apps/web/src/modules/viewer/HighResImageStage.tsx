import type { PhotoRegion } from '@afilmory/builder'
import { clsxm } from '@afilmory/utils'
import type { AppleGainMapSource, ImageViewportState } from '@afilmory/webgl-viewer'
import { ImageViewer, LoadingState } from '@afilmory/webgl-viewer'
import type { TFunction } from 'i18next'
import { AnimatePresence, m } from 'motion/react'
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { MenuItemSeparator, MenuItemText, useShowContextMenu } from '~/atoms/context-menu'
import { SlidingNumber } from '~/components/ui/number/SlidingNumber'
import { isMobileDevice } from '~/lib/device-viewport'
import type { ImageLoaderManager } from '~/lib/image-loader-manager'
import type { LoadingIndicatorRef } from '~/modules/inspector/LoadingIndicator'
import { HDRBadge } from '~/modules/media/HDRBadge'
import { LivePhotoBadge } from '~/modules/media/LivePhotoBadge'
import type { LivePhotoVideoHandle } from '~/modules/media/LivePhotoVideo'
import { LivePhotoVideo } from '~/modules/media/LivePhotoVideo'

import { PhotoRegionsOverlay } from './PhotoRegionsOverlay'
import type { VideoSource } from './types'
import { SHOW_SCALE_INDICATOR_DURATION } from './types'

interface HighResImageStageProps {
  blobSrc: string
  gainMap?: AppleGainMapSource
  alt: string
  width?: number
  height?: number
  enableZoom: boolean
  enablePan: boolean
  minZoom: number
  maxZoom: number
  isCurrentImage: boolean
  hasVideo: boolean
  videoSource?: VideoSource
  shouldAutoPlayVideoOnce: boolean
  isLivePhotoPlaying: boolean
  imageLoaderManagerRef: React.RefObject<ImageLoaderManager | null>
  loadingIndicatorRef: React.RefObject<LoadingIndicatorRef | null>
  livePhotoRef: React.RefObject<LivePhotoVideoHandle | null>
  regions: PhotoRegion[]
  regionOrientation?: number
  regionAccentColor?: string
  regionLabelPlacement?: 'edge' | 'floating'
  activeRegionId?: string | null
  showAllRegions: boolean
  enableRegionHover: boolean
  onActiveRegionChange?: (regionId: string | null) => void
  onHighResRendered: () => void
  onError: () => void
  onZoomChange?: (isZoomed: boolean) => void
  onLivePhotoPlayingChange: (playing: boolean) => void
}

const createContextMenuItems = (blobSrc: string, alt: string, t: TFunction<'app', undefined>) => [
  new MenuItemText({
    label: t('photo.copy.image'),
    click: async () => {
      const loadingToast = toast.loading(t('photo.copying'))

      try {
        // Create a canvas to convert the image to PNG
        const img = new Image()
        img.crossOrigin = 'anonymous'

        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = blobSrc
        })

        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight

        ctx?.drawImage(img, 0, 0)

        // Convert to PNG blob
        await new Promise<void>((resolve, reject) => {
          canvas.toBlob(async (pngBlob) => {
            try {
              if (pngBlob) {
                await navigator.clipboard.write([
                  new ClipboardItem({
                    'image/png': pngBlob,
                  }),
                ])
                resolve()
              }
              else {
                reject(new Error('Failed to convert image to PNG'))
              }
            }
            catch (error) {
              reject(error)
            }
          }, 'image/png')
        })

        toast.dismiss(loadingToast)
        toast.success(t('photo.copy.success'))
      }
      catch (error) {
        console.error('Failed to copy image:', error)

        // Fallback: try to copy the original blob
        try {
          const blob = await fetch(blobSrc).then(res => res.blob())
          await navigator.clipboard.write([
            new ClipboardItem({
              [blob.type]: blob,
            }),
          ])
          toast.dismiss(loadingToast)
          toast.success(t('photo.copy.success'))
        }
        catch (fallbackError) {
          console.error('Fallback copy also failed:', fallbackError)
          toast.dismiss(loadingToast)
          toast.error(t('photo.copy.error'))
        }
      }
    },
  }),
  MenuItemSeparator.default,
  new MenuItemText({
    label: t('photo.download'),
    click: () => {
      const a = document.createElement('a')
      a.href = blobSrc
      a.download = alt
      a.click()
    },
  }),
]

export const HighResImageStage = ({
  blobSrc,
  gainMap,
  alt,
  width,
  height,
  enableZoom,
  enablePan,
  minZoom,
  maxZoom,
  isCurrentImage,
  hasVideo,
  videoSource,
  shouldAutoPlayVideoOnce,
  isLivePhotoPlaying,
  imageLoaderManagerRef,
  loadingIndicatorRef,
  livePhotoRef,
  regions,
  regionOrientation,
  regionAccentColor,
  regionLabelPlacement,
  activeRegionId,
  showAllRegions,
  enableRegionHover,
  onActiveRegionChange,
  onHighResRendered,
  onError,
  onZoomChange,
  onLivePhotoPlayingChange,
}: HighResImageStageProps) => {
  const { t } = useTranslation()
  const showContextMenu = useShowContextMenu()

  const imageViewerHostRef = useRef<HTMLDivElement>(null)
  const viewportFrameRef = useRef<HTMLDivElement>(null)
  const scaleIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasOverlayViewportRef = useRef(false)

  const [hasOverlayViewport, setHasOverlayViewport] = useState(false)
  const [renderedHDR, setRenderedHDR] = useState(false)
  const [currentScale, setCurrentScale] = useState(1)
  const [showScaleIndicator, setShowScaleIndicator] = useState(false)

  const hasRegions = regions.length > 0

  useEffect(() => {
    return () => {
      if (scaleIndicatorTimeoutRef.current) {
        clearTimeout(scaleIndicatorTimeoutRef.current)
      }
    }
  }, [])

  const handleScaleChange = useCallback(
    (scale: number, isZoomed: boolean) => {
      startTransition(() => {
        setCurrentScale(scale)
        setShowScaleIndicator(true)
      })

      if (scaleIndicatorTimeoutRef.current) {
        clearTimeout(scaleIndicatorTimeoutRef.current)
      }

      scaleIndicatorTimeoutRef.current = setTimeout(() => {
        setShowScaleIndicator(false)
      }, SHOW_SCALE_INDICATOR_DURATION)

      onZoomChange?.(isZoomed)
    },
    [onZoomChange],
  )

  const onTransformed = useCallback(
    (originalScale: number, relativeScale: number) => {
      const isZoomed = Math.abs(relativeScale - 1) > 0.01
      handleScaleChange(originalScale, isZoomed)
    },
    [handleScaleChange],
  )

  const handleImageLoadingStateChange = useCallback(
    (isLoading: boolean, state?: LoadingState, quality?: 'high' | 'medium' | 'low' | 'unknown') => {
      let message = ''

      if (state === LoadingState.CREATE_TEXTURE) {
        message = t('photo.webgl.creatingTexture')
      }
      else if (state === LoadingState.IMAGE_LOADING) {
        message = t('photo.webgl.loadingImage')
      }

      loadingIndicatorRef.current?.updateLoadingState({
        isVisible: isLoading,
        isWebGLLoading: isLoading,
        webglMessage: message,
        webglQuality: quality,
      })
    },
    [t, loadingIndicatorRef],
  )

  const imagePinchConfig = useMemo(
    () => ({
      step: 0.5,
      disabled: !enableZoom,
    }),
    [enableZoom],
  )

  const imageDoubleClickConfig = useMemo(
    () => ({
      step: 2,
      disabled: !enableZoom,
      mode: 'toggle' as const,
      animationTime: 200,
    }),
    [enableZoom],
  )

  const imagePanningConfig = useMemo(
    () => ({
      disabled: !enablePan,
    }),
    [enablePan],
  )

  const handleViewportChange = useCallback((viewport: ImageViewportState) => {
    const overlayFrame = viewportFrameRef.current
    if (!overlayFrame) {
      return
    }

    const renderedWidth = viewport.imageWidth * viewport.scale
    const renderedHeight = viewport.imageHeight * viewport.scale
    const left = viewport.containerWidth / 2 + viewport.translateX - renderedWidth / 2
    const top = viewport.containerHeight / 2 + viewport.translateY - renderedHeight / 2

    overlayFrame.style.width = `${renderedWidth}px`
    overlayFrame.style.height = `${renderedHeight}px`
    overlayFrame.style.transform = `translate3d(${left}px, ${top}px, 0)`

    if (!hasOverlayViewportRef.current) {
      hasOverlayViewportRef.current = true
      setHasOverlayViewport(true)
    }
  }, [])

  const getViewerCanvas = useCallback(() => {
    const canvas = imageViewerHostRef.current?.querySelector('canvas')
    return canvas instanceof HTMLCanvasElement ? canvas : null
  }, [])

  const shouldForwardViewerEvent = useCallback((target: EventTarget | null, canvas: HTMLCanvasElement) => {
    return target instanceof Node && !canvas.contains(target)
  }, [])

  const dispatchMouseEventToCanvas = useCallback(
    (type: 'mousedown' | 'mousemove' | 'mouseup' | 'dblclick', event: React.MouseEvent<HTMLDivElement>) => {
      const canvas = getViewerCanvas()
      if (!canvas || !shouldForwardViewerEvent(event.target, canvas)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      canvas.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        }),
      )
    },
    [getViewerCanvas, shouldForwardViewerEvent],
  )

  const dispatchTouchEventToCanvas = useCallback(
    (type: 'touchstart' | 'touchmove' | 'touchend', event: React.TouchEvent<HTMLDivElement>) => {
      const canvas = getViewerCanvas()
      if (!canvas || !shouldForwardViewerEvent(event.target, canvas) || typeof TouchEvent === 'undefined') {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      canvas.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: Array.from(event.nativeEvent.touches),
          targetTouches: Array.from(event.nativeEvent.targetTouches),
          changedTouches: Array.from(event.nativeEvent.changedTouches),
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        }),
      )
    },
    [getViewerCanvas, shouldForwardViewerEvent],
  )

  const handleOverlayWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const canvas = imageViewerHostRef.current?.querySelector('canvas')
      if (!(canvas instanceof HTMLCanvasElement) || !shouldForwardViewerEvent(event.target, canvas)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        }),
      )
    },
    [shouldForwardViewerEvent],
  )

  useLayoutEffect(() => {
    setRenderedHDR(false)
    hasOverlayViewportRef.current = false
    setHasOverlayViewport(false)

    const overlayFrame = viewportFrameRef.current
    if (!overlayFrame) {
      return
    }

    overlayFrame.style.width = '0px'
    overlayFrame.style.height = '0px'
    overlayFrame.style.transform = 'translate3d(0px, 0px, 0)'
  }, [blobSrc])

  return (
    <>
      <div
        className="absolute inset-0 h-full w-full"
        onContextMenu={(e) => {
          const items = createContextMenuItems(blobSrc, alt, t)
          showContextMenu(items, e)
        }}
      >
        <div
          ref={imageViewerHostRef}
          className="absolute inset-0 h-full w-full"
          onWheelCapture={handleOverlayWheel}
          onMouseDownCapture={event => dispatchMouseEventToCanvas('mousedown', event)}
          onMouseMoveCapture={event => dispatchMouseEventToCanvas('mousemove', event)}
          onMouseUpCapture={event => dispatchMouseEventToCanvas('mouseup', event)}
          onDoubleClickCapture={event => dispatchMouseEventToCanvas('dblclick', event)}
          onTouchStartCapture={event => dispatchTouchEventToCanvas('touchstart', event)}
          onTouchMoveCapture={event => dispatchTouchEventToCanvas('touchmove', event)}
          onTouchEndCapture={event => dispatchTouchEventToCanvas('touchend', event)}
        >
          <ImageViewer
            src={blobSrc}
            gainMapSource={gainMap}
            alt={alt}
            onLoad={onHighResRendered}
            onHDRChange={setRenderedHDR}
            onError={onError}
            className="absolute inset-0 h-full w-full"
            width={width}
            height={height}
            initialScale={1}
            minScale={minZoom}
            maxScale={maxZoom}
            pinch={imagePinchConfig}
            doubleClick={imageDoubleClickConfig}
            panning={imagePanningConfig}
            limitToBounds={true}
            centerOnInit={true}
            smooth={true}
            onZoomChange={onTransformed}
            onViewportChange={handleViewportChange}
            onLoadingStateChange={handleImageLoadingStateChange}
            debug={import.meta.env.DEV && !isMobileDevice}
          />
          {(hasRegions || hasVideo) && (
            <div className="pointer-events-none absolute inset-0 z-20">
              <div
                ref={viewportFrameRef}
                className={clsxm(
                  'absolute left-0 top-0 overflow-visible transition-opacity duration-200',
                  hasOverlayViewport ? 'opacity-100' : 'opacity-0',
                )}
              >
                {hasVideo && videoSource && imageLoaderManagerRef.current && hasOverlayViewport && (
                  <LivePhotoVideo
                    ref={livePhotoRef}
                    videoSource={videoSource}
                    imageLoaderManager={imageLoaderManagerRef.current}
                    loadingIndicatorRef={loadingIndicatorRef}
                    isCurrentImage={isCurrentImage}
                    onPlayingChange={onLivePhotoPlayingChange}
                    shouldAutoPlayOnce={shouldAutoPlayVideoOnce}
                  />
                )}
                {hasRegions && (
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
              </div>
            </div>
          )}
        </div>
      </div>

      {hasVideo && (
        <LivePhotoBadge
          livePhotoRef={livePhotoRef}
          isLivePhotoPlaying={isLivePhotoPlaying}
          imageLoaderManagerRef={imageLoaderManagerRef}
        />
      )}

      {renderedHDR && <HDRBadge />}

      <AnimatePresence>
        {showScaleIndicator && (
          <m.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-0.5 rounded bg-black/50 px-3 py-1 text-lg text-white tabular-nums"
          >
            <SlidingNumber number={currentScale} decimalPlaces={1} />
            <span>x</span>
          </m.div>
        )}
      </AnimatePresence>
    </>
  )
}
