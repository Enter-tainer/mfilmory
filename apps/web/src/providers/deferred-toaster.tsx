import { useAtomValue } from 'jotai'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useLocation } from 'react-router'

import { viewerAtom } from '~/atoms/viewer'

const LazyToaster = lazy(() => import('./toaster-impl'))

export const DeferredToaster = () => {
  const isViewerOpen = useAtomValue(viewerAtom).isOpen
  const { pathname } = useLocation()
  const shouldMount = isViewerOpen || pathname.startsWith('/photos/')
  const [hasMounted, setHasMounted] = useState(shouldMount)

  useEffect(() => {
    if (shouldMount) {
      setHasMounted(true)
    }
  }, [shouldMount])

  if (!hasMounted) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <LazyToaster />
    </Suspense>
  )
}
