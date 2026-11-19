import { useScrollViewElement } from '@afilmory/ui'
import clsx from 'clsx'
import { useAtomValue } from 'jotai'
import { lazy, Suspense, useEffect, useState } from 'react'

import { gallerySettingAtom } from '~/atoms/app'
import { useHasActiveFilters } from '~/hooks/useHasActiveFilters'
import { useContextPhotos } from '~/hooks/usePhotoViewer'
import { useVisiblePhotosDateRange } from '~/hooks/useVisiblePhotosDateRange'

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

  // 监听滚动，控制浮动组件的显示
  useEffect(() => {
    if (!scrollElement) return

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
