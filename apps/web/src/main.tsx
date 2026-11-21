import './styles/index.css'

import { photoLoader } from '@afilmory/data'
import { Suspense } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import type { RouteObject } from 'react-router'
import { matchRoutes } from 'react-router'
import { RouterProvider } from 'react-router/dom'

import { AppSkeleton } from './components/ui/app-skeleton'
import { initClientI18n } from './i18n'
import { SSR_DEFAULT_LNG } from './lib/ssr'
import { createAppRouter, createAppRoutes } from './router'

type ManifestPayload = Parameters<typeof photoLoader.init>[0]

const EMPTY_MANIFEST: ManifestPayload = { data: [], cameras: [], lenses: [] }

async function resolveManifest(): Promise<ManifestPayload> {
  // 开发模式（或显式 AFILMORY_EMBED_MANIFEST=true）下 manifest 仍然内联，直接可用
  const manifestUrl = window.__MANIFEST_URL__
  if (!manifestUrl) {
    return window.__MANIFEST__ ?? EMPTY_MANIFEST
  }

  try {
    // credentials: 'omit' 必须和 HTML 里 `as="fetch" crossorigin` 的 preload 对齐，
    // 否则浏览器会认为「preload 找到了但没被使用」，白白下载两次。
    const response = await fetch(manifestUrl, {
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return (await response.json()) as ManifestPayload
  }
  catch (error) {
    // 拿不到 manifest 时也要把壳子渲染出来（空画廊 + 控制台报错），而不是白屏
    console.error('[manifest] failed to load, rendering an empty gallery:', error)
    return EMPTY_MANIFEST
  }
}

async function resolveMatchedLazyRoutes(appRoutes: RouteObject[]) {
  const matches = matchRoutes(appRoutes, window.location)
  if (!matches) {
    return
  }
  await Promise.all(
    matches.map(async (match) => {
      const route = match.route as RouteObject & { lazy?: (() => Promise<Record<string, unknown>>) | unknown }
      if (typeof route.lazy !== 'function') {
        return
      }
      const resolved = await route.lazy()
      Object.assign(route, resolved)
      delete route.lazy
    }),
  )
}

const normalizePath = (pathname: string) => {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname)
    }
    catch {
      return pathname
    }
  })()
  return decoded.length > 1 ? decoded.replace(/\/+$/, '') : decoded
}

// 不要用 top-level await：那会让 rolldown 把整张模块图拆成一堆 async chunk
// （modulepreload 从 3 条涨到 10 条），反而拖慢首屏。这里的 bootstrap() 同步调用，
// 只是把「渲染」推迟到 manifest 与 i18n 到手之后。
void bootstrap()

async function bootstrap() {
  const rootEl = document.querySelector('#root')!
  const ssgRoute = rootEl.getAttribute('data-ssg-route')
  const currentRoute = normalizePath(window.location.pathname)
  const canHydrate = Boolean(
    ssgRoute
    && rootEl.childNodes.length > 0
    && normalizePath(ssgRoute) === currentRoute
    && !(currentRoute === '/' && window.location.search.length > 0),
  )

  const ssrLng = canHydrate ? (document.documentElement.dataset.ssrLng || SSR_DEFAULT_LNG) : undefined
  const appRoutes = createAppRoutes()

  if (!canHydrate && currentRoute.startsWith('/photos/')) {
    void import('~/pages/(main)/photos/[photoId]/index')
  }

  const [manifest] = await Promise.all([
    resolveManifest(),
    initClientI18n(ssrLng ? { ssrLng } : undefined),
    canHydrate ? resolveMatchedLazyRoutes(appRoutes) : Promise.resolve(),
  ])
  photoLoader.init(manifest)

  const router = createAppRouter(appRoutes)

  document.querySelector('#ssg-fallback-hide')?.remove()

  if (canHydrate) {
    hydrateRoot(rootEl, <RouterProvider router={router} />, {
      onRecoverableError(error) {
        console.error('[hydration]', error)
      },
    })
    return
  }

  createRoot(rootEl).render(
    <Suspense fallback={<AppSkeleton />}>
      <RouterProvider router={router} />
    </Suspense>,
  )
}
