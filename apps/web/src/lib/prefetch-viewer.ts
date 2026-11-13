/**
 * viewer 路由（swiper / webgl-viewer / 全套 EXIF 面板，≈190 KB br）的预取调度。
 *
 * 这个 chunk 比首屏缩略图加起来还大，什么时候取决定了它是不是在抢带宽：
 *
 *   - 以前：`App` mount 时立刻取 → 和 20 张缩略图同时起步
 *   - 现在：要么「用户有明确意图」（hover / focus / pointerdown 到某张照片），
 *     要么「页面已经 load 完并且浏览器空闲」，两者先到先得
 *
 * 模块级 promise 保证只会请求一次；HTTP 缓存也会兜住重复调用。
 */
let prefetchPromise: Promise<unknown> | null = null
let scrollTriggerInstalled = false

function startPrefetch(): Promise<unknown> {
  prefetchPromise ??= import('~/pages/(main)/photos/[photoId]/index').catch((error) => {
    // 预取失败不该影响任何用户路径：真正的导航会重新 import 一次并正常报错
    console.warn('[prefetch] viewer route failed to prefetch', error)
    prefetchPromise = null
  })
  return prefetchPromise
}

/** 有明确打开意图（hover / focus 照片）时调用 */
export const prefetchViewerRouteNow = () => {
  void startPrefetch()
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/**
 * 兜底预取：等 `load`（首屏图片都已就绪）之后，再在空闲时段取一次。
 * 只安装一次，滚动/交互不会重复挂监听。
 */
export const scheduleViewerRoutePrefetch = () => {
  if (prefetchPromise || scrollTriggerInstalled) {
    return () => {}
  }
  scrollTriggerInstalled = true

  let cancelled = false
  let idleHandle: number | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const fire = () => {
    if (cancelled) {
      return
    }
    cancelled = true
    startPrefetch()
  }

  const afterLoad = () => {
    if (cancelled) {
      return
    }
    const idleWindow = window as IdleWindow
    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(fire, { timeout: 4000 })
    }
    else {
      timeoutHandle = setTimeout(fire, 1500)
    }
  }

  if (document.readyState === 'complete') {
    afterLoad()
  }
  else {
    window.addEventListener('load', afterLoad, { once: true })
  }

  return () => {
    cancelled = true
    window.removeEventListener('load', afterLoad)
    const idleWindow = window as IdleWindow
    if (idleHandle !== undefined) {
      idleWindow.cancelIdleCallback?.(idleHandle)
    }
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    scrollTriggerInstalled = false
  }
}
