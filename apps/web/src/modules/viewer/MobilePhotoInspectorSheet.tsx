import type { PickedExif } from '@afilmory/builder'
import { createInspectorSheetPresentation, resolveInspectorSheetHeight } from '@afilmory/viewer-motion'
import type { MotionValue } from 'motion/react'
import { m, useTransform } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useViewport } from '~/hooks/useViewport'
import { ExifPanelContent } from '~/modules/metadata/ExifPanel'
import type { PhotoManifest } from '~/types/photo'

interface MobilePhotoInspectorSheetProps {
  createPresentation?: typeof createInspectorSheetPresentation
  currentPhoto: PhotoManifest
  exifData: PickedExif | null
  activeRegionId?: string | null
  isInteractive: boolean
  progress: MotionValue<number>
  resolveHeight?: typeof resolveInspectorSheetHeight
  onClose: () => void
  onActiveRegionChange?: (regionId: string | null) => void
}

export const MobilePhotoInspectorSheet = ({
  createPresentation = createInspectorSheetPresentation,
  currentPhoto,
  exifData,
  activeRegionId,
  isInteractive,
  progress,
  resolveHeight = resolveInspectorSheetHeight,
  onClose,
  onActiveRegionChange,
}: MobilePhotoInspectorSheetProps) => {
  const { t } = useTranslation()
  const sheetRef = useRef<HTMLDivElement>(null)
  const viewportHeight = useViewport(value => value.h) || (typeof window !== 'undefined' ? window.innerHeight : 844)
  const sheetHeight = useMemo(() => resolveHeight(viewportHeight), [resolveHeight, viewportHeight])

  useEffect(() => {
    if (!isInteractive) {
      const { activeElement } = document
      if (activeElement instanceof HTMLElement && sheetRef.current?.contains(activeElement)) {
        activeElement.blur()
      }
    }
  }, [isInteractive])

  const handleClose = useCallback(() => {
    const { activeElement } = document
    if (activeElement instanceof HTMLElement && sheetRef.current?.contains(activeElement)) {
      activeElement.blur()
    }

    onClose()
  }, [onClose])

  const getSheetPresentation = () => createPresentation({ progress: progress.get(), sheetHeight })
  const sheetY = useTransform(() => getSheetPresentation().y)
  const sheetOpacity = useTransform(() => getSheetPresentation().opacity)
  const sheetScale = useTransform(() => getSheetPresentation().scale)

  return (
    <m.div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center"
      aria-hidden={!isInteractive}
      inert={!isInteractive}
      style={{
        y: sheetY,
        opacity: sheetOpacity,
      }}
    >
      <m.div
        ref={sheetRef}
        className="bg-material-ultra-thick border-accent/20 pointer-events-auto relative flex w-full max-w-screen-lg flex-col overflow-hidden rounded-t-[28px] border text-white backdrop-blur-3xl"
        style={{
          height: sheetHeight,
          scale: sheetScale,
          transformOrigin: '50% 100%',
          boxShadow:
            '0 -20px 64px color-mix(in srgb, var(--color-accent) 16%, transparent), 0 -8px 28px rgba(0, 0, 0, 0.32)',
          pointerEvents: isInteractive ? 'auto' : 'none',
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 rounded-t-[28px]"
          style={{
            background:
              'linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 16%, color-mix(in srgb, var(--color-accent) 7%, transparent))',
          }}
        />

        <div className="relative z-10 flex shrink-0 flex-col px-4 pt-3">
          <div className="mb-3 flex items-center justify-center">
            <div className="h-1.5 w-11 rounded-full bg-white/20" />
          </div>

          <div className="flex items-center gap-2 pb-1">
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-white">{t('exif.header.title')}</div>
            </div>

            <button
              type="button"
              className="hover:bg-accent/10 flex size-9 shrink-0 items-center justify-center rounded-xl text-white/80 transition-colors hover:text-white"
              onClick={handleClose}
              aria-label="Close details"
            >
              <i className="i-mingcute-close-line text-lg" />
            </button>
          </div>
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <ExifPanelContent
            currentPhoto={currentPhoto}
            exifData={exifData}
            activeRegionId={activeRegionId}
            onActiveRegionChange={onActiveRegionChange}
            rootClassName="min-h-0 flex-1"
            viewportClassName="px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] **:select-text"
          />
        </div>
      </m.div>
    </m.div>
  )
}
