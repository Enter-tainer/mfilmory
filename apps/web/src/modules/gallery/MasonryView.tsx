import { useAtomValue } from 'jotai'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { gallerySettingAtom } from '~/atoms/app'
import { useMobile } from '~/hooks/useMobile'
import type { PhotoManifest } from '~/types/photo'

import type { MasonryRef } from './Masonic'
import { Masonry } from './Masonic'
import { MasonryPhotoItem } from './MasonryPhotoItem'

const COLUMN_WIDTH_CONFIG = {
  auto: {
    mobile: 150,
    desktop: 250,
    maxColumns: 8,
  },
  min: {
    mobile: 120,
    desktop: 200,
  },
  max: {
    mobile: 250,
    desktop: 500,
  },
}

interface MasonryViewProps {
  photos: PhotoManifest[]
  onRender?: (startIndex: number, stopIndex: number, items: any[]) => void
}

export const MasonryView = ({ photos, onRender }: MasonryViewProps) => {
  const { columns } = useAtomValue(gallerySettingAtom)
  const [containerWidth, setContainerWidth] = useState(0)
  const masonryRef = useRef<MasonryRef>(null)
  const isMobile = useMobile()

  // 监听容器宽度变化
  useEffect(() => {
    const updateContainerWidth = () => {
      setContainerWidth(window.innerWidth)
    }

    updateContainerWidth()
    window.addEventListener('resize', updateContainerWidth)

    return () => {
      window.removeEventListener('resize', updateContainerWidth)
    }
  }, [])

  // 动态计算列宽
  const columnWidth = useMemo(() => {
    const { auto, min, max } = COLUMN_WIDTH_CONFIG
    const gutter = 4 // 列间距
    const availableWidth = containerWidth - (isMobile ? 8 : 32) // 移动端和桌面端的 padding 不同

    if (columns === 'auto') {
      const autoWidth = isMobile ? auto.mobile : auto.desktop
      if (!isMobile) {
        const { maxColumns } = auto
        // 当屏幕宽度超过一定阈值时，通过计算动态列宽来限制最大列数
        const colCount = Math.floor((availableWidth + gutter) / (autoWidth + gutter))

        if (colCount > maxColumns) {
          return (availableWidth - (maxColumns - 1) * gutter) / maxColumns
        }
      }

      return autoWidth
    }

    // 自定义列数模式：根据容器宽度和列数计算列宽
    const calculatedWidth = (availableWidth - (columns - 1) * gutter) / columns

    // 根据设备类型设置最小和最大列宽
    const minWidth = isMobile ? min.mobile : min.desktop
    const maxWidth = isMobile ? max.mobile : max.desktop

    return Math.max(Math.min(calculatedWidth, maxWidth), minWidth)
  }, [isMobile, columns, containerWidth])

  return (
    <Masonry<PhotoManifest>
      ref={masonryRef}
      items={photos}
      render={useCallback(
        (props) => (
          <MasonryItem {...props} />
        ),
        [],
      )}
      onRender={onRender}
      columnWidth={columnWidth}
      columnGutter={4}
      rowGutter={4}
      itemHeightEstimate={400}
      // masonic 默认渲染「视口高度 ×2」的额外内容，1440×900 下会一次性挂载 ~43 个
      // MasonryPhotoItem，也就是首屏就发出 43 个缩略图请求（≈756 KB）。
      // 缩到 1 倍：仍有一整屏的预渲染缓冲，但首屏图片请求减半。
      overscanBy={1}
      itemKey={useCallback((data, _index) => {
        return data.id
      }, [])}
    />
  )
}

const MasonryItem = memo(MasonryPhotoItem)
