import { useAtomValue } from 'jotai'
import { AnimatePresence } from 'motion/react'
import { lazy, Suspense, useEffect, useState } from 'react'

import { modalItemsAtom } from './ModalManager'
import { modalStore } from './store'

const LazyModalWrapper = lazy(() => import('./ModalWrapper').then(m => ({ default: m.ModalWrapper })))

export function ModalContainer() {
  const items = useAtomValue(modalItemsAtom, { store: modalStore })
  const [hasOpened, setHasOpened] = useState(items.length > 0)

  useEffect(() => {
    if (items.length > 0) {
      setHasOpened(true)
    }
  }, [items.length])

  return (
    <div id="global-modal-container">
      {(hasOpened || items.length > 0) && (
        <Suspense fallback={null}>
          <AnimatePresence initial={false}>
            {items.map(item => (
              <LazyModalWrapper key={item.id} item={item} />
            ))}
          </AnimatePresence>
        </Suspense>
      )}
    </div>
  )
}
