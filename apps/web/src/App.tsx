import { useEffect } from 'react'
import { Outlet } from 'react-router'

import { useCommandPaletteShortcut } from './hooks/useCommandPaletteShortcut'
import { shouldSkipHeavyPrefetch } from './lib/network'
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
    //
    // 但「空闲」只保证主线程不忙，不保证带宽够：Lighthouse 的关键路径里
    // `_photoId_` chunk（186 KB）+ exiftool esm（42 KB）排在 2.4–2.9 s —— 慢网下它们就是
    // 在跟首屏缩略图抢流量、把 LCP 往后推。所以省流量模式 / 2G~3G 下干脆不预取：
    // 这类用户的瓶颈是字节数，让他在点开照片时再多等一次，好过首屏都慢。
    if (shouldSkipHeavyPrefetch()) return

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
