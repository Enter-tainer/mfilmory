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
  按「类名位置」精确扫全仓源码文件（当期 278 个）、命中 0 处
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

> 后续变更：TECH-90 直接删除了不可达的社交/会话代码与 `@afilmory/sdk` 依赖（`lib/client.ts`、
> `getClient()`、`useApi`/`useCloud` flag 都已不存在），本节记录的是当时的中间态。

`@afilmory/sdk` 在模块顶层用 zod 定义了一整套 DTO schema，导入它就把 **zod（约 157 KB 未压缩）**
一起拖进首屏。这个站是纯静态部署（`config.useApi / useCloud` 当时都是 false），点赞/评论/trackView
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

## 和其它 perf PR 一起合入后的实测

这一轮同时有 5 个 perf PR（manifest 裁剪 / 网格 overscan / 主 CSS 内联 / `_routes.json` /
上传 Cache-Control）。把 5 个**全部合到一个分支**上构建后实测，基准是 main：

| 组成 | main | 5 个合并 | Δ |
|---|---:|---:|---:|
| HTML + 内联 CSS | 1 905 B | 28 147 B | +26 242 |
| 外链 CSS | 42 238 B | 0 B | −42 238 |
| 入口 JS（含 modulepreload） | 321 008 B | 301 130 B | −19 878 |
| manifest | 64 308 B | 49 654 B | −14 654 |
| **关键路径合计（br11）** | **429 459 B** | **378 931 B** | **−11.77%** |

（CSS 那一栏要连着看：外链的 42 238 B 全部变成 HTML 里的内联 26 648 B，
净效果是 CSS 相关字节 44 143 → 28 147，即 −36%。）

**跨 PR 交互发现并修掉了一个单看任何一个 PR 都发现不了的构建失败**：
主 CSS 内联插件 `import type { OutputBundle } from 'vite'`，而 Vite 8 并没有导出这个类型
（它从 `rolldown` 局部 import）。因为 `apps/web/tsconfig.json` 的 `include` 里没有 `plugins/`，
这个错误一直是隐形的；只有和「把 plugins 纳入 type-check」的改动同时存在时，
`vite-plugin-checker` 才把它变成 `vite build` 失败。已在该 PR 里改成本地结构化类型。

合并后的完整验收（base 选「只含网格 overscan 那一个改动」的构建，这样才隔离出其它 PR 的影响）：
5 条路由硬性判据全通过、`probe-manifest-fields.mjs` 5/5 通过、manifest 逐字段断言通过、
主 CSS 内联内容与参照产物逐字节一致、`vite build` 与 `pnpm type-check` 均 exit 0。

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

---

# 第三轮：首屏入口 JS 瘦身与按需加载（2026-11-20）

## 实测结果（`scripts/perf/bytes-accounting.mjs`，br11，同源 `config.json` + 369 张照片 manifest）

| 指标 | 优化前（`main`） | 优化后（Round 3） | Δ |
|---|---:|---:|---:|
| `html` | 26 457 B | 26 535 B | +78 B |
| `inlineCss` | 24 968 B | 24 968 B | 0 B |
| `js`（entry + modulepreload） | 286 513 B | 195 526 B | **−90 987 B（−31.76%）** |
| `manifest` | 48 765 B | 48 765 B | 0 B |
| **关键路径总计（TOTAL）** | **361 735 B** | **270 826 B** | **−90 909 B（−25.13%）** |

- **主入口单包**：`index-*.js` 从 `839 361 B` 明文（`211 673 B br11`）降到 `331 859 B` 明文（`92 922 B br11`）。
- **内联 CSS**：`check-inline-css.mjs` 确认 `215 060 B` 明文（`24 968 B br11`）与参照产物逐字节一致。
- **首屏异步 chunk 透明口径**：
  - 单语言 locale chunk（与 manifest 并行拉取，0 额外 RTT、0 FOUC）：`en` `4 298 B`、`zh-HK` `4 504 B`、`zh-CN` `4 508 B`、`zh-TW` `4 510 B`、`ko` `4 909 B`、`jp` `5 068 B`（br11）。
  - 异步 `motion-features`（`domMax`）：`58 611 B` 明文 / `16 293 B br11`（不阻塞首帧渲染）。
  - 即使计入这两项，首次访问总传输仍净减约 ~70 KB br11，且主线程首帧解析与执行开销显著下降。

