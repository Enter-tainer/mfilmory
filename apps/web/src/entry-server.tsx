import type { PhotoManifestPayload } from '@afilmory/data'
import { photoLoader } from '@afilmory/data'
import en from '@locales/app/en.json'
import zhCN from '@locales/app/zh-CN.json'
import i18next from 'i18next'
import { renderToString } from 'react-dom/server'
import { initReactI18next } from 'react-i18next'
import type { RouteObject } from 'react-router'
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router'

import { defaultNS, ns } from './@types/constants'
import { i18nAtom } from './i18n'
import { jotaiStore } from './lib/jotai'
import { SSR_DEFAULT_LNG } from './lib/ssr'
import { createAppRoutes } from './router'

type LazyRouteObject = RouteObject & { lazy?: (() => Promise<Record<string, unknown>>) | unknown }

async function resolveAllLazyRoutes(routes: RouteObject[]): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      const lazyRoute = route as LazyRouteObject
      if (typeof lazyRoute.lazy === 'function') {
        const resolved = await lazyRoute.lazy()
        Object.assign(lazyRoute, resolved)
        delete lazyRoute.lazy
      }
      if (route.children && route.children.length > 0) {
        await resolveAllLazyRoutes(route.children)
      }
    }),
  )
}

function joinRoutePaths(basePath: string, segment: string | undefined): string {
  const cleanSegment = (segment ?? '').replaceAll(/^\/+|\/+$/g, '')
  if (!cleanSegment) {
    return basePath || '/'
  }
  const cleanBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  return `${cleanBase}/${cleanSegment}`
}

function collectDiscoveredRoutePaths(appRoutes: RouteObject[]): string[] {
  const discovered = new Set<string>()
  const rootWrapper = appRoutes.find(route => route.path === '/')
  const walk = (routes: RouteObject[], parentPath: string) => {
    for (const route of routes) {
      if (route.path === '*') {
        continue
      }
      const nextPath = route.index ? (parentPath || '/') : joinRoutePaths(parentPath, route.path)
      if (route.Component || route.element) {
        discovered.add(nextPath)
      }
      if (route.children && route.children.length > 0) {
        walk(route.children, nextPath)
      }
    }
  }
  walk(rootWrapper?.children ?? appRoutes, '/')
  return Array.from(discovered)
}

let handler: ReturnType<typeof createStaticHandler> | null = null
let discoveredRoutePaths: string[] = []
const ssrI18n = i18next.createInstance()
let i18nInitialized = false

export async function initSsrContext(manifest: PhotoManifestPayload): Promise<void> {
  photoLoader.init(manifest)
  if (!handler) {
    const appRoutes = createAppRoutes()
    await resolveAllLazyRoutes(appRoutes)
    discoveredRoutePaths = collectDiscoveredRoutePaths(appRoutes)
    handler = createStaticHandler(appRoutes)
  }
  if (!i18nInitialized) {
    await ssrI18n.use(initReactI18next).init({
      lng: SSR_DEFAULT_LNG,
      fallbackLng: {
        default: ['en'],
      },
      supportedLngs: ['zh-CN', 'en'],
      ns,
      defaultNS,
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
      resources: {
        'zh-CN': { [defaultNS]: zhCN },
        'en': { [defaultNS]: en },
      },
    })
    jotaiStore.set(i18nAtom, ssrI18n)
    i18nInitialized = true
  }
}

export function getDiscoveredRoutePaths(): string[] {
  if (!handler) {
    throw new Error('[entry-server] initSsrContext() must be called before getDiscoveredRoutePaths()')
  }
  return [...discoveredRoutePaths]
}

export async function renderRoute(urlPath: string): Promise<string> {
  if (!handler) {
    throw new Error('[entry-server] initSsrContext() must be called before renderRoute()')
  }
  const request = new Request(`https://ssg.local${urlPath}`)
  const context = await handler.query(request)
  if (context instanceof Response) {
    throw new TypeError(`Unexpected redirect/response (${context.status}) for ${urlPath}`)
  }
  const router = createStaticRouter(handler.dataRoutes, context)
  return renderToString(<StaticRouterProvider router={router} context={context} hydrate={false} />)
}
