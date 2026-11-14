# 首屏加载优化（2026-11）

目标：`https://gallery.mgt.moe/`（本仓库 `apps/web` 的生产部署）。测量在 2026-11-14 做，
本地 SPA server（TTFB ≈ 1 ms）跑 headless Chrome + 全新 profile，对比同一 commit 的构建产物。

## 结论

| 指标 | 优化前 | 优化后 | Δ |
|---|---:|---:|---:|
| HTML | 768 952 B（br 65 099） | 6 627 B（br 1 871） | −97% |
| 首屏 JS+CSS+字体（br11） | 1 148 129 B | 394 933 B | −66% |
| manifest JSON | 内联在上面 | 819 733 B（br 63 669，可缓存） | |
| **首屏总字节（br11）** | **1 213 228 B** | **460 473 B** | **−62%** |
| FCP（本地，5 次中位数） | 1 416 ms | 604 ms | −58% |
| LCP（本地，5 次中位数） | 2 472 ms | 1 712 ms | −31% |
| 首屏请求数 | 39 | 30（去掉 heic/maplibre/exiftool/google-fonts） | |

线上（Cloudflare）实测优化前 FCP 2 844 ms / LCP 4 040 ms / load 6 730 ms，其中约 1.3 s 是纯 CPU
（解析 769 KB 内联 manifest + 编译执行 1.47 MB JS）。

## 改了什么

1. **HEIC 解码器移出关键路径**：`heic-to`（3.15 MB 明文 / 750 KB br）在 `strategies/heic.ts`、
   `heic-webcodecs.ts` 里改成动态 `import()`；`file-type` 同样按需加载。原来它作为
   `<link rel="modulepreload">` 在首屏被无条件下载，而 369 张照片里 0 张 HEIC。
2. **maplibre-gl 移出首屏**：`lib/map/worker.ts` 之前在模块作用域调用 `setWorkerUrl()`，
   任何引用它的模块都会把整个 maplibre-gl 拽进首屏 chunk，还导致所有 `import('maplibre-gl')`
   变成无效动态导入。现在 `worker.ts` 只导出 worker URL，注册移进真正创建地图的模块。
3. **去掉 metadata barrel 陷阱**：网格只需要 `formatExifData`，却从 `~/modules/metadata`
   barrel 导入，连带 `ExifPanel`/`MiniMap` → maplibre 一起进首屏。改为直引实现文件，
   并在 barrel 顶部写了警告注释。`MiniMap` 在 `ExifPanel` 里改成 `React.lazy`。
4. **manifest 外置**：`manifest-inject` 在 build 时输出 `photos-manifest.<hash>.json`（内容 hash），
   HTML 里只留 `preload` + URL；`packages/data` 的 `PhotoLoader` 改成 `init(manifest)` 显式注入，
   由 `main.tsx` 在渲染前 `fetch`。dev 模式仍内联（`AFILMORY_EMBED_MANIFEST=true` 可强制内联）。
   manifest 拉取失败时渲染空画廊并在控制台报错，不会白屏。
5. **字体自托管**：去掉 `fonts.googleapis.com` 那份渲染阻塞 CSS（实测那一跳 1.3 s），
   Geist woff2 放进 `apps/web/public/fonts/`，`index.html` 内联 `@font-face` + `preload`。
6. **缓存头**：新增 `apps/web/public/_headers`（Cloudflare Pages 格式），`/assets/*`、`/vendor/*`、
   `/fonts/*`、`/photos-manifest.*` 一年 immutable；HTML 仍 `max-age=0, must-revalidate`。
   原来带 hash 的资源是 `max-age=14400, must-revalidate`，实测每次都 `REVALIDATED`。
7. **viewer 预取延后**：`App.tsx` 原来在 mount 时立刻 `import()` viewer 路由（183 KB br），
   和首屏缩略图抢带宽；改成 `requestIdleCallback`（fallback 3 s）。

## 验证

- `pnpm type-check` 通过；改动文件用 `eslint` 校验，错误数比 HEAD 少（HEAD 在本仓库
  `pnpm lint` 全量本来就不干净，见下面注意事项）。
- 功能矩阵：画廊/深链 viewer/EXIF+MiniMap/`/map` 路由（26 markers）/命令面板（相机+镜头列表）/
  筛选与 URL 同步/`/manifest` 数据页/列表视图/移动端 viewport。