## 改了什么

1. **`LazyMotion` `domMax` 异步化**：通过独立 proxy `apps/web/src/lib/motion-features.ts` 动态加载 `domMax`（避开 Rolldown 对已被静态导入的 `motion/react` barrel 做动态 `import()` 导致 namespace 无法拆分、产生 32 条碎片 `modulepreload` 的陷阱）。
2. **包级 tree-shaking 与 `ExifRow` 拆分**：`packages/viewer-motion`、`packages/utils` 声明 `"sideEffects": false`；`packages/ui` 声明 `"sideEffects": ["**/*.css"]` 并去掉 `src/index.ts` 中重复导出的 `./checkbox`、`./sonner`；将依赖 `EllipsisHorizontalTextWithTooltip`（Radix Tooltip + Floating UI）的 `Row` 从 `formatExifData.tsx` 拆至 `ExifRow.tsx`，避免网格调用 `formatExifData` 时将 Tooltip 拖入首屏。
3. **i18n 6 语言包按需加载**：`apps/web/src/@types/resources.ts` 改为纯类型导出，`apps/web/src/i18n.ts` 使用动态 `BackendModule` 按当前语言拉取单一 locale JSON，`apps/web/src/main.tsx` 的 `bootstrap()` 用 `Promise.all([resolveManifest(), i18nReady])` 与 manifest 并行等待（保留 `fallbackLng: { default: ['en'] }` 兜底非 `en`/`zh-CN` 语言的缺失键）。
4. **非首屏组件懒加载与死代码清理**：
   - 删除未被引用的死组件 `apps/web/src/modules/gallery/ActionPanel.tsx`，同步清理 `DESIGN.md` 与 `.agents/skills/afilmory-web-design/SKILL.md` 中的过期引用。
   - `PhotosRoot.tsx`：`ActiveFiltersHero`、`ListView` 改为 `React.lazy`。
   - `App.tsx`：`CommandPalette` 改为带 `hasOpened` 锁存的 `React.lazy`（首次打开后保留以维持退场动画）。
   - `PageHeaderRight.tsx`：拆出 `MobileViewDrawer.tsx` 懒加载 `vaul` 抽屉。
   - `context-menu-provider.tsx`：拆出 `context-menu-handler.tsx` 在首次右键打开时懒加载 Radix ContextMenu。
   - `packages/ui/src/modal/ModalContainer.tsx`：拆出 `ModalWrapper.tsx` 在 `items.length > 0` 时懒加载 Radix Dialog + `usehooks-ts`。
   - `root-providers.tsx`：通过独立 proxy `toaster-impl.tsx` + `DeferredToaster` 在进入 viewer（`viewerAtom.isOpen || pathname.startsWith('/photos/')`）后挂载 Sonner `<Toaster />`（审计确认全仓 `toast` 仅在 `RawExifViewer`、`ShareModal`、`viewer/hooks` 调用）。
   - `MasonryPhotoItem.tsx`：移除缩略图加载完成后立即预下载桌面端 Live Photo / Motion Photo 视频的 `useEffect`，改为 `import type` + 桌面端 hover 200 ms 后才动态 `import('~/lib/image-loader-manager')`。
5. **小修复两处**：`MasonryView.tsx` 首帧同步以 `window.innerWidth` 初始化 `containerWidth`；`apps/web/plugins/vite/og-image-plugin.ts` 移除与 `VitePWA` 重复的 `<link rel="manifest" href="/manifest.webmanifest" />`。

## 明确未做的两项（及原因）

- **未拆分 `photos-manifest.*.json`**：延续第二轮「manifest 拆成 index + 按需 detail → 否」的已验证结论（仅约 `3.9 KB br` 可挪出，不值得引入异步合并复杂度并破坏单文件契约）。
- **未替换已懒加载组件（`ListView`、`ActiveFiltersHero`）中的既有 `lucide-react` 图标为 `i-mingcute-*`**：这些图标已移出首屏 JS，改用 `i-mingcute-*` 反而会让 Tailwind 把新 SVG 规则打入 `index.html` 的内联 CSS。

## 验证摘要

