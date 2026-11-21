// @copy internal masonic hooks
import { useScrollViewElement } from '@afilmory/ui'
import { clearRequestTimeout, requestTimeout } from '@essentials/request-timeout'
import { useWindowSize } from '@react-hook/window-size'
import { isEqual, throttle } from 'es-toolkit/compat'
import type { ContainerPosition, MasonryProps, MasonryScrollerProps, Positioner, UsePositionerOptions } from 'masonic'
import { createPositioner, createResizeObserver, useMasonry, usePositioner, useScrollToIndex } from 'masonic'
import { useForceUpdate } from 'motion/react'
import * as React from 'react'

export interface MasonryRef {
  reposition: () => void
}

const EMPTY_POSITIONER_OPTIONS: UsePositionerOptions = { width: 1, columnCount: 1 }

// eslint-disable-next-line react-refresh/only-export-components
export function computeColumns(
  width = 0,
  minimumWidth = 200,
  gutter = 0,
  columnCount?: number,
  maxColumnCount?: number,
  maxColumnWidth?: number,
): [number, number] {
  const safeWidth = width > 0 ? width : 1
  const count
    = columnCount
      || Math.min(
        Math.floor((safeWidth + gutter) / (minimumWidth + gutter)),
        maxColumnCount || Infinity,
      )
      || 1
  let colW = Math.floor((safeWidth - gutter * (count - 1)) / count)
  if (maxColumnWidth !== undefined && colW > maxColumnWidth) {
    colW = maxColumnWidth
  }
  return [Math.max(1, colW), count]
}

/**
 * A "batteries included" masonry grid which includes all of the implementation details below. This component is the
 * easiest way to get off and running in your app, before switching to more advanced implementations, if necessary.
 * It will change its column count to fit its container's width and will decide how many rows to render based upon
 * the height of the browser `window`.
 *
 * @param props
 */
export const Masonry = <Item,>(
  props: MasonryProps<Item> & {
    ref?: React.Ref<MasonryRef>
    initialWidth?: number
    getItemHeight?: (item: Item, columnWidth: number) => number
  },
) => {
  const [scrollTop, setScrollTop] = React.useState(0)
  const [isScrolling, setIsScrolling] = React.useState(false)
  const scrollElement = useScrollViewElement()

  const fps = props.scrollFps || 12
  React.useEffect(() => {
    if (!scrollElement) {
      return
    }

    const scrollTimer: number | null = null
    const handleScroll = throttle(() => {
      setIsScrolling(true)
      setScrollTop(scrollElement.scrollTop)
    }, 1000 / fps)

    scrollElement.addEventListener('scroll', handleScroll)

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
      if (scrollTimer) {
        clearTimeout(scrollTimer)
      }
    }
  }, [fps, scrollElement])
  const didMount = React.useRef(0)
  React.useEffect(() => {
    if (didMount.current === 1) {
      setIsScrolling(true)
    }
    let didUnsubscribe = false
    const to = requestTimeout(
      () => {
        if (didUnsubscribe) {
          return
        }
        // This is here to prevent premature bail outs while maintaining high resolution
        // unsets. Without it there will always bee a lot of unnecessary DOM writes to style.
        setIsScrolling(false)
      },
      40 + 1000 / fps,
    )
    didMount.current = 1
    return () => {
      didUnsubscribe = true
      clearRequestTimeout(to)
    }
  }, [fps, scrollTop])

  const containerRef = React.useRef<null | HTMLElement>(null)
  const windowSize = useWindowSize({
    initialWidth: props.ssrWidth,
    initialHeight: props.ssrHeight,
  })
  const containerPos = useContainerPosition(containerRef, windowSize)

  const nextProps = Object.assign(
    {
      offset: containerPos.offset,
      width: containerPos.width || props.initialWidth || windowSize[0],
      height: containerPos.height || windowSize[1],
      containerRef,
    },
    props,
  ) as any

  const [positionIndex, setPositionIndex] = React.useState(0)

  React.useImperativeHandle(props.ref, () => ({
    reposition: () => {
      setPositionIndex(i => i + 1)
    },
  }))

  // Workaround for https://github.com/jaredLunde/masonic/issues/12
  const itemCounter = React.useRef<number>(props.items.length)

  let shrunk = false

  if (props.items.length !== itemCounter.current) {
    if (props.items.length < itemCounter.current) {
      shrunk = true
    }

    itemCounter.current = props.items.length
  }

  const fallbackPositioner = usePositioner(
    props.getItemHeight ? EMPTY_POSITIONER_OPTIONS : nextProps,
    [shrunk ? Math.random() + positionIndex : positionIndex],
  )

  const seededPositioner = React.useMemo(() => {
    if (!props.getItemHeight) {
      return null
    }
    const columnGutter = nextProps.columnGutter ?? 0
    const rowGutter = nextProps.rowGutter ?? columnGutter
    const [computedColumnWidth, computedColumnCount] = computeColumns(
      nextProps.width,
      nextProps.columnWidth ?? 200,
      columnGutter,
      nextProps.columnCount,
      nextProps.maxColumnCount,
      nextProps.maxColumnWidth,
    )
    const positioner = createPositioner(
      computedColumnCount,
      computedColumnWidth,
      columnGutter,
      rowGutter,
    )
    for (let i = 0; i < props.items.length; i += 1) {
      positioner.set(i, Math.max(1, props.getItemHeight(props.items[i], computedColumnWidth)))
    }
    return positioner
    // eslint-disable-next-line react-hooks/exhaustive-deps -- positionIndex is an explicit trigger for ref.reposition()
  }, [
    props.getItemHeight,
    props.items,
    nextProps.width,
    nextProps.columnWidth,
    nextProps.columnGutter,
    nextProps.rowGutter,
    nextProps.columnCount,
    nextProps.maxColumnCount,
    nextProps.maxColumnWidth,
    positionIndex,
  ])

  nextProps.positioner = seededPositioner ?? fallbackPositioner

  nextProps.resizeObserver = useResizeObserver(nextProps.positioner)
  nextProps.scrollTop = scrollTop
  nextProps.isScrolling = isScrolling
  nextProps.height = typeof window !== 'undefined' ? window.innerHeight : 900

  const scrollToIndex = useScrollToIndex(nextProps.positioner, {
    height: nextProps.height,
    offset: containerPos.offset,
    align: typeof props.scrollToIndex === 'object' ? props.scrollToIndex.align : void 0,
  })
  const index
    = props.scrollToIndex && (typeof props.scrollToIndex === 'number' ? props.scrollToIndex : props.scrollToIndex.index)

  React.useEffect(() => {
    if (index !== void 0) {
      scrollToIndex(index)
    }
  }, [index, scrollToIndex])

  return <MasonryScroller {...nextProps} />
}

