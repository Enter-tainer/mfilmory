import { useEffect } from 'react'
import { Outlet } from 'react-router'

import { useCommandPaletteShortcut } from './hooks/useCommandPaletteShortcut'
import { CommandPalette } from './modules/cmdk/CommandPalette'
import { RootProviders } from './providers/root-providers'

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

// prefetch preview page route
function App() {
  useEffect(() => {
    // viewer 路由比首屏大得多（swiper / webgl-viewer / 全套 EXIF 面板，≈180 KB br）。
    // 以前它在 mount 时就抢着下载，正好和首屏缩略图争带宽；改成首屏稳定后的空闲时段预取，
    // 用户真的点开照片时依然是热的。
    const prefetchViewerRoute = () => {
      void import('~/pages/(main)/photos/[photoId]/index')
    }

    const idleWindow = window as IdleWindow
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(prefetchViewerRoute, { timeout: 5000 })
      return () => idleWindow.cancelIdleCallback?.(handle)
    }

    const timer = setTimeout(prefetchViewerRoute, 3000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <RootProviders>
      <div className="overflow-hidden lg:h-svh">
        <Outlet />
        <CommandPaletteContainer />
      </div>
    </RootProviders>
  )
}

const CommandPaletteContainer = () => {
  const { isOpen, setIsOpen } = useCommandPaletteShortcut()
  return <CommandPalette isOpen={isOpen} onClose={() => setIsOpen(false)} />
}
export default App