- `pnpm --filter @afilmory/web exec vite build`、`pnpm type-check`（含 `apps/web/plugins/**/*`）、变更文件定向 `eslint`、`check-block-comments.mjs` 全通过。
- `assert-manifest-fields.mjs`（369 照片 / 9 236 字段 / 14 919 exif 子字段一致）、`check-inline-css.mjs`（215 060 B 逐字节一致）、`dist/index.html` 单条 `<link rel="manifest"`、入口 + 10 条 `modulepreload` chunk 扫描确认 `vaul` / `sonner` / `@use-gesture` / `@tanstack/virtual` / Radix Dialog·Tooltip·ContextMenu·Select / `domMax` / `image-convert` 均为 0 命中。
- `probe-manifest-fields.mjs` 5/5 通过。
- `verify-routes.ps1` + `diff-routes.mjs`（5 路由）：`deeplink`、`filter-camera`、`manifest-page`、`map`（340 GPS 地点）硬判据全通过，非 `/manifest` 路由 0 JS/资源错误、0 破图；`/` 上 `imgCount` 67→67、`renderedIds` 34→34（100% 重合）、`textLen` 1483→1483、33/33 照片文本片段集合逐字符一致，仅底部相邻两张（`MGT06415` / `MGT06601`）因 `masonic` interval-tree DOM 挂载顺序置换，已在未改动 `main` 基线上复测确认 `main` 自身即在两个完全相同的顺序间交替出现。
- 4 项交互懒加载测试（`127.0.0.1:4822`）：动态语言切换（中文↔日本語↔English）、Cmd-K 触发懒加载 `ModalContainer` 自定义日期弹窗、移动端 390×844 触发懒加载 `MobileViewDrawer`、`/photos/:id` 右键触发懒加载 `ContextMenu`（`复制图像下载图像`）+ 分享复制触发 `DeferredToaster`（`[data-sonner-toast]`），均 0 JS 错误。

---

# 第四轮：逐路由 React SSG 静态预渲染与 `hydrateRoot` 水合（2026-11-21）

针对上一阶段提出的逐路由静态直出诉求：不再使用手写的 `#ssg-shell` 占位 DOM，而是直接在 Vite 生产构建阶段对全部可访问路由执行 **React 19 `renderToString` 预渲染**，浏览器端由 `hydrateRoot` 接管水合；同时把单张照片的 OG meta / `<title>` 内嵌进各自的静态 `.html`，让 `/photos/*` 从 Cloudflare Pages Function 迁回静态资源 CDN 缓存。

## 改了什么

1. **逐路由 Vite SSG 插件与单一路由真源**：
   - 新增 `apps/web/src/entry-server.tsx` 与 `apps/web/plugins/vite/ssg-prerender.ts`。`entry-server.tsx` 直接复用 `createAppRoutes()`（源自 `generated-routes.ts` 单一真源）并在 `initSsrContext` 时一次性解析全部 `route.lazy()`；构建末尾校验 `getDiscoveredRoutePaths()` 的每条路由要么完成预渲染，要么显式登记在 `SKIPPED_PRERENDER_ROUTES`（仅 `/manifest` 调试大表保留走 SPA 回退；漏配任何新页面会在构建期直接报错）。
   - `closeBundle` 以 `AFILMORY_SSR_BUILD=1` 打包 `entry-server.mjs`，构建期渲染 **371 条路由**（`/`、`/map` 与 369 份 `/photos/<id>.html`，`photos/*.html` 原始总计 `9.09 MB`），仅替换配平的 `<div id="root">...</div>`（保留 `<body>` 内任何其余标签与脚本），并剥离 React 19 `renderToString` 吐在 `#root` 顶部的重复 `<link rel="preload" as="image">`。
   - **静态 `/map` 骨架屏（`noindex`）**：`apps/web/src/pages/map/index.tsx` 按 `DESIGN.md` 语义 token 重写 `ExploryPageSkeleton` / `ExploryPageError`（玻璃态返回画廊 `<a>` 与地图加载卡片，移除 `opacity: 0` 延时动画并用 `useIsClient()` 门控），由 `ssg-prerender.ts` 输出 `dist/map.html`（就地替换 `<meta name="robots">` 为 `noindex`，注入 `map` chunk 的 `modulepreload`），同时在 `public/_headers` 恢复 `/map` 缓存头，消除切地图前的暗屏等待。
   - `inline-main-css.ts` 为内联 `<style>` 添加显式 `data-inline-main-css` 标记，首页 `index.html` 保留主 CSS 内联（`216,117 B` 与参照产物逐字节一致），同时保留 `assets/index-*.css` 供 `/map` 与 369 份 `/photos/*.html` 外链复用（1 年 immutable）；`ssg-prerender.ts` 通过精确匹配 `data-inline-main-css` 替换外链（缺失即报错），并通过 `generateBundle` 的 `facadeModuleId` 注入对应 chunk 的 `modulepreload` 与 preview 图 `preload`。
   - **SPA 回退路由防闪（含 `/?…` 筛选页取舍）**：`ssg-prerender.ts` 仅向首页 `dist/index.html` 的 `</head>` 前注入极小同步守卫脚本，在非 `/` 路径（如 `/manifest`、404）或带 query string（`/?cameras=…` 筛选页）时立即通过 `<style id="ssg-fallback-hide">#root{display:none}</style>` 隐藏首页 36 张未筛选照片与假滚动条（背景维持深色 `rgb(28, 28, 30)`，待 JS + 48 KB manifest 就绪后由 `main.tsx` 移除守卫渲染）。将 `/?…` 纳入守卫是有意取舍（宁可短时纯黑，也不闪现未筛选图片；若偏爱先展示默认图片再切到筛选结果，把守卫条件收窄为 `p !== '/'` 即可）。
