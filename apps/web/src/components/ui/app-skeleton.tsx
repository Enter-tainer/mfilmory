import clsx from 'clsx'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={clsx('bg-accent animate-pulse rounded-md', className)} {...props} />
}

export function AppSkeleton() {
  // 定义不同高度的骨架卡片来模拟瀑布流效果
  const skeletonHeights = [
    320, 240, 280, 200, 360, 260, 300, 220, 340, 180, 280, 240, 320, 260, 200, 300, 240, 280, 220, 360,
  ]

  return (
    <div className="min-h-screen bg-neutral-900">
      <header className="fixed top-0 right-0 left-0 z-50">
        <div className="flex h-12 items-center justify-between gap-2 px-3 lg:h-12 lg:gap-3 lg:px-4">
          {/* 左侧：头像 + 标题 + 数字 + 社交图标 */}
          <div className="flex items-center gap-2">
            {/* 头像 */}
            <Skeleton className="size-7 rounded-lg bg-neutral-700 lg:size-8" />

            {/* 标题和数字 */}
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-5 w-32 bg-neutral-700" />
              <Skeleton className="h-4 w-8 rounded-full bg-neutral-700" />
            </div>

            {/* 社交图标组 */}
            <div className="ml-2 flex items-center gap-2">
              <Skeleton className="size-4 rounded bg-neutral-700" />
              <Skeleton className="size-4 rounded bg-neutral-700" />
              <Skeleton className="size-4 rounded bg-neutral-700" />
            </div>
          </div>

          {/* 右侧工具栏 */}
          <div className="flex items-center gap-1 lg:gap-1.5">
            {/* 按钮组：搜索、地图、布局、语言 */}
            <div className="flex items-center gap-1 rounded-lg ">
              <Skeleton className="size-7 rounded bg-neutral-700 lg:size-8" />
              <Skeleton className="size-7 rounded bg-neutral-700 lg:size-8" />
              <Skeleton className="size-7 rounded bg-neutral-700 lg:size-8" />
            </div>
          </div>
        </div>
      </header>

      <div className="h-12" />

      {/* 瀑布流网格骨架 */}
      <main className="p-1">
        <div className="columns-2 gap-1 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6">
          {skeletonHeights.map((height, index) => (
            <div key={index} className="mb-1 break-inside-avoid">
              <Skeleton className="w-full rounded-none bg-neutral-800" style={{ height: `${height}px` }} />
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
