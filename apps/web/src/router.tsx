import type { RouteObject } from 'react-router'
import { createBrowserRouter } from 'react-router'

import App from './App'
import { ErrorElement } from './components/common/ErrorElement'
import { NotFound } from './components/common/NotFound'
import { AppSkeleton } from './components/ui/app-skeleton'
import { routes } from './generated-routes'

function cloneRoutes(items: RouteObject[]): RouteObject[] {
  return items.map((item) => {
    if (item.index) {
      return { ...item }
    }
    return {
      ...item,
      ...(item.children ? { children: cloneRoutes(item.children) } : {}),
    }
  })
}

export function createAppRoutes(): RouteObject[] {
  return [
    {
      path: '/',
      element: <App />,
      children: cloneRoutes(routes),
      errorElement: <ErrorElement />,
      hydrateFallbackElement: <AppSkeleton />,
    },
    {
      path: '*',
      element: <NotFound />,
    },
  ]
}

export function createAppRouter(appRoutes: RouteObject[]) {
  return createBrowserRouter(appRoutes)
}
