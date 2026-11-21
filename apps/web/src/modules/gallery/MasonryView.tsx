import { useAtomValue } from 'jotai'
import type { RenderComponentProps } from 'masonic'
import type { CSSProperties } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { gallerySettingAtom } from '~/atoms/app'
import { useMobile } from '~/hooks/useMobile'
import { useIsClient } from '~/lib/ssr'
import type { PhotoManifest } from '~/types/photo'

import type { MasonryRef } from './Masonic'
import { Masonry } from './Masonic'
import { MasonryPhotoItem } from './MasonryPhotoItem'

const SSR_GRID_PHOTO_COUNT = 36
const SSR_EAGER_IMAGE_COUNT = 4
const MASONRY_GUTTER = 4

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
  const isClient = useIsClient()
  const { columns } = useAtomValue(gallerySettingAtom)
  const [containerWidth, setContainerWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  const masonryRef = useRef<MasonryRef>(null)
  const isMobile = useMobile()

  // 监听容器宽度变化
  useEffect(() => {
    const updateContainerWidth = () => {
      setContainerWidth(window.innerWidth)
    }

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

  const renderMasonryItem = useCallback(
    (props: RenderComponentProps<PhotoManifest>) => <MasonryItem {...props} />,
    [],
  )
  const getItemKey = useCallback((data: PhotoManifest) => data.id, [])

  if (!isClient) {
    return <SsrPhotoGrid photos={photos.slice(0, SSR_GRID_PHOTO_COUNT)} />
  }

  return (
    <Masonry<PhotoManifest>
      ref={masonryRef}
      items={photos}
      render={renderMasonryItem}
      onRender={onRender}
      columnWidth={columnWidth}
      maxColumnCount={columns === 'auto' && !isMobile ? COLUMN_WIDTH_CONFIG.auto.maxColumns : undefined}
      columnGutter={MASONRY_GUTTER}
      rowGutter={MASONRY_GUTTER}
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
      itemKey={getItemKey}
    />
  )
}

const MasonryItem = memo(MasonryPhotoItem)

interface SsrBandPlacement {
  items: Array<{ col: number, s: number, r: number }>
  maxS: number
  maxR: number
}

// 对应 masonic getColumns(W, columnWidth, 4) 的真实切列断点：
// 移动端 (<1024px) W = vw - 8, columnWidth = 150 -> cols 1..6；
// 桌面端 (>=1024px) W = vw, columnWidth = 250, maxColumns = 8 -> cols 4..8。
const SSR_BANDS: ReadonlyArray<{ cols: number, repW: number, media: string }> = [
  { cols: 1, repW: 280, media: '(max-width:311.98px)' },
  { cols: 2, repW: 382, media: '(min-width:312px) and (max-width:465.98px)' },
  { cols: 3, repW: 530, media: '(min-width:466px) and (max-width:619.98px)' },
  { cols: 4, repW: 690, media: '(min-width:620px) and (max-width:773.98px)' },
  { cols: 5, repW: 840, media: '(min-width:774px) and (max-width:927.98px)' },
  { cols: 6, repW: 960, media: '(min-width:928px) and (max-width:1023.98px)' },
  { cols: 4, repW: 1140, media: '(min-width:1024px) and (max-width:1265.98px)' },
  { cols: 5, repW: 1400, media: '(min-width:1266px) and (max-width:1519.98px)' },
  { cols: 6, repW: 1640, media: '(min-width:1520px) and (max-width:1773.98px)' },
  { cols: 7, repW: 1920, media: '(min-width:1774px) and (max-width:2027.98px)' },
  { cols: 8, repW: 2560, media: '(min-width:2028px)' },
]

function computeMasonicPlacement(photos: PhotoManifest[], cols: number, repW: number): SsrBandPlacement {
  const colW = Math.floor((repW - MASONRY_GUTTER * (cols - 1)) / cols)
  const heights = Array.from<number>({ length: cols }).fill(0)
  const sArr = Array.from<number>({ length: cols }).fill(0)
  const rArr = Array.from<number>({ length: cols }).fill(0)
  const items: Array<{ col: number, s: number, r: number }> = []

  for (const photo of photos) {
    let targetCol = 0
    for (let c = 1; c < cols; c += 1) {
      if (heights[c] < heights[targetCol]) {
        targetCol = c
      }
    }
    const ar = photo.aspectRatio > 0 ? photo.aspectRatio : 1
    const invAr = 1 / ar
    items.push({ col: targetCol, s: sArr[targetCol], r: rArr[targetCol] })
    sArr[targetCol] += invAr
    rArr[targetCol] += 1
    heights[targetCol] += Math.round(colW * invAr) + MASONRY_GUTTER
  }

  let tallestCol = 0
  for (let c = 1; c < cols; c += 1) {
    if (heights[c] > heights[tallestCol]) {
      tallestCol = c
    }
  }
  return {
    items,
    maxS: sArr[tallestCol],
    maxR: rArr[tallestCol],
  }
}

function buildSsrMasonryCss(photos: PhotoManifest[]): string {
  const base
    = `.ssr-m{container-type:inline-size;position:relative;width:100%;height:calc(var(--ms)*var(--cw) + var(--mr)*${MASONRY_GUTTER}px)}`
      + `.ssr-m>a{position:absolute;width:var(--cw);height:calc(var(--ia)*var(--cw));left:calc(var(--c)*(var(--cw) + ${MASONRY_GUTTER}px));top:calc(var(--s)*var(--cw) + var(--r)*${MASONRY_GUTTER}px)}`

  // 合并列分布完全相同的响应式分段（如 mob-4 与 dsk-4），减小内联 CSS 体积
  const merged = new Map<string, { cols: number, mediaParts: string[], placement: SsrBandPlacement }>()
  for (const band of SSR_BANDS) {
    const placement = computeMasonicPlacement(photos, band.cols, band.repW)
    const sig = `${band.cols}:${placement.items.map(it => it.col).join(',')}`
    const existing = merged.get(sig)
    if (existing) {
      existing.mediaParts.push(band.media)
    }
    else {
      merged.set(sig, { cols: band.cols, mediaParts: [band.media], placement })
    }
  }

  let rules = base
  for (const { cols, mediaParts, placement } of merged.values()) {
    const gutterTotal = (cols - 1) * MASONRY_GUTTER
    const cwFallback = `calc((100cqw - ${gutterTotal}px)/${cols})`
    const cwFloored = `round(down,(100cqw - ${gutterTotal}px)/${cols},1px)`
    let block = `.ssr-m{--cw:${cwFallback};--cw:${cwFloored};--ms:${placement.maxS.toFixed(4)};--mr:${placement.maxR}}`
    for (let i = 0; i < placement.items.length; i += 1) {
      const it = placement.items[i]
      block += `.ssr-m>a:nth-of-type(${i + 1}){--c:${it.col};--s:${it.s.toFixed(4)};--r:${it.r}}`
    }
    rules += `@media ${mediaParts.join(',')}{${block}}`
  }
  return rules
}

function SsrPhotoGrid({ photos }: { photos: PhotoManifest[] }) {
  const ssrCss = useMemo(() => buildSsrMasonryCss(photos), [photos])

  return (
    <div key="ssr-grid" className="ssr-m">
      {/* eslint-disable-next-line react-dom/no-dangerously-set-innerhtml */}
      <style dangerouslySetInnerHTML={{ __html: ssrCss }} />
      {photos.map((photo, index) => {
        const ar = photo.aspectRatio > 0 ? photo.aspectRatio : 1
        return (
          <a
            key={photo.id}
            href={`/photos/${encodeURIComponent(photo.id)}`}
            className="bg-fill-quaternary block overflow-hidden"
            style={{ '--ia': Number((1 / ar).toFixed(6)) } as CSSProperties}
          >
            <img
              src={photo.thumbnailUrl}
              alt={photo.title}
              loading={index < SSR_EAGER_IMAGE_COUNT ? 'eager' : 'lazy'}
              fetchPriority={index < SSR_EAGER_IMAGE_COUNT ? 'high' : undefined}
              decoding="async"
              className="h-full w-full object-cover"
            />
          </a>
        )
      })}
    </div>
  )
}
