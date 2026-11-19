import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@afilmory/ui'
import { useAtom, useSetAtom } from 'jotai'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { gallerySettingAtom, isCommandPaletteOpenAtom } from '~/atoms/app'
import { siteConfig } from '~/config'
import { useMobile } from '~/hooks/useMobile'

import { ViewPanel } from '../panels/ViewPanel'
import { LanguageSwitcher } from './LanguageSwitcher'
import { ActionIconButton, resolveSocialUrl } from './utils'

const MobileViewDrawer = lazy(() => import('./MobileViewDrawer').then(m => ({ default: m.MobileViewDrawer })))

export const PageHeaderRight = () => {
  const { t } = useTranslation()
  const isMobile = useMobile()
  const [gallerySetting] = useAtom(gallerySettingAtom)
  const setCommandPaletteOpen = useSetAtom(isCommandPaletteOpenAtom)
  const navigate = useNavigate()

  // 计算视图设置是否有自定义配置
  const hasViewCustomization = gallerySetting.columns !== 'auto' || gallerySetting.sortOrder !== 'desc'

  // 计算过滤器数量
  const filterCount
    = gallerySetting.selectedTags.length
      + gallerySetting.selectedCameras.length
      + gallerySetting.selectedLenses.length
      + (gallerySetting.selectedRatings !== null ? 1 : 0)

  return (
    <div className="flex items-center gap-1 lg:gap-1.5">
      {/* Action Buttons */}
      <div className="bg-material-medium/40 flex items-center gap-1 rounded-lg">
        <ActionIconButton
          icon="i-mingcute-search-line"
          title={t('action.search.unified.title')}
          onClick={() => setCommandPaletteOpen(true)}
          badge={filterCount}
        />

        {/* Desktop only: Map Link */}
        {!isMobile && (
          <ActionIconButton
            icon="i-mingcute-map-pin-line"
            title={t('action.map.explore')}
            onClick={() => navigate('/map')}
          />
        )}

        {isMobile ? (
          <MobileViewButton
            icon="i-mingcute-layout-grid-line"
            title={t('action.view.title')}
            badge={hasViewCustomization ? '●' : undefined}
          >
            <ViewPanel />
          </MobileViewButton>
        ) : (
          <DesktopViewButton
            icon="i-mingcute-layout-grid-line"
            title={t('action.view.title')}
            badge={hasViewCustomization ? '●' : undefined}
          >
            <ViewPanel />
          </DesktopViewButton>
        )}

        <LanguageSwitcher />

        {isMobile && <MoreActionMenu />}
      </div>
    </div>
  )
}

const MoreActionMenu = () => {
  const { t } = useTranslation()
  const [settings, setSettings] = useAtom(gallerySettingAtom)

  const githubUrl
    = siteConfig.social && siteConfig.social.github
      ? resolveSocialUrl(siteConfig.social.github, { baseUrl: 'https://github.com/' })
      : undefined
  const twitterUrl
    = siteConfig.social && siteConfig.social.twitter
      ? resolveSocialUrl(siteConfig.social.twitter, { baseUrl: 'https://twitter.com/', stripAt: true })
      : undefined
  const hasRss = true

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex size-7 items-center justify-center rounded text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:hidden"
          aria-label="More options"
        >
          <i className="i-mingcute-more-2-line text-lg" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <div className="px-2 py-1.5 text-xs font-medium text-white/50">{t('action.view.title')}</div>
        <DropdownMenuItem
          onClick={() => setSettings(prev => ({ ...prev, viewMode: 'masonry' }))}
          className="justify-between"
        >
          <span className="flex items-center gap-2">
            <i className="i-mingcute-grid-line text-base" />
            {t('gallery.view.masonry')}
          </span>
          {settings.viewMode === 'masonry' && <i className="i-mingcute-check-line text-base" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setSettings(prev => ({ ...prev, viewMode: 'list' }))}
          className="justify-between"
        >
          <span className="flex items-center gap-2">
            <i className="i-mingcute-list-ordered-line text-base" />
            {t('gallery.view.list')}
          </span>
          {settings.viewMode === 'list' && <i className="i-mingcute-check-line text-base" />}
        </DropdownMenuItem>

        {(githubUrl || twitterUrl || hasRss) && <DropdownMenuSeparator />}

        {githubUrl && (
          <DropdownMenuItem asChild>
            <a href={githubUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
              <i className="i-mingcute-github-fill text-base" />
              GitHub
            </a>
          </DropdownMenuItem>
        )}
        {twitterUrl && (
          <DropdownMenuItem asChild>
            <a href={twitterUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
              <i className="i-mingcute-twitter-fill text-base" />
              Twitter
            </a>
          </DropdownMenuItem>
        )}
        {hasRss && (
          <DropdownMenuItem asChild>
            <a href="/feed.xml" target="_blank" rel="noreferrer" className="flex items-center gap-2">
              <i className="i-mingcute-rss-2-fill text-base" />
              RSS
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 紧凑版本的桌面端视图按钮
const DesktopViewButton = ({
  icon,
  title,
  badge,
  children,
}: {
  icon: string
  title: string
  badge?: number | string
  children: React.ReactNode
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex size-7 items-center justify-center rounded-full text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:size-8"
          title={title}
          aria-label={title}
        >
          <i className={`${icon} text-sm lg:text-base`} aria-hidden="true" />
          {badge && (
            <span className="absolute -top-0.5 -right-0.5 flex size-2 items-center justify-center rounded-full bg-blue-500 lg:size-2.5">
              <span className="sr-only">{badge}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

// 紧凑版本的移动端视图按钮
const MobileViewButton = ({
  icon,
  title,
  badge,
  children,
}: {
  icon: string
  title: string
  badge?: number | string
  children: React.ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setHasOpened(true)
    }
    setOpen(nextOpen)
  }

  return (
    <>
      <button
        type="button"
        className="relative flex size-7 items-center justify-center rounded text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:size-8"
        title={title}
        aria-label={title}
        onClick={() => handleOpenChange(!open)}
      >
        <i className={`${icon} text-sm lg:text-base`} aria-hidden="true" />
        {badge && (
          <span className="absolute -top-0.5 -right-0.5 flex size-2 items-center justify-center rounded-full bg-blue-500 lg:size-2.5">
            <span className="sr-only">{badge}</span>
          </span>
        )}
      </button>
      {(hasOpened || open) && (
        <Suspense fallback={null}>
          <MobileViewDrawer open={open} onOpenChange={handleOpenChange}>
            {children}
          </MobileViewDrawer>
        </Suspense>
      )}
    </>
  )
}