- A/B 对照：与同一 commit 的 HEAD 构建逐 route 比较 `document.body.textContent`，
  `/`、`/manifest`、`/photos/:id` 三个页面**逐字符一致**；`/map` 的 marker/cluster/文案一致，
  控制台 0 error（两条 sprite warning 两边相同，是地图 style 自带的）。

## 注意事项

- **不要对这个仓库跑 `pnpm lint`（`eslint --fix`）**：`style/jsx-one-expression-per-line` 会把
  `{data.width} × {data.height}` 拆成多行，从而**改变渲染文本**（`8485 × 5657` → `8485 ×5657`、
  `ISO 100` → `ISO100`）。本次就踩到了，已回滚并按 HEAD 原样保留这些行。
- manifest 外置后，`window.__MANIFEST__` 在 build 产物里是 `null`（dev 内联时仍有值），
  依赖它的外部脚本需要改成 `await fetch(window.__MANIFEST_URL__)`。
- 首次访问仍需下载 64 KB br 的 manifest；它现在是内容 hash 且 immutable，二次访问不再回源。

---

# 第二轮：图片提前出队 + CSS / manifest / 入口 chunk 三处瘦身（2026-11-14）

第一轮之后线上 FCP 2 144 ms / LCP 3 324 ms（5 次中位数）。这一轮解决两件事：

1. 瀑布图上图片请求排在 `HTML → manifest → JS 执行 → React 渲染` 这条链**后面**，
   而这条链在线上约 800 ms；
2. 首屏那 460 KB br 里还有不少是可以直接砍掉的。

> **本节的数字口径**：以下都是**本地 A/B 的代码字节账**（brotli-11），同一份数据、同一
> commit 的两份构建。**没有测 FCP/LCP** —— 这台机器 RTT ~250 ms、TLS ~500 ms，批次间
> 噪声比被测差异大一个量级，本地跑出来的延迟数字不可信。延迟收益请以线上 RUM 为准。
> 所以下面只说「关键路径代码字节」，不说「首屏总字节」—— 同屏还会真实下载 **43 张**缩略图
> （1440×900 实测 1332.6 KB；390×844 是 46 张 / 1272.0 KB —— 移动端视口窄、懒加载阈值覆盖
> 的相对范围更大，所以请求数反而不比桌面少。都走 R2、不随代码变化）和 idle 预取的
> viewer chunk（约 230 KB br）。

## 改了什么

### 1. 首屏缩略图 preload 进 HTML（`apps/web/plugins/vite/manifest-inject.ts`）

构建期已经知道 manifest，于是把默认排序（拍摄时间倒序，与 `usePhotoViewer.filterAndSortPhotos`
一致）**前 4 张**的 `thumbnailUrl` 直接写成 `<link rel="preload" as="image" fetchpriority="high">`。
图片于是和 manifest/JS 并行下载，而不是排在它们后面。

先 `filter` 再 `slice`：否则前 4 张里只要有一张没有缩略图，preload 数量就会悄悄少一张。

### 2. 给图片 CDN 预建连（同上）

图片走 `r2-gallery.996404.xyz`（与站点不同源），首次连接要多付 DNS + TCP + TLS。
`preconnect` 只是提前把连接搭起来。**不加 `crossorigin`**：`<img>` 没有这个属性，属于
no-cors 请求，加了反而会建立一条用不上的 CORS 连接。

### 3. 网格前 4 张提优先级（`apps/web/src/modules/gallery/MasonryPhotoItem.tsx`）

原来所有缩略图都是 `loading="lazy"` + 同优先级，浏览器把 ~20 个请求平摊带宽，
LCP 那张要等所有请求各分到一勺。现在前 `EAGER_IMAGE_COUNT = 4` 张
`loading="eager"` + `fetchpriority="high"`。

**其余图片不设 `fetchpriority="low"`**：本文件拿到的只是数组下标，不知道真实列数
（`MasonryView` 按容器宽度算 2-8 列）。1440×900 实测是 5 列、1920 是 7 列、手机 2 列 ——
下标 ≥4 的图片**可能就在首屏第一行**（1440 下的第 5 张、1920 下的第 5-7 张、手机的第二行）。
给这些图手动降级会覆盖浏览器的视口内提权，把真正的 LCP 候选压下去。浏览器在没有 hint 时
的默认行为比用下标猜更准，所以只加「确定要提前」的 high，不加「可能会错」的 low。

