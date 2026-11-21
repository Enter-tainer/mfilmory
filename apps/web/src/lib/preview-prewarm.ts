const MAX_TRACKED_URLS = 200
const MAX_LOW_CONCURRENCY = 2
const MAX_PENDING_LOW_QUEUE = 6

const loadedUrls = new Set<string>()
const inflightImages = new Map<string, HTMLImageElement>()
const pendingLowQueue: string[] = []
let activeLowCount = 0
let viewerRoutePrewarmPromise: Promise<unknown> | null = null

function rememberLoadedUrl(url: string): void {
  if (loadedUrls.has(url)) {
    return
  }
  if (loadedUrls.size >= MAX_TRACKED_URLS) {
    const oldest = loadedUrls.values().next().value
    if (oldest !== undefined) {
      loadedUrls.delete(oldest)
    }
  }
  loadedUrls.add(url)
}

function canonicalizeUrl(url: string): string {
  if (typeof window === 'undefined') {
    return url
  }
  try {
    return new URL(url, window.location.href).href
  }
  catch {
    return url
  }
}

export function isPreviewImageLoaded(url: string | null | undefined): boolean {
  if (!url) {
    return false
  }
  return loadedUrls.has(url) || loadedUrls.has(canonicalizeUrl(url))
}

export function markPreviewImageLoaded(url: string | null | undefined): void {
  if (!url) {
    return
  }
  rememberLoadedUrl(url)
  rememberLoadedUrl(canonicalizeUrl(url))
}

function pumpLowQueue(): void {
  while (activeLowCount < MAX_LOW_CONCURRENCY && pendingLowQueue.length > 0) {
    const nextUrl = pendingLowQueue.shift()!
    if (loadedUrls.has(nextUrl) || inflightImages.has(nextUrl)) {
      continue
    }
    startImageFetch(nextUrl, 'low')
  }
}

function startImageFetch(canonicalUrl: string, priority: 'high' | 'low'): void {
  if (typeof Image === 'undefined') {
    return
  }
  if (loadedUrls.has(canonicalUrl) || inflightImages.has(canonicalUrl)) {
    return
  }

  const img = new Image()
  img.decoding = 'async'
  if ('fetchPriority' in img) {
    ;(img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = priority
  }

  if (priority === 'low') {
    activeLowCount++
  }

  let settled = false
  const finalize = (didLoad: boolean) => {
    if (settled) {
      return
    }
    settled = true
    inflightImages.delete(canonicalUrl)
    if (priority === 'low') {
      activeLowCount = Math.max(0, activeLowCount - 1)
      pumpLowQueue()
    }
    if (didLoad) {
      rememberLoadedUrl(canonicalUrl)
    }
  }

  img.onload = () => finalize(true)
  img.onerror = () => finalize(false)

  inflightImages.set(canonicalUrl, img)
  img.src = canonicalUrl

  if (img.complete && img.naturalWidth > 0) {
    finalize(true)
  }
}

export function prewarmPreviewImage(
  url: string | null | undefined,
  options?: { priority?: 'high' | 'low' },
): void {
  if (typeof window === 'undefined' || !url) {
    return
  }
  const canonicalUrl = canonicalizeUrl(url)
  if (loadedUrls.has(canonicalUrl) || inflightImages.has(canonicalUrl)) {
    return
  }

  const priority = options?.priority ?? 'low'
  if (priority === 'high') {
    const queuedIdx = pendingLowQueue.indexOf(canonicalUrl)
    if (queuedIdx !== -1) {
      pendingLowQueue.splice(queuedIdx, 1)
    }
    startImageFetch(canonicalUrl, 'high')
    return
  }

  if (activeLowCount < MAX_LOW_CONCURRENCY) {
    startImageFetch(canonicalUrl, 'low')
    return
  }

  if (!pendingLowQueue.includes(canonicalUrl)) {
    if (pendingLowQueue.length >= MAX_PENDING_LOW_QUEUE) {
      pendingLowQueue.shift()
    }
    pendingLowQueue.push(canonicalUrl)
  }
}

export function prewarmViewerRoute(): void {
  if (typeof window === 'undefined') {
    return
  }
  if (!viewerRoutePrewarmPromise) {
    viewerRoutePrewarmPromise = import('~/pages/(main)/photos/[photoId]/index').catch(() => {
      viewerRoutePrewarmPromise = null
    })
  }
}
