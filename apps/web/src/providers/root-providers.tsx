import { ModalContainer } from '@afilmory/ui'
import { Spring } from '@afilmory/utils'
import { Provider } from 'jotai'
import { LazyMotion, MotionConfig } from 'motion/react'
import type { FC, PropsWithChildren } from 'react'

import { HydrationEndDetector } from '~/components/common/HydrationEndDetector'
import { jotaiStore } from '~/lib/jotai'

import { ContextMenuProvider } from './context-menu-provider'
import { DeferredToaster } from './deferred-toaster'
import { EventProvider } from './event-provider'
import { I18nProvider } from './i18n-provider'
import { StableRouterProvider } from './stable-router-provider'

const loadMotionFeatures = () => import('~/lib/motion-features').then(m => m.default)

export const RootProviders: FC<PropsWithChildren> = ({ children }) => {
  return (
    <LazyMotion features={loadMotionFeatures} strict key="framer">
      <MotionConfig transition={Spring.presets.smooth} reducedMotion="user">
        <Provider store={jotaiStore}>
          <EventProvider />
          <StableRouterProvider />
          <HydrationEndDetector />

          <ContextMenuProvider />
          <I18nProvider>{children}</I18nProvider>
          <ModalContainer />
          <DeferredToaster />
        </Provider>
      </MotionConfig>
    </LazyMotion>
  )
}