**这个 4 必须和 `PRELOADED_THUMBNAIL_COUNT` 相等** —— HTML 里 preload 的就是这 4 张。

### 4. CSS 428 025 → 232 110 B 原始字节（`apps/web/src/styles/tailwind.css`）

- **不注册 `@tailwindcss/typography`**：全仓 0 处 `.prose`，但插件会无条件输出十几 KB 规则。
  依赖也一并从 `apps/web/package.json` + `pnpm-workspace.yaml` catalog 里摘掉（lockfile 净减 25 行）。
- **daisyui 只保留 base 层的 6 项**（`rootcolor, svg, rootscrollgutter, properties,
  scrollbar, rootscrolllock`）。站内 UI 全部来自 `packages/ui`（radix + tailwind-variants），
  只用 daisyui 的 theme 变量和它注入到 `<body>` 的 base 样式。

  层归属按 `node_modules/daisyui/imports.js` 的 `base` / `components` / `utilities` 三个导出
  对照（5.7.50）：`join` / `glass` / `radius` / `typography` 都是 **utilities**，只产出
  `.join*` / `.glass` / `.rounded-box` `-field` `-selector` / `.prose`。
  按「类名位置」精确扫全仓 278 个文件、命中 0 处
  （`.join` 的 37 处命中全是 `Array.prototype.join`；`radius-lg` 是 Tailwind 自己的
  `--radius-*` 变量，不是这两个东西）—— 所以四个 utilities 也一起去掉。

### 5. manifest 裁掉只对构建期有意义的字段

`FIELDS_UNUSED_BY_WEB = ['digest', 'ogImageUrl']`：

| 字段 | 占整份 manifest brotli 后的比例 | 浏览器里有谁读 |
|---|---:|---|
| `digest` | **13.4 KB / 64.3 KB（21%）** | **0 处**，只有照片流水线自己用 |
| `ogImageUrl` | 1.3 KB | 只有 `cleanup-stale-assets.ts` 与 builder 插件读**源文件** |

`digest` 是内容 sha256 的前缀，64 位随机 hex，**几乎不可压缩**，所以它单项就占了五分之一。

源文件 `apps/web/src/data/photos-manifest.json` **完整保留**：`scripts/cleanup-stale-assets.ts`
和 OG 中间件读的都是源文件，只有下发给浏览器的产物被裁。
（注：OG 中间件用的是 `ogBase + slug` 现算 URL，并不读 `ogImageUrl` 字段；写在这里是因为
它仍然是构建期字段、运行时无用。）

> **不要往这个列表里加运行时字段。** 首屏网格/列表/筛选/地图/大图 EXIF 面板读到的每一个
> 字段都必须留着 —— 裁掉 `location` 会让列表视图的位置行和 Cmd-K 的地点搜索静默失效，
> 裁掉任何一条 exif 会让 hover 卡、筛选和 EXIF 面板缺数据。回归防线见下面「验证」。

### 6. 后端 SDK 移出入口 chunk（`apps/web/src/lib/client.ts`）

`@afilmory/sdk` 在模块顶层用 zod 定义了一整套 DTO schema，导入它就把 **zod（约 157 KB 未压缩）**
一起拖进首屏。这个站是纯静态部署（`config.useApi / useCloud` 都是 false），点赞/评论/trackView
全部走 feature-detect 短路，首屏永远用不到。

改成 `getClient()`：第一次真的要发请求时才 `import()`。失败时**清掉缓存的 promise**再抛 ——
把 rejection 永久钉在模块作用域里会让「重试」变成永远失败。

### 7. splash 屏的内联淡入动画删掉（`apps/web/index.html`）

4 个 `@keyframes`（`logoFade` / `titleFade` / `subtitleFade` / `loaderFade`）+ 4 处
`animation: … both` 声明。`both` 意味着元素从 `opacity: 0` 起步、1.2 s（还带 0.2/0.4/0.6 s 延迟）
才淡入。LCP 计算会**忽略 `opacity: 0` 的元素**，所以这 1.2 s 是实打实压在 LCP 上的。
删掉之后 logo / 标题 / 副标题从一开始就是可见的，点状加载器仍然负责「还在加载」的暗示。

