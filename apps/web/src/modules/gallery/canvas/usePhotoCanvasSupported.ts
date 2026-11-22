import { isPhotoCanvasSupported } from '@afilmory/photo-canvas'
import { useEffect, useState } from 'react'

export const usePhotoCanvasSupported = () => {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(isPhotoCanvasSupported())
  }, [])

  return supported
}
