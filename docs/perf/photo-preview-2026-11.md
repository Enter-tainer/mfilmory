# 照片详情页预览图首绘与水合优化（2026-11，基于 React 19 SSG 重整）

目标：针对 `/photos/:photoId` 照片详情页的**主预览图（`previewUrl`）首绘与完整可见耗时**做端到端优化，并在完成 `main`（`b8af9064`，含 per-route React 19 SSG 预渲染与 `hydrateRoot`）rebase 后重新针对 SSG + 水合架构完成实测验收。

基准对照：`main` (`b8af9064`) 的 `apps/web/dist` vs 本分支 rebased 构建产物；本地模拟 Cloudflare Pages clean URL（`/photos/<id>` -> `photos/<id>.html`），图片直连远端 R2。

## 优化前后实测对比（3 次独立冷会话中位数）

| 场景 | 基线 `previewEnd` | 优化后 `previewEnd` | 基线 `fullPaint` / `LCP` | 优化后 `fullPaint` / `LCP` | `preview` 完成前竞争请求（基线 → 优化后） |
|---|---:|---:|---:|---:|---|
| 桌面 `1440×900` ASCII | 3,061 ms | 2,436 ms (−20.4%) | 3,412 / 3,476 ms | **2,447 / 2,500 ms (−28.3% / −28.1%)** | 34 缩略图 + 1 相邻图 + 1 原图 + 1 exiftool → **全部 0** |
| 桌面 `1440×900` CJK + GPS | 3,409 ms | 2,482 ms (−27.2%) | 3,701 / 3,780 ms | **2,493 / 2,544 ms (−32.6% / −32.7%)** | 81 缩略图 + 2 相邻图 + 4 maplibre + 1 exiftool → **全部 0** |
| 移动 `390×844` ASCII | 2,926 ms | 2,012 ms (−31.2%) | 3,215 / 3,316 ms | **2,021 / 2,080 ms (−37.1% / −37.3%)** | 22 缩略图 + 1 相邻图 + 1 原图 + 1 exiftool → **全部 0** |
| 移动 `390×844` CJK + GPS | 2,901 ms | 1,920 ms (−33.8%) | 3,266 / 3,336 ms | **1,932 / 1,980 ms (−40.8% / −40.6%)** | 59 缩略图 + 2 相邻图 + 5 maplibre + 1 exiftool → **全部 0** |

### 3500ms JS 延迟与 0px 水合交接（`measure-photo-preview.mjs` Section 2）

- **4 组配置（桌面/移动 × ASCII/CJK）全部在 JS 到达前由 SSG HTML 完成预览图绘制**：`firstPaint = 1,940 ms`（桌面 ASCII）、`3,052 ms`（桌面 CJK）、`1,715 ms`（移动 ASCII）、`3,163 ms`（移动 CJK），`preJsSwiper=false`。
- 水合接管期间**零消失 / 零闪烁（`disappeared=false`）**、**几何偏移 `maxDelta = 0.00px`**（`dx=0.00, dy=0.00, dw=0.00, dh=0.00`）、**0 水合与控制台报错**。

### 产物字节与分包对比

| 指标 | 基线（`main` `b8af9064`） | 优化后 | 变化 |
|---|---:|---:|---:|
| `_photoId_` 非入口静态 JS（raw / br11） | 438,887 B / 121,160 B（10 chunks） | **241,251 B / 71,205 B（7 chunks）** | **−45.0% raw / −41.2% br11** |
| `photos/*.html` 缺失的静态传递 `modulepreload` | 9 条（多一轮 RTT） | **0 条** | **消除水合前二次 RTT** |
| 首页 `/` 关键路径 `inlineCss`（br11） | 26,658 B | 26,658 B | 0 B |
| 首页 `/` 关键路径 TOTAL（br11） | 275,836 B | 276,566 B | +730 B（+0.26%） |

## 改了什么

1. **SSG `<head>` 关键路径排序与传递依赖预加载**（`apps/web/plugins/vite/ssg-prerender.ts`）：
   - 将单张照片 `<link rel="preload" as="image" fetchpriority="high">` 紧跟 `<link rel="preconnect">` 之后注入，抢在 JS `modulepreload` 队列前发出。
   - 新增 `injectBeforeModuleScripts()`，将子页外链 `index.*.css` 与 `_photoId_.*.css` 提前至 `<script type="module">` 与所有 `modulepreload` 之前（按 `index` → 路由 CSS 级联顺序），避免阻塞渲染的样式表排队等 JS。
   - 新增 `collectTransitiveStaticAssets()`，从入口外递归收集 `_photoId_` 与 `map` 的全部非入口静态 JS/CSS 传递依赖并注入 `modulepreload`（0 缺失），并在构建期断言路由 chunk 必须存在。
