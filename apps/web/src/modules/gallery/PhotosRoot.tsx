import { useScrollViewElement } from '@afilmory/ui'
import clsx from 'clsx'
import { lazy, Suspense, useEffect, useState } from 'react'

import { useHasActiveFilters } from '~/hooks/useHasActiveFilters'
import { useContextPhotos } from '~/hooks/usePhotoViewer'
import { useVisiblePhotosDateRange } from '~/hooks/useVisiblePhotosDateRange'

import { useCanvasUrlSync } from './canvas/useCanvasUrlSync'
import { useEffectiveViewMode } from './canvas/useEffectiveViewMode'
import { MasonryView } from './MasonryView'
import { PageFooter } from './PageFooter'
import { PageHeader } from './PageHeader'

const ActiveFiltersHero = lazy(() => import('./ActiveFiltersHero').then(m => ({ default: m.ActiveFiltersHero })))
const ListView = lazy(() => import('./ListView').then(m => ({ default: m.ListView })))
const CanvasView = lazy(() => import('./canvas/CanvasView').then(m => ({ default: m.CanvasView })))

export const PhotosRoot = () => {
  useCanvasUrlSync()
  const viewMode = useEffectiveViewMode()
  const [showFloatingActions, setShowFloatingActions] = useState(false)

  const photos = useContextPhotos()
  const { dateRange, handleRender } = useVisiblePhotosDateRange(photos)
  const scrollElement = useScrollViewElement()

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

  if (viewMode === 'canvas') {
    return (
      <>
        <PageHeader />
        {photos.length === 0 && hasActiveFilters ? (
          <Suspense fallback={null}>
            <ActiveFiltersHero />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <CanvasView />
          </Suspense>
        )}
      </>
    )
  }

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
          <MasonryView photos={photos} onRender={handleRender} />
        )}
      </div>

      <PageFooter />
    </>
  )
}
