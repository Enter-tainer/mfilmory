import { lazy, Suspense, useEffect, useState } from 'react'

import { useContextMenuValue } from '~/atoms/context-menu'

const LazyContextMenuHandler = lazy(() => import('./context-menu-handler').then(m => ({ default: m.ContextMenuHandler })))

export const ContextMenuProvider: Component = ({ children }) => {
  const contextMenuState = useContextMenuValue()
  const [hasOpened, setHasOpened] = useState(contextMenuState.open)

  useEffect(() => {
    if (contextMenuState.open) {
      setHasOpened(true)
    }
  }, [contextMenuState.open])

  return (
    <>
      {children}
      {(hasOpened || contextMenuState.open) && (
        <Suspense fallback={null}>
          <LazyContextMenuHandler />
        </Suspense>
      )}
    </>
  )
}
