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
import App from './App'
import { ErrorElement } from './components/common/ErrorElement'
import { NotFound } from './components/common/NotFound'
import { i18nAtom } from './i18n'
import { jotaiStore } from './lib/jotai'
import { SSR_DEFAULT_LNG } from './lib/ssr'
import * as ManifestRoute from './pages/(data)/manifest'
import * as MainLayout from './pages/(main)/layout.sync'
import * as PhotoDetailRoute from './pages/(main)/photos/[photoId]/index'
import * as MapRoute from './pages/map/index'

const serverRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    errorElement: <ErrorElement />,
    children: [
      {
        path: 'map',
        children: [
          {
            path: '',
            Component: MapRoute.Component,
          },
        ],
      },
      {
        path: '',
        Component: MainLayout.Component,
        children: [
          {
            path: 'photos',
            children: [
              {
                path: ':photoId',
                children: [
                  {
                    path: '',
                    Component: PhotoDetailRoute.Component,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: '',
        children: [
          {
            path: 'manifest',
            Component: ManifestRoute.Component,
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <NotFound />,
  },
]

const handler = createStaticHandler(serverRoutes)
const ssrI18n = i18next.createInstance()
let i18nInitialized = false

export async function initSsrContext(manifest: PhotoManifestPayload): Promise<void> {
  photoLoader.init(manifest)
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

export async function renderRoute(urlPath: string): Promise<string> {
  const request = new Request(`https://ssg.local${urlPath}`)
  const context = await handler.query(request)
  if (context instanceof Response) {
    throw new TypeError(`Unexpected redirect/response (${context.status}) for ${urlPath}`)
  }
  const router = createStaticRouter(handler.dataRoutes, context)
  return renderToString(<StaticRouterProvider router={router} context={context} hydrate={false} />)
}