2. **SSR 瀑布流与 `masonic` 像素对齐、零帧切手与无 JS 导航**：
   - `MasonryView.tsx`：桌面端补充传递 `maxColumnCount` 对齐 8 列上限；统一使用基于 `document.body.clientWidth` 的 `getViewportContentWidth()`（消除滚动条宽度口径差），并在 `Masonic.tsx` 导出 `computeColumns` 给 `itemHeightEstimate` 与 SSR 瀑布流共用；`!isClient` 时按移动端（`<1024px`）/ 桌面端（`>=1024px`）两段 `@media` 扫描 `computeColumns`，以 `.ssr-m-w`（`container-type: inline-size`）+ `@container` 按 `round(down, ...)` 与列分配签名自动切片合并，同时把 `round(down, ...)` 收进 `@supports (width:round(down,1px,1px))`，使 Chrome &lt;125 / Firefox &lt;118 正常使用 `calc(...)` 回退。
   - **消除切换闪烁与虚高滚动条**：`Masonic.tsx` 新增 `getItemHeight` 与 `initialWidth` 支持（`MasonryView.tsx` 按 `Math.round(colW / aspectRatio)` 与 `containerWidth` 预置 `createPositioner`），使 `<Masonry>` 首次 commit 即处于 phase-two（零 `visibility:hidden` 首帧空窗）；同时将 `itemHeightEstimate` 改为数据驱动的 `mean(1/aspectRatio) * actualColW + gutter`（1440px 下不再因 `400px` 硬编码产生 `28,652 px` 虚高），实测 `1440×900` 首帧与滚动到底部总高均稳定在 `17,037 px`（跳变 `0 px`）。
   - `PhotoViewer.tsx`：零 JS / 未水合时左上角提供 `<noscript>` 回画廊链接，右上角关闭按钮以 `<a href="/">` 替代禁用无响应的 `<button>`，水合后无缝切回 `ActionButton`。
3. **无缝 `hydrateRoot` 与全路由零不匹配**：
   - `apps/web/src/main.tsx`：`bootstrap()` 校对 `#root[data-ssg-route]` 路由一致后并行准备 manifest、i18n 与匹配的懒路由模块（`matchRoutes` + `route.lazy()`），调用 `hydrateRoot`（query filter 首页或 404 回退 `createRoot`）。
   - `apps/web/src/i18n.ts` 与 `apps/web/src/providers/i18n-provider.tsx`：水合首遍锁定 `zh-CN` 不覆盖 `localStorage.i18nextLng`；待整个水合树提交且所有 `useTranslation()` 订阅挂载完毕后，在 `I18nProvider` 的 `useEffect` 里 `startTransition` 对齐用户保存语言（例如 `en`）。
   - `apps/web/src/atoms/viewport.ts`、`apps/web/src/lib/exiftool.ts`、`apps/web/src/modules/metadata/ExifPanel.tsx`、`apps/web/src/modules/metadata/ExifRow.tsx` 等：引入 SSR 默认视口（`1440×900`）与 `useIsClient()` 门控；照片页 SSR 直出预览图与 EXIF 面板（桌面显示、窄屏由 `hidden ... lg:flex` CSS 隐藏），去除 `PhotoViewer.tsx` 两处非懒加载 `<Suspense>` 以防并发水合与 `EventProvider` 竞态，禁用 `exiftool.ts` 在 SSR 阶段的模块求值加载。
