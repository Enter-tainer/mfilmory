import { useScrollViewElement } from '@afilmory/ui'
import clsx from 'clsx'
import { useAtomValue } from 'jotai'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { gallerySettingAtom } from '~/atoms/app'
import { useHasActiveFilters } from '~/hooks/useHasActiveFilters'
import { useContextPhotos } from '~/hooks/usePhotoViewer'
import { useVisiblePhotosDateRange } from '~/hooks/useVisiblePhotosDateRange'
import { dismissSsgShell, replaySsgPendingAction } from '~/lib/ssg-handoff'
import type { PhotoManifest } from '~/types/photo'

import { MasonryView } from './MasonryView'
import { PageFooter } from './PageFooter'
import { PageHeader } from './PageHeader'

const ActiveFiltersHero = lazy(() => import('./ActiveFiltersHero').then(m => ({ default: m.ActiveFiltersHero })))
const ListView = lazy(() => import('./ListView').then(m => ({ default: m.ListView })))

export const PhotosRoot = () => {
  const { viewMode } = useAtomValue(gallerySettingAtom)
  const [showFloatingActions, setShowFloatingActions] = useState(false)

  const photos = useContextPhotos()
  const { dateRange, handleRender } = useVisiblePhotosDateRange(photos)
  const scrollElement = useScrollViewElement()
  const navigate = useNavigate()
  const hasDismissedSsgRef = useRef(false)

  // 监听滚动，控制浮动组件的显示
  useEffect(() => {
    if (!scrollElement) {
      return
    }

    const handleScroll = () => {
      const { scrollTop } = scrollElement
      setShowFloatingActions(scrollTop > 500)
    }

    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [scrollElement])

  const hasActiveFilters = useHasActiveFilters()

  const onMasonryRender = useCallback(
    (startIndex: number, stopIndex: number, items: PhotoManifest[]) => {
      handleRender(startIndex, stopIndex, items)
      if (hasDismissedSsgRef.current) {
        return
      }
      const ssgTileCount = document.querySelectorAll('#ssg-shell [data-ssg-photo]').length
      const positionedCells = document.querySelectorAll(
        '#root [role="gridcell"]:not([style*="visibility: hidden"])',
      ).length
      const readyToDismiss
        = ssgTileCount === 0
          || items.length === 0
          || stopIndex + 1 >= items.length
          || positionedCells >= Math.min(items.length, ssgTileCount)
      if (!readyToDismiss) {
        return
      }
      hasDismissedSsgRef.current = true
      dismissSsgShell({
        waitImages: !window.__SSG_PENDING_ACTION__,
        scrollElement,
        onDismiss: () => replaySsgPendingAction(navigate),
      })
    },
    [handleRender, navigate, scrollElement],
  )

  useEffect(() => {
    if (!hasDismissedSsgRef.current && (photos.length === 0 || viewMode === 'list' || hasActiveFilters)) {
      hasDismissedSsgRef.current = true
      dismissSsgShell({
        waitImages: false,
        scrollElement,
        onDismiss: () => replaySsgPendingAction(navigate),
      })
    }
  }, [hasActiveFilters, navigate, photos.length, scrollElement, viewMode])

  return (
    <>
      <PageHeader
        dateRange={dateRange.formattedRange}
        location={dateRange.location}
        showDateRange={showFloatingActions && !!dateRange.formattedRange}
      />

      {hasActiveFilters && (
        <Suspense fallback={null}>
          <ActiveFiltersHero />
        </Suspense>
      )}

      <div className={clsx('p-1 **:select-none! lg:px-0', 'pb-20 lg:pb-24', !hasActiveFilters && 'mt-12')}>
        {viewMode === 'list' ? (
          <Suspense fallback={null}>
            <ListView photos={photos} />
          </Suspense>
        ) : (
          <MasonryView photos={photos} onRender={onMasonryRender} />
        )}
      </div>

      <PageFooter />
    </>
  )
}
