import { useAtomValue } from 'jotai'
import type { RenderComponentProps } from 'masonic'
import type { CSSProperties } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { gallerySettingAtom } from '~/atoms/app'
import { useMobile } from '~/hooks/useMobile'
import { useIsClient } from '~/lib/ssr'
import type { PhotoManifest } from '~/types/photo'

import type { MasonryRef } from './Masonic'
import { computeColumns, Masonry } from './Masonic'
import { MasonryPhotoItem } from './MasonryPhotoItem'

const SSR_GRID_PHOTO_COUNT = 36
const SSR_EAGER_IMAGE_COUNT = 4
const MASONRY_GUTTER = 4

const getViewportContentWidth = () =>
  typeof document !== 'undefined'
    ? document.body.clientWidth || document.documentElement.clientWidth || window.innerWidth
    : 1440

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
  const [containerWidth, setContainerWidth] = useState(getViewportContentWidth)
  const masonryRef = useRef<MasonryRef>(null)
  const isMobile = useMobile()

  // 监听容器宽度变化
  useEffect(() => {
    const updateContainerWidth = () => {
      setContainerWidth(getViewportContentWidth())
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
  const getItemHeight = useCallback((photo: PhotoManifest, colW: number) => {
    const ar = photo.aspectRatio > 0 ? photo.aspectRatio : 1
    return Math.max(1, Math.round(colW / ar))
  }, [])
  const maxColumnCount = columns === 'auto' && !isMobile ? COLUMN_WIDTH_CONFIG.auto.maxColumns : undefined
  const itemHeightEstimate = useMemo(() => {
    if (photos.length === 0) {
      return 300
    }
    const availableWidth = Math.max(containerWidth - (isMobile ? 8 : 0), columnWidth)
    const [actualColW] = computeColumns(availableWidth, columnWidth, MASONRY_GUTTER, undefined, maxColumnCount)
    let invArSum = 0
    for (const photo of photos) {
      const ar = photo.aspectRatio > 0 ? photo.aspectRatio : 1
      invArSum += 1 / ar
    }
    return Math.round((invArSum / photos.length) * actualColW + MASONRY_GUTTER)
  }, [photos, containerWidth, isMobile, columnWidth, maxColumnCount])

  if (!isClient) {
    return <SsrPhotoGrid photos={photos.slice(0, SSR_GRID_PHOTO_COUNT)} />
  }

  const initialMasonryWidth = containerWidth - (isMobile ? 8 : 0)

  return (
    <Masonry<PhotoManifest>
      ref={masonryRef}
      items={photos}
      render={renderMasonryItem}
      onRender={onRender}
      initialWidth={initialMasonryWidth}
      getItemHeight={getItemHeight}
      columnWidth={columnWidth}
      maxColumnCount={maxColumnCount}
      columnGutter={MASONRY_GUTTER}
      rowGutter={MASONRY_GUTTER}
      itemHeightEstimate={itemHeightEstimate}
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
      // 高度与首帧切换：
      //   1) `itemHeightEstimate` 由 `mean(1/aspectRatio) * actualColW + gutter` 数据驱动计算
      //      （1440px 下约 228px，不再用 400px 硬编码导致 28,652px 虚高）；
      //   2) `Masonic.tsx` 传入 `getItemHeight` 在创建 positioner 时一次性预置全部 item 高度，
      //      首次 commit 即进入 phase-two（零 `visibility:hidden` 首帧空窗、真实容器总高 ~17,037px）。
      overscanBy={1.5}
      itemKey={getItemKey}
    />
  )
}

const MasonryItem = memo(MasonryPhotoItem)

interface SsrBandPlacement {
  sig: string
  items: Array<{ col: number, s: number, r: number }>
  maxS: number
  maxR: number
}

const SSR_REGIMES: ReadonlyArray<{
  media: string
  minW: number
  maxW: number
  minColW: number
  maxCols?: number
}> = [
  { media: '(max-width:1023.98px)', minW: 240, maxW: 1023, minColW: COLUMN_WIDTH_CONFIG.auto.mobile },
  {
    media: '(min-width:1024px)',
    minW: 960,
    maxW: 2560,
    minColW: COLUMN_WIDTH_CONFIG.auto.desktop,
    maxCols: COLUMN_WIDTH_CONFIG.auto.maxColumns,
  },
]

function computeMasonicPlacement(photos: PhotoManifest[], cols: number, colW: number): SsrBandPlacement {
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
    sig: `${cols}:${items.map(it => it.col).join(',')}`,
    items,
    maxS: sArr[tallestCol],
    maxR: rArr[tallestCol],
  }
}

function buildSsrMasonryCss(photos: PhotoManifest[]): string {
  const base
    = `.ssr-m-w{container-type:inline-size;width:100%}`
      + `.ssr-m{position:relative;width:100%;height:calc(var(--ms)*var(--cw) + var(--mr)*${MASONRY_GUTTER}px)}`
      + `.ssr-m>a{position:absolute;width:var(--cw);height:calc(var(--ia)*var(--cw));left:calc(var(--c)*(var(--cw) + ${MASONRY_GUTTER}px));top:calc(var(--s)*var(--cw) + var(--r)*${MASONRY_GUTTER}px)}`

  const placementCache = new Map<string, SsrBandPlacement>()
  let rules = base

  for (const regime of SSR_REGIMES) {
    const rawRanges: Array<{
      cols: number
      minW: number
      maxW: number
      placement: SsrBandPlacement
    }> = []

    for (let w = regime.minW; w <= regime.maxW; w += 1) {
      const [colW, cols] = computeColumns(w, regime.minColW, MASONRY_GUTTER, undefined, regime.maxCols)
      const cacheKey = `${cols}:${colW}`
      let placement = placementCache.get(cacheKey)
      if (!placement) {
        placement = computeMasonicPlacement(photos, cols, colW)
        placementCache.set(cacheKey, placement)
      }
      const last = rawRanges.at(-1)
      if (last && last.placement.sig === placement.sig) {
        last.maxW = w
      }
      else {
        rawRanges.push({ cols, minW: w, maxW: w, placement })
      }
    }

    // 合并同列分布的分段，通过 @container 直接按 .ssr-m-w 真实宽度（扣掉 padding 与滚动条）匹配
    const merged = new Map<string, { cols: number, queries: string[], placement: SsrBandPlacement }>()
    for (let idx = 0; idx < rawRanges.length; idx += 1) {
      const range = rawRanges[idx]
      const conds: string[] = []
      if (idx > 0) {
        conds.push(`(min-width:${range.minW}px)`)
      }
      if (idx < rawRanges.length - 1) {
        conds.push(`(max-width:${range.maxW}.98px)`)
      }
      const query = conds.length > 1 ? `(${conds.join(' and ')})` : conds[0] ?? '(min-width:0px)'
      const existing = merged.get(range.placement.sig)
      if (existing) {
        existing.queries.push(query)
      }
      else {
        merged.set(range.placement.sig, {
          cols: range.cols,
          queries: [query],
          placement: range.placement,
        })
      }
    }

    let mediaBody = ''
    for (const { cols, queries, placement } of merged.values()) {
      const gutterTotal = (cols - 1) * MASONRY_GUTTER
      const cwFallback = `calc((100cqw - ${gutterTotal}px)/${cols})`
      const cwFloored = `round(down,(100cqw - ${gutterTotal}px)/${cols},1px)`
      let block
        = `.ssr-m{--cw:${cwFallback};--ms:${placement.maxS.toFixed(4)};--mr:${placement.maxR}}`
          + `@supports (width:round(down,1px,1px)){.ssr-m{--cw:${cwFloored}}}`
      for (let i = 0; i < placement.items.length; i += 1) {
        const it = placement.items[i]
        block += `.ssr-m>a:nth-of-type(${i + 1}){--c:${it.col};--s:${it.s.toFixed(4)};--r:${it.r}}`
      }
      mediaBody += `@container ${queries.join(' or ')}{${block}}`
    }

    rules += `@media ${regime.media}{${mediaBody}}`
  }

  return rules
}

function SsrPhotoGrid({ photos }: { photos: PhotoManifest[] }) {
  const ssrCss = useMemo(() => buildSsrMasonryCss(photos), [photos])

  return (
    <div key="ssr-grid" className="ssr-m-w">
      {/* eslint-disable-next-line react-dom/no-dangerously-set-innerhtml */}
      <style dangerouslySetInnerHTML={{ __html: ssrCss }} />
      <div className="ssr-m">
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
    </div>
  )
}
