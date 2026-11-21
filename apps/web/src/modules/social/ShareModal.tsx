import { Modal } from '@afilmory/ui'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { cloneElement, isValidElement, useCallback, useRef } from 'react'

import type { PhotoManifest } from '~/types/photo'

interface ShareModalTriggerProps {
  photo: PhotoManifest
  trigger: ReactNode
  blobSrc?: string
}

export const ShareModal = ({ photo, trigger, blobSrc }: ShareModalTriggerProps) => {
  const isOpeningRef = useRef(false)

  const handleOpen = useCallback(() => {
    if (isOpeningRef.current) {
      return
    }
    isOpeningRef.current = true
    void import('./ShareSheet')
      .then(({ ShareSheet }) => {
        Modal.present(ShareSheet, { photo, blobSrc }, { dismissOnOutsideClick: true })
      })
      .finally(() => {
        isOpeningRef.current = false
      })
  }, [blobSrc, photo])

  if (isValidElement(trigger)) {
    return cloneElement(trigger as ReactElement, {
      // @ts-expect-error - onClick is not a valid prop for the trigger element
      onClick: (event: MouseEvent<HTMLElement>) => {
        // @ts-expect-error - trigger is a valid React element
        trigger.props?.onClick?.(event)
        if (event.defaultPrevented) {
          return
        }
        handleOpen()
      },
    })
  }

  return (
    <button type="button" onClick={handleOpen} className="contents">
      {trigger}
    </button>
  )
}