2. **直达 `/photos/:id` 延迟挂载背景画廊 & SPA 回退并行加载**（`apps/web/src/pages/(main)/layout.sync.tsx`、`apps/web/src/main.tsx`、`apps/web/src/App.tsx`）：
   - `layout.sync.tsx` 用 `hasMountedGallery` 锁存延迟挂载隐藏 `<PhotosRoot />`，直到回到 `/` 时再挂载，直达照片页 DOM `<img>` 数显著下降（`105 -> 39`）且按 Esc 返回画廊正常。
   - `main.tsx` 在未命中 SSG 的 `/photos/` 回退路径下与 `resolveManifest()` 并行发起路由 chunk 加载；`App.tsx` 在 `/photos/` 路径跳过多余 idle 预取。
3. **精简 `_photoId_` 路由 chunk 与按需懒加载**（`HighResImageStage.tsx`、`RawExifSheet.tsx`、`ShareSheet.tsx`、`exiftool.ts`、`PhotoViewer.tsx`、`pages/(main)/photos/[photoId]/index.tsx`）：
   - 拆出懒加载 `HighResImageStage`（`@afilmory/webgl-viewer`、`LivePhotoVideo`、`HDRBadge`、`LivePhotoBadge`、`SlidingNumber`、右键菜单）、`RawExifSheet` + 按需 `ExifToolManager`（移除 `isExiftoolLoadedAtom` 并在 `ExifPanel` 直接按需挂载按钮）、`ShareSheet`、`GalleryThumbnail`、`MobilePhotoInspectorSheet`；保留 `ExifPanel` 静态导入以维持桌面端 SSG 零水合差错与无 JS 元数据可见。
   - 路由入口直引 `PhotoViewer` 绕过 barrel，并用 `hasDerivedAccentRef` 跳过冷首帧 `* { transition }` `<style>` 注入。
4. **Preview 优先调度、零淡入延迟与零带宽竞争**（`ProgressiveImage.tsx`、`PhotoViewer.tsx`、`hooks.ts`、`types.ts`、`ContainedImageFrame.tsx`、`entry-animation-state.ts`、`GalleryThumbnail.tsx`、`HistogramChart.tsx`、`ExifPanel.tsx`、`SharedElementTransitionPreview.tsx`）：
   - 当前图片 `<img>` 使用 `fetchPriority="high" loading="eager" decoding="sync"`；冷直达开启 `eagerRevealPreview` 跳过 `opacity-0` 与 `duration-300` 淡入（修复百分号编码 CJK URL 匹配），使 `firstPaint === fullPaint`。
   - 相邻 slide（`canLoadPreview`）、`GalleryThumbnail`（以 `h-12 lg:h-16` 响应式壳消除移动端 SSR `64px`→水合 `48px` 8px 布局跳变，并用 `hasSecondaryMounted` 防止切图闪退）、`HistogramChart`、`DeferredMiniMap`（`isClient` + `IntersectionObserver` `rootMargin: 120px`）以及高分辨率原图（`useImageLoader`）全部在当前 preview 落定后才启动，并设 `4500ms` / `5000ms` 兜底定时器。
5. **画廊悬停/按压与看图邻接图预热**（`apps/web/src/lib/preview-prewarm.ts`、`MasonryPhotoItem.tsx`、`ListView.tsx`、`usePhotoViewer.ts`、`PhotoViewer.tsx`）：
   - 桌面鼠标 hover（80ms 防抖，low 并发 ≤2，遵循 `shouldSkipHeavyPrefetch()`）、`pointerdown`（high 优先级 + 路由预热）与切图后空闲预热上一张/下一张 `previewUrl`。

## 验证摘要

- `pnpm --filter @afilmory/web exec vite build`（371 条路由渲染与静态断言）、`pnpm og:middleware -- --check`、`pnpm type-check` 全部通过。
- 单元测试全部通过：`@afilmory/web` Vitest（3 文件 13/13）、地图 `tsx --test`（3/3）、`@afilmory/viewer-motion`（13/13）、`@afilmory/webgl-viewer`（6/6）。
- 静态一致性：`check-inline-css.mjs`、`assert-manifest-fields.mjs`（369 照片 / 9,236 字段 / 14,919 exif 子字段一致）、`check-block-comments.mjs`（全仓 + `scripts/perf` 0 违规）、变动文件定向 `eslint`（app/plugin/perf 25 个文件 0 error）。
- Chromium 端到端：`measure-photo-preview.mjs` **27/27 全通过**（Section 1–4 含 Hover 预热、`ArrowRight`、Esc 挂载画廊、MiniMap 滚动懒加载、Share（预览用 manifest 的 `previewUrl`）+ Sonner、Raw EXIF、`ContextMenu`、移动详情抽屉、Zero-JS）；`probe-manifest-fields.mjs` **5/5 通过**；`verify-routes.ps1` + `diff-routes.mjs` 五路由全矩阵**硬性判据全部通过**（`deeplink` 图片 `106 → 38`、`/` 1483 字逐字符一致 & 100% 重合、`/map` 340 GPS & 32 markers、`/manifest` 20535 字逐字符一致 & 100% 重合；`/manifest` 有 60 条远端缩略图并发瞬时限流软提示）。
