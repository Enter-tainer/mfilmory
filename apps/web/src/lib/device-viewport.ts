export const isSafari
  = typeof navigator !== 'undefined' && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)

export const isMobileDevice = (() => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false
  }
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    // 现代检测方式：支持触摸且屏幕较小
    || 'ontouchstart' in window
  )
})()
