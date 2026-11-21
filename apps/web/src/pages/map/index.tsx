import { lazy, Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'

import { useIsClient } from '~/lib/ssr'

const MapSection = lazy(() => import('~/modules/map/MapSection').then(m => ({ default: m.MapSection })))

export const Component = () => {
  const isClient = useIsClient()
  if (!isClient) {
    return <ExploryPageSkeleton />
  }

  return (
    <Suspense fallback={<ExploryPageSkeleton />}>
      <ErrorBoundary fallback={<ExploryPageError />}>
        <MapSection />
      </ErrorBoundary>
    </Suspense>
  )
}

const ExploryPageSkeleton = () => {
  const { t } = useTranslation()

  return (
    <div className="bg-background relative flex h-svh w-full items-center justify-center overflow-hidden">
      <a
        href="/"
        aria-label={t('explory.back.to.gallery')}
        title={t('explory.back.to.gallery')}
        className="bg-material-medium border-accent/20 text-text hover:bg-material-thick focus-visible:outline-accent absolute top-4 left-4 z-30 flex size-8 items-center justify-center rounded-full border backdrop-blur-2xl transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <i className="i-mingcute-arrow-left-line text-base" aria-hidden="true" />
      </a>

      <div className="bg-material-medium border-accent/20 absolute top-4 right-4 z-30 hidden w-64 rounded-2xl border p-4 backdrop-blur-2xl sm:block">
        <div className="flex items-center gap-3">
          <div className="bg-accent/10 border-accent/20 flex size-10 shrink-0 items-center justify-center rounded-xl border">
            <i className="i-mingcute-map-line text-accent text-lg" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-text text-sm font-semibold tracking-tight">{t('explory.explore.map')}</div>
            <div className="bg-fill-tertiary mt-2 h-4 w-28 animate-pulse rounded-full" />
          </div>
        </div>
      </div>

      <div className="bg-material-medium border-accent/20 flex flex-col items-center rounded-2xl border px-6 py-5 text-center backdrop-blur-2xl">
        <div className="bg-accent/10 border-accent/20 mb-3 flex size-11 items-center justify-center rounded-xl border">
          <i className="i-mingcute-map-line text-accent text-xl" aria-hidden="true" />
        </div>
        <div className="text-text text-base font-medium">{t('explory.loading.map')}</div>
        <p className="text-text-secondary mt-1 text-xs">{t('explory.parsing.location')}</p>
        <noscript>
          <a href="/" className="text-accent mt-3 inline-block text-xs underline underline-offset-4">
            {t('explory.back.to.gallery')}
          </a>
        </noscript>
      </div>
    </div>
  )
}

const ExploryPageError = () => {
  const { t } = useTranslation()

  return (
    <div className="bg-background relative flex h-svh w-full items-center justify-center">
      <a
        href="/"
        aria-label={t('explory.back.to.gallery')}
        title={t('explory.back.to.gallery')}
        className="bg-material-medium border-accent/20 text-text hover:bg-material-thick focus-visible:outline-accent absolute top-4 left-4 z-30 flex size-8 items-center justify-center rounded-full border backdrop-blur-2xl transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <i className="i-mingcute-arrow-left-line text-base" aria-hidden="true" />
      </a>

      <div className="bg-material-medium border-accent/20 flex flex-col items-center rounded-2xl border px-6 py-5 text-center backdrop-blur-2xl">
        <div className="bg-fill-tertiary border-accent/20 mb-3 flex size-11 items-center justify-center rounded-xl border">
          <i className="i-mingcute-close-circle-line text-text text-xl" aria-hidden="true" />
        </div>
        <div className="text-text text-base font-medium">{t('explory.map.error.title')}</div>
        <p className="text-text-secondary mt-1 text-xs">{t('explory.map.error.description')}</p>
      </div>
    </div>
  )
}
