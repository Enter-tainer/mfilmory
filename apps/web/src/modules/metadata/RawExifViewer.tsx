import { Modal } from '@afilmory/ui'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PhotoManifest } from '~/types/photo'

interface RawExifViewerProps {
  currentPhoto: PhotoManifest
}

export const RawExifViewer: React.FC<RawExifViewerProps> = ({ currentPhoto }) => {
  const { t } = useTranslation()
  const [rawExifData, setRawExifData] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const modalIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (modalIdRef.current) {
      Modal.dismiss(modalIdRef.current)
      modalIdRef.current = null
    }
    setRawExifData(null)
    setIsLoading(false)
  }, [currentPhoto.id])

  const handleOpenModal = async () => {
    if (rawExifData) {
      const { RawExifSheet } = await import('./RawExifSheet')
      modalIdRef.current = Modal.present(RawExifSheet, { rawExifData })
      return
    }

    setIsLoading(true)
    try {
      const [response, { ExifToolManager }, { RawExifSheet }] = await Promise.all([
        fetch(currentPhoto.originalUrl),
        import('~/lib/exiftool'),
        import('./RawExifSheet'),
      ])
      const blob = await response.blob()
      const data = await ExifToolManager.parse(blob, currentPhoto.s3Key)
      const nextData = data || null

      setRawExifData(nextData)
      modalIdRef.current = Modal.present(RawExifSheet, { rawExifData: nextData })
    }
    catch (error) {
      console.error('Failed to parse EXIF data:', error)
      const { toast } = await import('sonner')
      toast.error(
        t('exif.raw.parse.error', {
          defaultValue: 'Failed to parse EXIF data',
        }),
      )
    }
    finally {
      setIsLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleOpenModal}
      disabled={isLoading}
      className="cursor-pointer text-white/70 duration-200 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isLoading ? <i className="i-mingcute-loading-3-line animate-spin" /> : <i className="i-mingcute-braces-line" />}
    </button>
  )
}