4. **`/photos/*` 脱离开销中间件与静态缓存 + Meta 构建期断言**：
   - `ssg-prerender.ts` 在构建期直接调用 `packages/builder/src/plugins/og-image-storage/photo-text.ts` 的 `buildPhotoOgText`，将单张照片的 `<title>`、`meta[name=description]`、`og:*`、`twitter:*` 写入各自的 `photos/<id>.html`，并对每张照片断言实际命中的替换条数（含 OG 图 `10` 条 / 不含 `8` 条），缺失任何 meta 或 `<title>` 立即构建报错。
   - `apps/web/public/_routes.json` 从 `["/photos/*", "/og/*"]` 收窄为仅 `["/og/*"]`（中间件仅保留 `/og/:photoId` 302 跳转）；`apps/web/public/_headers` 为 `/`、`/*.html` 与 `/photos/*` 配置 `public, max-age=0, must-revalidate` + 静态 CDN ETag 缓存。

## 产物字节对比（`bytes-accounting.mjs`，`main` vs `feat/react-ssg-hydration` 最终构建）

| 维度 | `main` (`br11`) | `react-ssg` (`br11`) | 变化 |
| --- | ---: | ---: | ---: |
| 首页 `index.html`（含内联 CSS + `@container` `masonic` SSR 网格 + 回退守卫） | 26,537 B | 29,564 B | +3,027 B |
| 入口 + modulepreload JS（含 SSR/hydration、`getItemHeight` 预置与 CSS 瀑布流逻辑） | 195,526 B | 197,393 B | +1,867 B |
| `photos-manifest.*.json` | 48,765 B | 48,765 B | 0 B |
| **首页关键路径总计（TOTAL）** | **270,828 B** | **275,722 B** | **+4,894 B（+1.81%）** |

各静态页面 HTML 实测体积：`index.html` `264,431 B raw / 29,564 B br11`、`map.html` `6,222 B raw / 1,808 B br11`、`photos/20261104-LKXG5370.html` `24,893 B raw / 7,616 B br11`（`dist/manifest.html` 不再生成）。

## 实测 Web Vitals A/B（本地 `spa-server.mjs`，`1440×900`，各 3 次独立冷会话中位数）

| 页面与条件 | 基线 `main`（FCP / LCP / CLS / TBT） | `react-ssg`（commit `576b4bf8`） | 结论 |
| --- | --- | --- | --- |
| `/`（非节流） | 428 ms / 1,188 ms / 0 / 38 ms | 328 ms / 364 ms / 0 / 55 ms | LCP **−69.4%**, FCP **−23.4%**, CLS=0 |
| `/photos/20261104-LKXG5370`（非节流） | 516 ms / 1,116 ms / 0.0001 / 81 ms | 136 ms / 856 ms / 0.0001 / 87 ms | FCP **−73.6%**, LCP **−23.3%**, CLS=0.0001 |

> 注：上表 Web Vitals 采样于早期 commit `576b4bf8`；最终代码在完成 `generated-routes` 单一真源、预渲染 `/map` `noindex` 骨架屏、统一 `computeColumns` + `@container` 瀑布流、预置 `positioner` + `@supports` 回退及 SPA 回退 `<head>` 守卫后重测了 32 宽度边界几何一致度、首帧零 `hidden` 切手、旧版 CSS 回退、`/map` 骨架屏与零 JS/水合回归（见下），未重复重采该非节流 Web Vitals 耗时。

## 验证摘要

