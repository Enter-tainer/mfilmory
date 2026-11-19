import { isCommandPaletteOpenAtom } from '~/atoms/app'
import { jotaiStore } from '~/lib/jotai'

export type SsgPendingAction
  = | { type: 'photo', id: string }
    | { type: 'cmdk' }
    | { type: 'map' }

declare global {
  interface Window {
    __SSG_PENDING_ACTION__?: SsgPendingAction
  }
}

let isDismissed = false
let isPendingWait = false
let forceFinalizeNow: (() => void) | null = null

export interface DismissSsgShellOptions {
  waitImages?: boolean
  scrollElement?: HTMLElement | null
  onDismiss?: () => void
}

function resolveScrollTarget(provided?: HTMLElement | null): HTMLElement | null {
  if (provided) {
    return provided
  }
  if (typeof window !== 'undefined' && window.innerWidth < 1024) {
    return document.body
  }
  return document.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? document.body
}

function waitImageReady(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) {
    return typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {}).finally(resolve)
      }
      else {
        resolve()
      }
    }
    img.addEventListener('load', done, { once: true })
    img.addEventListener('error', () => resolve(), { once: true })
  })
}

export function dismissSsgShell(options?: DismissSsgShellOptions): void {
  const shell = typeof document !== 'undefined' ? document.querySelector('#ssg-shell') : null
  if (isDismissed || !shell) {
    isDismissed = true
    options?.onDismiss?.()
    return
  }

  const finalize = () => {
    if (isDismissed) {
      return
    }
    isDismissed = true
    isPendingWait = false
    forceFinalizeNow = null

    const ssgScroll = document.querySelector<HTMLElement>('#ssg-scroll')
    const savedScrollTop = ssgScroll?.scrollTop ?? 0
    if (savedScrollTop > 0) {
      const target = resolveScrollTarget(options?.scrollElement)
      if (target) {
        target.scrollTop = savedScrollTop
      }
    }

    document.querySelector('#ssg-shell')?.remove()
    document.querySelector('#ssg-style')?.remove()
    options?.onDismiss?.()
  }

  if (!options?.waitImages) {
    finalize()
    return
  }

  if (isPendingWait) {
    return
  }

  const ssgCount = document.querySelectorAll('#ssg-shell [data-ssg-photo]').length
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('#root [role="gridcell"] img'))
    .filter((img) => {
      const cell = img.closest('[role="gridcell"]') as HTMLElement | null
      return cell && cell.style.visibility !== 'hidden'
    })
    .slice(0, Math.max(8, ssgCount))

  if (imgs.length === 0) {
    finalize()
    return
  }

  isPendingWait = true
  forceFinalizeNow = finalize

  const timeout = new Promise<void>(resolve => setTimeout(resolve, 150))
  void Promise.race([Promise.all(imgs.map(waitImageReady)), timeout]).then(() => {
    if (isDismissed) {
      return
    }
    requestAnimationFrame(() => {
      forceFinalizeNow?.()
    })
  })
}

export function replaySsgPendingAction(navigate: (to: string) => void): void {
  if (typeof window === 'undefined') {
    return
  }
  const action = window.__SSG_PENDING_ACTION__
  if (!action) {
    return
  }
  delete window.__SSG_PENDING_ACTION__

  if (action.type === 'photo') {
    navigate(`/photos/${encodeURIComponent(action.id)}`)
  }
  else if (action.type === 'map') {
    navigate('/map')
  }
  else if (action.type === 'cmdk') {
    jotaiStore.set(isCommandPaletteOpenAtom, true)
  }
}
