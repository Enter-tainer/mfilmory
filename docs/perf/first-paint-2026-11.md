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

# 第二轮：把图片请求从关键路径上摘下来（2026-11-14）

第一轮之后线上 FCP 2 144 ms / LCP 3 324 ms（5 次中位数）。看 waterfall 后剩下的链条是：

```
HTML 1387 → manifest 2057 → JS 执行 → 缩略图 2191 → LCP 3324
```

图片的 URL 只存在于 manifest 里，所以浏览器必须等 **HTML → manifest → JS 执行 → React 渲染**
这一整条链走完才发起第一张缩略图请求。这条链在线上约 800 ms。

## 改了什么

1. **把首屏缩略图 preload 进 HTML**（`manifest-inject`）
   构建期已经知道 manifest，直接把默认排序（拍摄时间倒序，和 `usePhotoViewer` 的排序一致）前 4 张的
   `thumbnailUrl` 写成 `<link rel="preload" as="image" fetchpriority="high">`。
   图片于是和 manifest/JS **并行**下载，而不是排在它们后面。

2. **网格前 8 张提优先级**（`MasonryPhotoItem`）
   原来所有缩略图都是 `loading="lazy"` + 同优先级，浏览器把 ~20 个请求平摊带宽，
   LCP 那张要等所有请求各分到一勺。现在前 8 张（第一屏大致范围）`loading="eager"` +
   `fetchpriority="high"`，其余 `low`。

3. **viewer chunk 改成「有意图才取」**（`lib/prefetch-viewer.ts`）
   第一轮用的 `requestIdleCallback` 在 live 上触发得很早，190 KB 的 `_photoId_` chunk 仍然和缩略图
   同时下载。现在两个触发条件先到先得：hover/focus 某张照片（明确意图），或 `window.load`
   之后浏览器空闲（兜底）。

## 结果（本地零延迟 A/B，同一 commit 构建）

| 指标 | 第二轮前 | 第二轮后 |
|---|---:|---:|
| 第一张缩略图请求发出时刻 | 214 ms（等 manifest+JS） | **9 ms**（HTML 解析即发） |
| FCP（6 次中位数） | 540 ms | 514 ms |
| LCP（6 次中位数） | 1 378 ms | **1 156 ms** |
| 首屏请求数 | 38 | 38（preload 被 `<img>` 复用，无重复下载） |

本地 manifest+JS 链只有 200 ms，所以只体现为 ~220 ms 的 LCP 收益；**线上那条链约 800 ms**，
按同样的机制预期 LCP 降到 ~2.5 s。

验收：`document.body.textContent` 与基线逐字符一致；`/`、`/?cameras=…`、`/photos/:id`、`/map`
（26 markers）、`/manifest` 全部 0 console error；preload 的 4 张确实被 `<img>` 复用
（`initiator: link`，无重复请求）。

## 代价

非 `/` 的落地页（主要是直接访问 `/map`）用不上那 4 张 preload，会白下载 ~70 KB。
静态 HTML 无法按路径区分，权衡后取 4 张（首屏第一行最少也有 4-8 张）。