- **最终构建与静态校验**：`@afilmory/web` `vite build`（371 条路由预渲染 + 路由全覆盖断言 + meta 替换数断言 + 配平 `#root` 检查）、全仓 `pnpm type-check`、改动文件定向 `eslint`（0 error）、`pnpm og:middleware -- --check`、`check-block-comments.mjs`（388 文件）、`assert-manifest-fields.mjs`（369 照片一致性）与 `INLINE_MAIN_CSS=0` 参照差分 `check-inline-css.mjs`（`216,117 B` 主 CSS 逐字节一致）均通过；确认 `dist/map.html`（含单条 `<meta name="robots" content="noindex">`、无 `opacity:0`、含 `<a href="/">`）存在、`dist/manifest.html` 不存在、`.ssr-m-w` 使用 `@container` + `@supports (width:round(down,1px,1px))`、`<head>` 仅在首页注入 `#ssg-fallback-hide` 守卫。
- **首帧 `masonic` 切手与容器高度稳定性（Chromium `MutationObserver` + 滚到底部实测）**：
  - `1440×900`：首次 commit `33` 个 `[role="gridcell"]` 中 `hiddenCount = 0`；初始与滚到底部容器高度均为 `17,037 px`（跳变 `0 px`）。
  - `1920×1080`：`59` 个 cell，`hiddenCount = 0`，容器高度 `11,573 px`。
  - `390×844`：`19` 个 cell，`hiddenCount = 0`，容器高度 `28,300 px`。
- **全边界 32 宽度 SSR vs `masonic` 几何一致度与 `--cw` 回退（Chromium 实测）**：
  - 覆盖 10 个断点（`312 / 466 / 620 / 774 / 928 / 1024 / 1266 / 1520 / 1774 / 2028`）的 `bp - 1 / bp / bp + 1` 及 `390 / 1440` 共 **32 个视口宽度**（`311`–`2029 px`）：**32/32 全部 `0` 列错配**、`maxDx = 0.00 px`、`maxDw = 0.00 px`、`maxDy` 介于 `0.31 px`–`2.56 px`；重点视口 `390×844`（`maxDy=0.61 px`）、`1440×900`（`maxDy=1.47 px`）。
  - 移除 `@supports (width:round(down,1px,1px))` 后在 `1440×900` 实测：`calc(...)` 回退正确铺出 5 列（`colCount=5`，`minWidth=284.8px`）。
- **`/map` 骨架屏与 SPA 回退防闪 / Zero-JS 实测**：
  - `/map` 拦截主 JS（`1440×900` 与 `390×844`）无 `#ssg-fallback-hide`，首帧即见 `opacity: 1` 玻璃态加载卡片与左上角 `a[href="/"]` 返回入口、`robots="noindex"`；放行 JS 在桌面 / `390×844` / `/map?photoId=20261104-LKXG5370` 均渲染 `.maplibregl-map` 且 0 报错。
  - `/manifest`、`/?cameras=SONY%20ILCE-7RM5` 与 `/nonexistent-404` 拦截主 JS 时命中 `#ssg-fallback-hide`（`#root` `display:none`，背景 `rgb(28, 28, 30)`），`/` 保持 36 张可见；`/` 与 `/photos/20261104-LKXG5370` Zero-JS 下均可用 `<noscript>` / 关闭 `<a>` 返回画廊。
- **零水合报错实测**：`/`、ASCII/CJK `/photos/<id>`、`/map`（桌面/移动/深链参数）、SPA 回退 `/manifest`·`/?cameras=SONY%20ILCE-7RM5`·`/nonexistent-404`、移动端 `390×844` `/` 与 `/photos/<id>`、以及 `localStorage.i18nextLng='en'` 首页水合，全部 **0 `[hydration]` / React #418/#423/#425 / 控制台 error**。

---

> **后续变更（2026-11-21，分支 `refactor/drop-pages-functions`）**：`/og/:photoId` 与整套 Cloudflare
> Pages Functions 已删除（`functions/`、`_routes.json`、`og:middleware`、`cloudflare-middleware`
> vendor）。分享弹窗的预览/下载改用运行时 manifest 的 `previewUrl`；`/photos/:id` 的 OG meta 仍由
> `ssg-prerender` 写进静态 HTML。上文提到的 `/og` 302、`_routes.json` 的 `include: ["/og/*"]`、
> `pnpm og:middleware -- --check` 都是当时的状态。