function MasonryScroller<Item>(
  props: MasonryScrollerProps<Item> & {
    scrollTop: number
    isScrolling: boolean
  },
) {
  // We put this in its own layer because it's the thing that will trigger the most updates
  // and we don't want to slower ourselves by cycling through all the functions, objects, and effects
  // of other hooks
  // const { scrollTop, isScrolling } = useScroller(props.offset, props.scrollFps)
  // This is an update-heavy phase and while we could just Object.assign here,
  // it is way faster to inline and there's a relatively low hit to he bundle
  // size.

  return useMasonry<Item>({
    scrollTop: props.scrollTop,
    isScrolling: props.isScrolling,
    positioner: props.positioner,
    resizeObserver: props.resizeObserver,
    items: props.items,
    onRender: props.onRender,
    as: props.as,
    id: props.id,
    className: props.className,
    style: props.style,
    role: props.role,
    tabIndex: props.tabIndex,
    containerRef: props.containerRef,
    itemAs: props.itemAs,
    itemStyle: props.itemStyle,
    itemHeightEstimate: props.itemHeightEstimate,
    itemKey: props.itemKey,
    overscanBy: props.overscanBy,
    height: props.height,
    render: props.render,
  })
}

function useContainerPosition(
  elementRef: React.MutableRefObject<HTMLElement | null>,
  deps: React.DependencyList = [],
): ContainerPosition & {
  height: number
} {
  const [containerPosition, setContainerPosition] = React.useState<
    ContainerPosition & {
      height: number
    }
  >({
    offset: 0,
    width: 0,
    height: 0,
  })

  React.useLayoutEffect(() => {
    const { current } = elementRef
    if (current !== null) {
      let offset = 0
      let el = current

      do {
        offset += el.offsetTop || 0
        el = el.offsetParent as HTMLElement
      } while (el)

      if (offset !== containerPosition.offset || current.offsetWidth !== containerPosition.width) {
        setContainerPosition({
          offset,
          width: current.offsetWidth,
          height: current.offsetHeight,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  React.useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      setContainerPosition((prev) => {
        const next = {
          ...prev,
          width: elementRef.current?.offsetWidth || 0,
        }
        if (isEqual(next, prev)) {
          return prev
        }
        return next
      })
    })
    resizeObserver.observe(elementRef.current as HTMLElement)
    return () => {
      resizeObserver.disconnect()
    }
  }, [containerPosition, elementRef])

  return containerPosition
}

function useResizeObserver(positioner: Positioner) {
  const [forceUpdate] = useForceUpdate()
  const resizeObserver = createResizeObserver(positioner, throttle(forceUpdate, 1000 / 12))
  // Cleans up the resize observers when they change or the
  // component unmounts
  React.useEffect(() => () => resizeObserver.disconnect(), [resizeObserver])
  return resizeObserver
}
