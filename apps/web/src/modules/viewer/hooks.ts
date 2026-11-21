import type { AppleGainMapSource } from '@afilmory/webgl-viewer'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isMobileDevice } from '~/lib/device-viewport'
import type { ImageLoaderManager } from '~/lib/image-loader-manager'
import type { LoadingIndicatorRef } from '~/modules/inspector/LoadingIndicator'
import type { LivePhotoVideoHandle } from '~/modules/media/LivePhotoVideo'

import type { ProgressiveImageState } from './types'

export const useProgressiveImageState = (): [
  ProgressiveImageState,
  {
    setGainMap: (gainMap: AppleGainMapSource | undefined) => void
    setBlobSrc: (src: string | null) => void
    setHighResLoaded: (loaded: boolean) => void
    setError: (error: boolean) => void
    setIsHighResImageRendered: (rendered: boolean) => void
    setIsThumbnailLoaded: (loaded: boolean) => void
    setIsLivePhotoPlaying: (playing: boolean) => void
  },
] => {
  const [gainMap, setGainMap] = useState<AppleGainMapSource>()
  const [blobSrc, setBlobSrc] = useState<string | null>(null)
  const [highResLoaded, setHighResLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [isHighResImageRendered, setIsHighResImageRendered] = useState(false)
  const [isThumbnailLoaded, setIsThumbnailLoaded] = useState(false)
  const [isLivePhotoPlaying, setIsLivePhotoPlaying] = useState(false)

  return [
    {
      gainMap,
      blobSrc,
      highResLoaded,
      error,
      isHighResImageRendered,
      isThumbnailLoaded,
      isLivePhotoPlaying,
    },
    {
      setGainMap,
      setBlobSrc,
      setHighResLoaded,
      setError,
      setIsHighResImageRendered,
      setIsThumbnailLoaded,
      setIsLivePhotoPlaying,
    },
  ]
}

export const useImageLoader = (
  src: string,
  isCurrentImage: boolean,
  shouldLoadHighRes: boolean,
  highResLoaded: boolean,
  error: boolean,
  onProgress?: (progress: number) => void,
  onError?: () => void,
  onBlobSrcChange?: (blobSrc: string | null) => void,
  loadingIndicatorRef?: React.RefObject<LoadingIndicatorRef | null>,
  setBlobSrc?: (src: string | null) => void,
  setHighResLoaded?: (loaded: boolean) => void,
  setError?: (error: boolean) => void,
  setIsHighResImageRendered?: (rendered: boolean) => void,
  setGainMap?: (gainMap: AppleGainMapSource | undefined) => void,
) => {
  const { t } = useTranslation()
  const imageLoaderManagerRef = useRef<ImageLoaderManager | null>(null)

  useEffect(() => {
    if (!shouldLoadHighRes || highResLoaded || error || !isCurrentImage) {
      return
    }

    let disposed = false
    let imageLoaderManager: ImageLoaderManager | null = null

    function cleanup() {
      setGainMap?.(undefined)
      setHighResLoaded?.(false)
      setBlobSrc?.(null)
      setError?.(false)
      onBlobSrcChange?.(null)
      setIsHighResImageRendered?.(false)

      // Reset loading indicator
      loadingIndicatorRef?.current?.resetLoadingState()
    }

    const loadImage = async () => {
      try {
        // 并行预加载高分辨率 WebGL 舞台 chunk，避免原图 XHR 完成后再串行等 chunk
        void import('./HighResImageStage')
        const { ImageLoaderManager } = await import('~/lib/image-loader-manager')
        if (disposed) {
          return
        }

        imageLoaderManager = new ImageLoaderManager()
        imageLoaderManagerRef.current = imageLoaderManager

        const result = await imageLoaderManager.loadImage(src, {
          onProgress,
          onError,
          onLoadingStateUpdate: (state) => {
            loadingIndicatorRef?.current?.updateLoadingState(state)
          },
        })

        if (disposed) {
          return
        }
        setGainMap?.(result.gainMap)
        setBlobSrc?.(result.blobSrc)
        onBlobSrcChange?.(result.blobSrc)
        setHighResLoaded?.(true)
      }
      catch (loadError) {
        if (disposed) {
          return
        }
        console.error('Failed to load image:', loadError)
        setError?.(true)

        // 显示错误状态，而不是完全隐藏图片
        loadingIndicatorRef?.current?.updateLoadingState({
          isVisible: true,
          isError: true,
          errorMessage: t('photo.error.loading'),
        })
      }
    }

    cleanup()
    void loadImage()

    return () => {
      disposed = true
      imageLoaderManager?.cleanup()
      if (imageLoaderManagerRef.current === imageLoaderManager) {
        imageLoaderManagerRef.current = null
      }
    }
  }, [
    shouldLoadHighRes,
    highResLoaded,
    error,
    onProgress,
    src,
    onError,
    isCurrentImage,
    onBlobSrcChange,
    loadingIndicatorRef,
    t,
    setBlobSrc,
    setGainMap,
    setHighResLoaded,
    setError,
    setIsHighResImageRendered,
  ])

  return imageLoaderManagerRef
}

export const useLivePhotoControls = (
  isLivePhoto: boolean,
  isLivePhotoPlaying: boolean,
  livePhotoRef: React.RefObject<LivePhotoVideoHandle | null>,
) => {
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleLongPressStart = useCallback(
    (event?: React.SyntheticEvent) => {
      if (!isMobileDevice) {
        return
      }
      // Multi-touch is a pinch-zoom, not a long press: cancel the timer and stop any playback
      if (((event as React.TouchEvent | undefined)?.touches?.length ?? 0) > 1) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current)
        }
        if (isLivePhotoPlaying) {
          livePhotoRef.current?.stop()
        }
        return
      }
      const playVideo = () => livePhotoRef.current?.play()
      if (!isLivePhoto || !livePhotoRef.current?.getIsVideoLoaded() || isLivePhotoPlaying) {
        return
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
      longPressTimerRef.current = setTimeout(playVideo, 200)
    },
    [isLivePhoto, isLivePhotoPlaying, livePhotoRef],
  )

  const handleLongPressEnd = useCallback(() => {
    if (!isMobileDevice) {
      return
    }
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
    }
    if (isLivePhotoPlaying) {
      livePhotoRef.current?.stop()
    }
  }, [isLivePhotoPlaying, livePhotoRef])

  return { handleLongPressStart, handleLongPressEnd }
}