## 结果（本地 A/B，同一份数据、同一个 commit 的两份构建，brotli-11）

| 项目 | main | 本轮 | Δ |
|---|---:|---:|---:|
| HTML | 1 905 B | 1 905 B | 0 |
| CSS | 42 238 B | 26 315 B | **−37.7%** |
| 入口 JS（含 modulepreload） | 321 008 B | 301 217 B | **−6.2%** |
| 　其中入口 chunk 原始字节 | 968 986 B | 884 542 B | −8.7% |
| manifest | 64 308 B | 49 654 B | **−22.8%** |
| 字体 woff2（已压缩，br 几乎无收益） | 29 404 B | 29 404 B | 0 |
| **关键路径代码字节合计（br11）** | **458 863 B** | **408 397 B** | **−11.0%** |
| 首屏 preload 的图片 | 0 张 | 4 张 | |
| 首屏 `eager` + `high` 的图片 | 0 张 | 4 张 | |

原始字节合计：2 543 781 → 2 198 807 B（−13.6%）。

## 代价：preload 的 4 张只在 `/` 和 `/photos/:id` 上被复用

静态 HTML 无法按路径区分，所以非默认排序的落地页会白下载这几张。实测
（`scripts/perf/check-preload-reuse.mjs`，1440×900）：

| 路由 | preload 4 张里被真正用上 | 浪费 |
|---|---:|---:|
| `/` | **4/4** | 0 |
| `/photos/:id` | **4/4** | 0（viewer 背后仍在渲染画廊） |
| `/?cameras=…` | **0/4** | 4 张 |
| `/map` | **0/4** | 4 张 |

原因：`/?cameras=…` 顶部是 12 张随机 hero 拼贴（`ActiveFiltersHero`），preload 的网格在
它的下面；`/map` 首屏是地图。四处各 4 张 × 约 17.6 KB ≈ **每条 70 KB**，而且是
`fetchpriority=high`，会与真正的首屏图抢带宽。

权衡：`/` 是最主要的入口（也是 LCP 有意义的页面），`/map` 与筛选页是少数路径；
静态站无法按路径分支。所以保留 4 张并把代价写在这里。若将来这些路径变重要，
可以考虑用 Pages Function 按路径注入不同的 preload。

## 试过又否掉的两个方案

留在文档里是因为它们**看起来**都很划算，下次别重做一遍。

### viewer chunk 改成「有意图才预取」→ 否

hover/focus 某张照片时才 `import()` viewer 路由（190 KB br），`window.load` 后空闲兜底。
本地看像能省掉一条早期请求，但它**删掉了 main 本来有的 `requestIdleCallback` 预取**，
导致首屏稳定后立刻点第一张照片反而要多等一次 chunk 下载 —— 对「点进去看图」这个核心
路径是净回归。已回到 main 的行为。

### manifest 拆成 index + 按需 detail → 否

首屏只下发网格字段，完整 `exif` / `location` / `toneAnalysis` / `s3Key` 放第二个文件，
打开大图时再取。实测量出各字段的 brotli-11 边际成本之后这个方案站不住：

| 字段 | 边际 br | 首屏有没有人读 |
|---|---:|---|
| `exif`（完整） | 14 297 B | 有（hover 卡、筛选、EXIF 面板） |
| `digest` | 13 402 B | **没有** |
| `location` | 8 188 B | 有（列表视图位置行、Cmd-K 地点搜索） |
| `thumbHash` | 8 080 B | 有（网格模糊占位） |
| `toneAnalysis` | 2 790 B | 仅 EXIF 面板 |
| `ogImageUrl` | 1 276 B | **没有** |

能挪进 detail 的只有 `s3Key` + `toneAnalysis` + `regions`，合计 **3.9 KB br**；为此却要砍掉
首屏真的在读的 `location` 和 exif 字段（第一版就是这么漏的：列表视图位置行空了、Cmd-K 搜不到
地名、EXIF 面板缺 `GPSAltitude` / `ExposureCompensation` / `ShutterSpeedValue`），还要引入
一套异步合并机制。**对比之下，只裁 `digest` + `ogImageUrl` 就拿到 14.7 KB br，零新代码、
零新失败模式。**

## 验证

