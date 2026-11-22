let cached: boolean | null = null

export const isPhotoCanvasSupported = () => {
  if (cached !== null) {
    return cached
  }
  if (typeof document === 'undefined') {
    return false
  }
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    if (!context) {
      return false
    }
    context.getExtension('WEBGL_lose_context')?.loseContext()
    cached = true
  }
  catch {
    return false
  }
  return true
}
