import { ModalContainer, Toaster } from '@afilmory/ui'
import { Spring } from '@afilmory/utils'
import { Provider } from 'jotai'
import { domMax, LazyMotion, MotionConfig } from 'motion/react'
import type { FC, PropsWithChildren } from 'react'

import { HydrationEndDetector } from '~/components/common/HydrationEndDetector'
import { jotaiStore } from '~/lib/jotai'

import { ContextMenuProvider } from './context-menu-provider'
import { EventProvider } from './event-provider'
import { I18nProvider } from './i18n-provider'
import { StableRouterProvider } from './stable-router-provider'

export const RootProviders: FC<PropsWithChildren> = ({ children }) => {
  return (
    <LazyMotion features={domMax} strict key="framer">
      <MotionConfig transition={Spring.presets.smooth} reducedMotion="user">
        <Provider store={jotaiStore}>
          <EventProvider />
          <StableRouterProvider />
          <HydrationEndDetector />

          <ContextMenuProvider />
          <I18nProvider>{children}</I18nProvider>
          <ModalContainer />
        </Provider>
      </MotionConfig>
      <Toaster />
    </LazyMotion>
  )
}