三类脚本都落在 **`scripts/perf/`**（入库，不是一次性的 `.perf/`），用法见那里的 README。

- `pnpm type-check` 全绿。**新增覆盖**：`apps/web/tsconfig.json` 的 `include` 加上了
  `./plugins/**/*` —— 之前所有 Vite 插件都不在类型检查范围内。连带修了两处既有问题
  （`plugins/vite/ast.ts` 的 AST 类型不兼容、`scripts/photo-loader.ts` 指向不存在的文件）。

- **数据层**：`scripts/perf/assert-manifest-fields.mjs` 把源 manifest 与 dist 里实际下发的
  那份逐照片逐字段比对 —— 369 张照片 × 8 867 个顶层字段 × 14 919 个 exif 子字段，
  除允许裁剪的 `digest` / `ogImageUrl` 外**完全一致**。
  它**证明不了渲染路径没坏**（数据在 ≠ UI 在读），所以还要下一项。

- **渲染层（最关键）**：`scripts/perf/probe-manifest-fields.mjs` 走真实交互、读 DOM：
  切列表视图断言位置行有 `location.locationName`；深链 viewer 的 EXIF 面板断言 GPS 段落
  有地址与 `GPSAltitude`；Cmd-K 用城市名搜索断言有命中。
  **为什么必须单独做**：网格页的 `textContent` 里**不含 location**（hover 卡只显示
  标题/尺寸/大小/焦距/光圈/快门/ISO），只比网格文本，砍掉 `location` 照样全绿 ——
  第一版就是这么漏的。
  为了确认这个探针**真的有牙**，用 `scripts/perf/make-broken-dist.mjs` 造了一份
  「故意砍掉 location + 16 个 exif 字段」的产物：探针在它上面 **4/5 项失败**
  （列表位置行、EXIF 地址、EXIF 海拔、Cmd-K 地名全部检测到），在正常产物上 5/5 通过。

- **全路由矩阵**：`scripts/perf/verify-routes.ps1` + `diff-routes.mjs`，`/`、
  `/?cameras=SONY ILCE-7RM5`、`/photos/:id`、`/map`、`/manifest` 五条路由 × 两套构建，
  每条用**独立浏览器 session**（不吃 HTTP 缓存），用 `--init-script` 在页面脚本之前接管
  console / `error` / `unhandledrejection` / 资源加载失败，快照拍在稳定态
  （无 pending 图片 + 文本签名连续 3 次不变），viewport 固定在 **1440×900** 并记录
  （`agent-browser` 默认是 1258×566，且带 `--init-script` 的 open 会重启浏览器把 viewport
  重置 —— 这两点都踩过）。
  结果：opt 侧 5 条路由 0 error / 0 uncaught / 0 unhandledrejection / 0 资源加载失败 / 0 破图；
  `/` 渲染文本逐字符一致、已渲染照片 id 集合 44/44 重合 100%；
  `/map` 文案里出现全部 340 个 GPS 拍摄位置（这一条比 marker 数可靠 —— 聚类是动画，
  同一构建跑 3 次 marker 数就会 16/32/32）。

- **判据噪声底线**：先用同一份 main 构建把每条路由跑 3 次，只有基线自己 3/3 稳定的指标
  才当硬判据：`/` 文本 1938/1938/1938 稳定；`/?cameras=…` 1831/1869/1831 **不稳定**
  （顶部随机 hero）；`/map` 聚类数字顺序每次不同；`/photos/:id` 加载进度浮层每次不同。
  `imgCount` 同构建自身也有 ±1~2 抖动（`/` 87/86/86、`/photos/:id` 124/124/125）。

## 代价 / 注意

- daisyui 的 `include:` 白名单是**手工维护**的：将来真要用 `btn` / `card` / `modal` 这类
  组件类，或 `join` / `glass` / `radius` / `typography` 这四个 utilities，必须先把它加回
  白名单，否则样式静默不生效、构建也不报错。
- `FIELDS_UNUSED_BY_WEB` 只能放**运行时 0 处引用**的字段。
- `PRELOADED_THUMBNAIL_COUNT` 与 `EAGER_IMAGE_COUNT` 必须相等，目前靠两处注释互相指向
  （没有构建期断言）。
- `AFILMORY_EMBED_MANIFEST=true`（或 `pnpm dev`）时走内联分支，**不裁字段、也不发 preload**。
