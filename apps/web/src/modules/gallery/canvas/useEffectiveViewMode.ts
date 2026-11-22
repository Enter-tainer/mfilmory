import { useAtomValue } from 'jotai'

import { gallerySettingAtom } from '~/atoms/app'
import { useMobile } from '~/hooks/useMobile'

import { resolveViewMode } from './url-state'
import { usePhotoCanvasSupported } from './usePhotoCanvasSupported'

export const useEffectiveViewMode = () => {
  const { viewMode } = useAtomValue(gallerySettingAtom)
  const supported = usePhotoCanvasSupported()
  const isMobile = useMobile()
  return resolveViewMode({ requested: viewMode, supported, isLargeScreen: !isMobile })
}
