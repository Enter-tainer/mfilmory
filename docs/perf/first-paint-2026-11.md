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
2. 首屏那 460 KB br 里还有一大半是可以直接砍掉的。

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
`loading="eager"` + `fetchpriority="high"`，其余 `low`。

**这个 4 必须和 `PRELOADED_THUMBNAIL_COUNT` 相等** —— HTML 里 preload 的就是这 4 张，
再多标 high 只会让它们互相抢带宽。（早先试过 8：本地 10 次测量中位数差异在噪声内。）

### 4. CSS 428 KB → 236 KB（`apps/web/src/styles/tailwind.css`）

- **不注册 `@tailwindcss/typography`**：全仓 0 处 `.prose`，但插件会无条件输出约 14.5 KB 规则。
- **daisyui 只保留 base 层**，用 `include:` 白名单（`rootcolor, svg, rootscrollgutter,
  properties, scrollbar, rootscrolllock, join, glass, radius, typography`）。站内的
  UI 组件全部来自 `packages/ui`（radix + tailwind-variants），用到 daisyui 的只有
  theme 变量（`--color-primary` / `--color-base-100` …），组件层整层用不上。

### 5. manifest 裁掉只对构建期有意义的字段

`FIELDS_UNUSED_BY_WEB = ['digest', 'ogImageUrl']`：

| 字段 | 占整份 manifest brotli 后的比例 | 浏览器里有谁读 |
|---|---:|---|
| `digest` | **13.4 KB / 64.3 KB（21%）** | **0 处**，只有照片流水线自己用 |
| `ogImageUrl` | 1.3 KB | 只有构建期的 Cloudflare 中间件用 |

`digest` 是内容 sha256 的前缀，64 位随机 hex，**几乎不可压缩**，所以它单项就占了五分之一。

源文件 `apps/web/src/data/photos-manifest.json` **完整保留**：`scripts/cleanup-stale-assets.ts`
和 OG 中间件读的都是源文件，只有下发给浏览器的产物被裁。

> **不要往这个列表里加运行时字段。** 首屏网格/列表/筛选/地图/大图 EXIF 面板读到的每一个
> 字段都必须留着 —— 裁掉 `location` 会让列表视图的位置行和 Cmd-K 的地点搜索静默失效，
> 裁掉任何一条 exif 会让 hover 卡、筛选和 EXIF 面板缺数据。回归防线见下面「验证」一节的
> 逐字段断言。

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
| HTML | 1 905 B | 1 911 B | +6 B |
| CSS | 42 238 B | 26 843 B | **−36.4%** |
| 入口 JS（含 modulepreload） | 321 008 B | 301 217 B | **−6.2%** |
| 　其中入口 chunk 原始字节 | 968 986 B | 884 541 B | −8.7% |
| manifest | 64 308 B | 49 654 B | **−22.8%** |
| 字体 woff2（已压缩，br 几乎无收益） | 29 404 B | 29 404 B | 0 |
| **首屏合计（br11）** | **458 863 B** | **409 029 B** | **−10.9%** |
| 首屏 preload 的图片 | 0 张 | 4 张 | |
| 首屏 `eager` + `high` 的图片 | 0 张 | 4 张 | |

原始字节合计：2 543 781 B → 2 202 587 B（−13.4%）。

首屏请求数不变：preload 的 4 张被 `<img>` 复用，不会重复下载。

## 试过又否掉的两个方案

留在文档里是因为它们**看起来**都很划算，下次别重做一遍。

1. **viewer chunk 改成「有意图才预取」**：hover/focus 某张照片时才 `import()` viewer 路由，
   `window.load` 之后空闲再兜底。本地看起来能省一条 190 KB br 的早期请求，但它**删掉了
   main 本来有的 `requestIdleCallback` 预取**，用户在首屏稳定后立刻点第一张照片时
  反而要多等一次 chunk 下载 —— 对「点进去看图」这个核心路径是净回归。已回滚到 main 的行为。

2. **manifest 拆成 index + 按需 detail**：首屏只下发网格字段，完整的 `exif` / `location` /
   `toneAnalysis` / `s3Key` 等放进第二个文件，打开大图时再取。

   实测各字段的 brotli-11 边际成本之后这个方案站不住：

   | 字段 | 边际 br | 首屏有没有人读 |
   |---|---:|---|
   | `exif`（完整） | 14 297 B | 有（hover 卡、筛选、EXIF 面板） |
   | `digest` | 13 402 B | **没有** |
   | `location` | 8 188 B | 有（列表视图位置行、Cmd-K 地点搜索） |
   | `thumbHash` | 8 080 B | 有（网格模糊占位） |
   | `toneAnalysis` | 2 790 B | 仅 EXIF 面板 |
   | `ogImageUrl` | 1 276 B | **没有** |

   能挪进 detail 的只有 `s3Key` + `toneAnalysis` + `regions` 三项，合计 **3.9 KB br**；
   为此却要引入一套异步合并机制（loading/失败重试/对象替换触发记忆化重算），
   而且一旦顺手把 `location` 或 exif 字段也挪走就是静默功能回归。
   **对比之下，只裁 `digest` + `ogImageUrl` 就拿到 14.7 KB br，零代码、零新失败模式。**
   结论：拆分不划算，已回滚成单份 manifest。

## 验证

- `pnpm type-check` 全绿。**新增**：`apps/web/tsconfig.json` 的 `include` 加上了 `./plugins/**/*`
  —— 之前 Vite 插件目录完全不在类型检查范围内，插件里的笔误 CI 抓不到。
  连带修了两处既有问题：`plugins/vite/ast.ts` 里 `@yuku-toolchain/types` 与 `@babel/types`
  的 AST 类型不兼容，`scripts/photo-loader.ts` 指向了不存在的 `packages/builder/src/types/photo.js`。
- **manifest 逐字段断言**（`.perf/assert-manifest-fields.mjs`）：把源 manifest 和 dist 里
  实际下发的那份逐照片逐字段比对 —— 369 张照片、8 867 个顶层字段、14 919 个 exif 子字段，
  除允许裁剪的 `digest` / `ogImageUrl` 外**完全一致**。
- **路由矩阵回归**（`.perf/verify-routes.ps1` + `diff-routes.mjs`）：`/`、
  `/?cameras=SONY ILCE-7RM5`、`/photos/:id`（深链）、`/map`、`/manifest` 五条路由，
  两套构建各跑一遍，每条路由用独立浏览器 session（不吃 HTTP 缓存），
  并用 `--init-script` 在页面脚本之前接管 console 与 uncaught / unhandledrejection /
  资源加载失败（`agent-browser console` 的缓冲语义不可靠，同一页面两次运行抓到的条数不同）。
  快照拍在**稳定态**（无 pending 图片 + 文本签名连续 3 次不变），否则比的是渐进渲染的时序噪声。
  结果：opt 侧 0 error / 0 uncaught / 0 unhandledrejection / 0 资源加载失败 / 0 破图，
  `/map` marker 数一致，渲染文本与基线逐字符一致（`/manifest` 页因新增一枚说明徽标而有意不同）。

## 代价

- 非 `/` 的落地页（主要是直接访问 `/map`）用不上那 4 张 preload，会白下载约 70 KB。
  静态 HTML 无法按路径区分，权衡后取 4 张（首屏第一行最少也有 4-8 张）。
- 首屏 CSS 小了 36%，但 daisyui 组件层不再输出：将来如果真的要用 daisyui 的组件类，
  得先把它加回 `include:` 白名单，否则样式静默不生效。
