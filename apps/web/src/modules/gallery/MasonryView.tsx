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
      // masonic 的渲染带是 `[scrollTop − 0.5·h·k, scrollTop + h·k]`（`use-masonry.js:99,104`，
      // 源码注释：只向**上**过扫一半的量），k = overscanBy，h = 视口高度。注意是「下多上少」：
      //   k=2（默认）→ 上方 1h、下方 1h
      //   k=1.5      → 上方 0.75h、下方 0.5h（1440×900 下 450px）
      //   k=1        → 上方 0.5h、**下方 0**（渲染带终点正好压在视口底边）
      // 视口在顶部时下界被 `Math.max(0, …)` clamp 到 0，所以首屏实际是 [0, h·k]，
      // 也就是 k=2 首屏只有 2h 的量（不是 3h）。
      //
      // 1440×900 实测挂载数（`scripts/perf/compare-overscan.mjs`）：
      //   k=2 → 43 张   k=1.5 → 33 张（−23%）   k=1 → 24 张（−44%）
      // 390×844 实测：26 / 19 / 12。
      //
      // 取 1.5 而不是 1：k=1 下方零缓冲，任何向下位移都要「先挂 hidden batch 测尺寸、
      // 再 forceUpdate」两趟才补齐；k=1.5 的 450px 缓冲在 masonic 的 12 Hz 滚动节流下
      // （`Masonic.tsx` 的 `scrollFps`）能容忍约 5,400 px/s 的位移，桌面滚轮/触控板够用。
      // 移动端硬 fling 可能超过这个速度，**未实测**，按已知代价接受。
      //
      // 另注：本仓库的 `Masonic.tsx` 是 vendored 副本，没把 container offset 从 scrollTop
      // 里减掉（`useScroller` 被注释掉了），所以真实缓冲比上面的公式多约 50px（PageHeader
      // 是 fixed、不占流）。结论方向不变，只是实际更宽松一点。
      //
      // 真正该修的是下面这个 `itemHeightEstimate={400}`：真实 item 高度在 1440 下均值
      // 约 219px、中位数 185px（偏差 +83%），移动端偏差更大，导致文档高度虚高约 72%、
      // 滚到底时高度收缩而「跳」。那是既有问题，留给后续 PR。
      overscanBy={1.5}
      itemKey={useCallback((data, _index) => {
        return data.id
      }, [])}
    />
  )
}

const MasonryItem = memo(MasonryPhotoItem)
