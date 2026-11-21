# mfilmory

**Afilmory 的纯静态 Web 前端 fork**：只保留「照片画廊 SPA + 照片处理流水线」，不带任何后端、SaaS、SSR 宿主或移动端。

- 上游：<https://github.com/Afilmory/Afilmory>
- 本 fork 的基线：`cdeada39`（upstream/main，2026-11-13 同步；上游自 `c392e065` 起的 40 个提交全是 iOS 端改动，`apps/web` / `packages` 零变化）
- 许可证：沿用上游 `LICENSE` —— **Attribution Network License (ANL) v1.0**：库/可复用模块为 MIT，应用（Project Code）为 AGPL-3.0-or-later **附加 §7 的 UI 署名要求**；本 fork 的修改同样按该许可发布
- ⚠️ ANL §4.1 要求在交互界面的显眼位置（About / Footer / Settings 等）展示 `Powered by … — Source … — License: AGPL-3.0-or-later`。当前上游 SPA 源码里**没有**内建的署名位置（`git grep "Powered by" apps/web/src` 为空），公开部署前建议在 About/Footer 里补一处

## 保留了什么

| 路径 | 说明 |
| --- | --- |
| `apps/web` | Vite 8 + React 19 单页应用 —— 画廊 UI、查看器、地图、i18n、PWA manifest |
| `packages/builder` | 照片流水线 CLI：S3 / 本地 / GitHub / Eagle 同步 → EXIF / 缩略图 / blurhash → `photos-manifest.json` |
| `packages/data` | `PhotoLoader`，把注入的 manifest 包装成查询结构 |
| `packages/{typing,ui,hooks,utils,viewer-motion,webgl-viewer}` | SPA 依赖的共享包（WebGL 查看器、视图动效、UI 原语等）；`packages/sdk` 仍保留但 SPA 已不依赖（见下） |
| `locales/app` | SPA 文案（en / zh-CN / zh-HK / zh-TW / jp / ko） |
| `site.config.ts` + `config.json` | 站点展示配置（站名、作者、主题色、地图） |
| `builder.config.ts` + `.env` | 照片来源与凭据（S3 兼容存储 / 本地目录） |
| `DESIGN.md` | `apps/web` + `packages/ui` 的设计系统规范 |
| `scripts/` | `preinstall` / demo 数据 / OG 图与 favicon 生成等构建期脚本（均为跨平台 Node 实现） |

## 插件与构建期钩子

仓库里的"插件"全在仓库内，分三层：

**1. SPA 的本地 Vite 插件** — `apps/web/plugins/vite/`（由 `apps/web/vite.config.ts` 装配）

| 文件 | 作用 |
| --- | --- |
| `manifest-inject.ts` | 把 `photos-manifest.json` 外置成内容 hash 命名的 `photos-manifest.<hash>.json`，HTML 里只留 `preload` + URL；同时注入首屏缩略图的 `<link rel="preload" as="image">` 与图片 CDN 的 `preconnect`（`AFILMORY_EMBED_MANIFEST=true` 时退回整份内联成 `<script id="manifest">window.__MANIFEST__ = …`） |
| `site-config-inject.ts` | 注入 `window.__SITE_CONFIG__`（`site.config.ts` + `config.json`） |
| `photos-static.ts` | 静态站的照片数据 / 路由辅助 |
| `og-image-plugin.ts` | 构建期生成站点分享图（一张满幅照片）+ 全部 favicon（`logo.jpg` + `sharp`），并写 og/twitter meta |
| `inline-main-css.ts` | 把主 CSS 内联进首页 `index.html` 消除 render-blocking RTT，并在逐路由 SSG 时保留 `assets/index-*.css` 供子页面外链复用 |
| `ssg-prerender.ts` | 在 `closeBundle` 用 `src/entry-server.tsx` 对 `/`、`/map`、`/manifest` 与全部 `/photos/<id>.html` 做逐路由 React SSG 预渲染，并调用 `buildPhotoOgText` 为每张照片写入独立 `<title>` 与 OG meta；客户端由 `hydrateRoot` 水合 |
| `feed-sitemap.ts` | 生成 `feed.xml` / `sitemap.xml` |
| `locales-json.ts` | 把 `locales/app/*.json` 的扁平点号 key 展开成嵌套对象（Windows 路径比较已修） |
| `i18n-hmr.ts` / `locales.ts` | 文案热更新辅助（`locales.ts` 是死代码，上游如此） |
| `deps.ts` | 手动分包（react / i18next / heic-to） |
| `ast.ts` | `tw` 模板字符串压缩宏（unplugin-ast） |

**2. `packages/builder` 的照片流水线插件** — `packages/builder/src/plugins/`

- `storage/`：local / s3 / b2 / github / eagle 五种存储 provider
- `thumbnail-storage/`：缩略图上传
- `geocoding.js`：照片地点反查（`geocodingPlugin`）
- `github-repo-sync.js`：把 manifest / 缩略图写回 GitHub 仓库
- `og-image-storage/`：**分享图插件**。卡片就是照片本身（按原图比例、横边上限 1200 的 WebP，不裁切、**不画**黑底/站名/标题），文字交给分享平台原生渲染。每张照片页 `/photos/:id` 的 `og:image` / `twitter:image` / `og:title` / `og:description`（多行 `📸 / 📝 / 📅 / 🗺 / 📍` EXIF 明细）、`<title>` 和单行 `meta[name=description]` 已在构建期由 `ssg-prerender.ts` 调用 `photo-text.ts` 直接写进静态 `photos/<id>.html`，无需边缘 Worker 改写；`vendors/cloudflare-moddleware.ts` + `vendors/templates/cloudflare-middleware.njk` 生成的 **Cloudflare Pages 中间件**只负责把分享弹窗用的站内路径 `/og/:photoId` **302** 到 R2 上的 `.afilmory/og-images/*.webp`（运行时 manifest 裁掉了 `ogImageUrl`，这样既不用下发给浏览器、也不会让图片破图）
  - 文案规则在 `packages/builder/src/plugins/og-image-storage/photo-text.ts`；照片直放（裁切/缩放）在 `photo-og.ts`
  - 产物写到仓库根 `functions/_middleware.ts`，由 `builder.config.ts` 里的 `ogImagePlugin({ vendor: { type: 'cloudflare-middleware', storageURL } })` 触发
  - 该文件是**构建产物，不提交**（`.gitignore` 只忽略这精确一个路径）；内容由 `config.json` 的 `url` + `builder.config.ts` 的 `storageURL`（通常即 `.env` 的 `S3_CUSTOM_DOMAIN`）决定。`pnpm build` 会自动生成，也可以用 `pnpm og:middleware` 单独重生成（`-- --check` 校验磁盘上的文件是否最新，**并校验中间件处理的路径都写进了 `_routes.json` 的 include**；`--storage-url=…` 临时覆盖 CDN 地址）
  - 部署到 Cloudflare Pages 时 **project root 必须是仓库根**（或显式 `--functions-directory`），否则 `functions/` 不会被带上，`/og/:photoId` 跳转会失效
  - 卡片长什么样（旧卡片 vs 照片直放、三端原生渲染、不同构图、首页卡片）：`docs/og/photo-straight-cards.webp`

**3. 根级本地 ESLint 插件** — `plugins/eslint/`（i18n JSON 校验、no-debug、package.json 校验、递归排序），由 `eslint.config.mjs` 加载。

> 已删除：根 `plugins/vite/ast.ts` —— 只有已删的 `apps/docs` 和 `be/apps/dashboard` 引用它，`apps/web` 自带一份同功能实现。

## 去掉了什么

- `be/` —— SaaS 后端（Hono API、dashboard、Drizzle DB、Redis、task-queue、OAuth gateway）
- `apps/ssr` —— Next.js SSR 宿主（服务端注入 manifest、动态 OG/SEO、自己的 drizzle 库）
- `apps/mobile` —— 原生 Swift/UIKit iOS App
- `apps/site` / `apps/docs` / `apps/landing` / `apps/promo` —— Astro 官网、文档站、推广页
- `docs/`、`.specstory/`、Dockerfile / docker-compose、以及只服务上述部分的 CI workflow
- 依赖后端才有意义的能力（登录、点赞/评论、后台管理）不是运行时降级，而是**直接删掉了**：`apps/web` 里不再有会话 provider、评论/Reaction、登录入口，也没有 `@tanstack/react-query` / `@afilmory/sdk` / `swr` / `immer` 依赖（TECH-90，入口 JS brotli −14.6 KB）。分享弹窗保留（复制链接 / 系统分享 / 下载原图与预览图）。

## 快速开始

```bash
pnpm install          # 会自动 seed config.json / builder.config.ts（见 scripts/preinstall.mjs）
```

三份配置，各司其职：

| 文件 | 作用 | 是否入库 |
| --- | --- | --- |
| `config.json` | 展示配置：站名、描述、作者、主题色、地图 | 否（`config.example.json` 是模板） |
| `builder.config.ts` | 照片来源：S3 / R2 / 本地目录、并发、插件 | 否（`builder.config.default.ts` 是模板） |
| `.env` | 凭据：`S3_*`、`GIT_TOKEN`、`MAPBOX_TOKEN` | 否 |

`config.json` 里的 `author.avatar` 建议指向 `apps/web/public/` 下的**本地小图**（例如 `/avatar.webp`），
不要直接引用头像托管站点的原图：它会被渲染成 28–64 CSS px，一张 300×300 的 JPEG 是 16.5 KB，
而 96×96 的 WebP 只要 2.9 KB（−82%），且本地文件不依赖第三方域名的可用性和 TLS 握手。
仓库里的 `apps/web/public/avatar.webp` 就是这样一个例子（96×96，2.9 KB）。两处渲染
（`PageHeaderLeft` / `MasonryHeaderMasonryItem`）都显式带了 `width`/`height`、
`decoding="async"` 和 `fetchPriority="low"`，避免它跟首屏 LCP 缩略图抢带宽。

### 路线 A：先跑起来（本地 demo，不需要 S3）

```bash
pnpm build:demo      # 拉 demo 照片 → 写入 apps/web/public/photos → 本地 provider → 生成 manifest → 构建
pnpm preview         # 预览 dist/
```

### 路线 B：用你自己的照片（S3 兼容存储 / R2）

```bash
cp config.example.json config.json     # 或手写；pnpm install 也会自动做
cp builder.config.default.ts builder.config.ts
# 编辑 .env（S3_BUCKET_NAME / S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_CUSTOM_DOMAIN）
pnpm build:manifest   # 扫描存储 → 缩略图/blurhash/EXIF → apps/web/src/data/photos-manifest.json
pnpm build            # 把 manifest 外置成 photos-manifest.<hash>.json，产物在 apps/web/dist
```

### 本地缓存（不进仓库）

| 路径 | 作用 |
| --- | --- |
| `apps/web/src/data/photos-manifest.json` | 照片清单源文件，由 `build:manifest` 产出；构建时会被读出、裁掉只对构建期有意义的字段（`digest` / `ogImageUrl`）后外置成 `photos-manifest.<hash>.json` |
| `apps/web/public/thumbnails/` | 缩略图本地缓存：builder 靠它判断「这照片处理过、可跳过」 |

两者都在 `.gitignore` 里（体积大 / 因站点而异），所以**全新克隆后第一次 `pnpm build` 会把存储里的照片全部处理一遍**（并重新上传缩略图 / OG 图到存储）。日常增量构建只需要保留这两个缓存即可。

### 网络重试、并发池与失败恢复

- `builder.config.ts` 的 `system.processing`：`cpuConcurrency`（CPU 并发槽，默认 `'auto'`）、`sharpConcurrency`（单任务 libvips 线程，默认 `'auto'`）、`cpuWorkerCount`（纯 CPU 子进程数，`'auto'` 隔离 `libuv` 饥饿，`0` 为同进程）、`networkConcurrency`（网络池默认并发上限 `16`；配置了 `storage.downloadConcurrency` / `storage.uploadConcurrency` 时以 storage 为准，构建期统一由 `NetworkPool` 单层限流）。
- `builder.config.ts` 的 `storage` 下（S3 / B2 / GitHub 通用）：
  - `maxAttempts`（默认 `3`）、`retryBaseDelayMs`（`300`）、`retryMaxDelayMs`（`4000`）、`uploadTimeoutMs`（`60000`，`0` 表示不限制）。
  - 只对瞬时错误重试（网络错误、超时、408/425/429/5xx）；401/403/404/422 直接失败。
  - 上传最终失败的照片会写进 manifest 的 `lastProcessSuccess: false` / `uploadFailures`，构建结束时会汇总；**下一次增量构建会自动重新处理这些照片**。

### 图片格式

| 产物 | 格式 | 参数 | 说明 |
| --- | --- | --- | --- |
| 缩略图（网格，`500px` 宽） | **AVIF 10-bit** | `quality: 70`, `effort: 6`, `bitdepth: 10` | 网格一格最多显示 500 物理像素（手机 150 CSS@3x、iPad/Mac 250 CSS@2x、4K@100% 472px），所以 500 正好。实测 SSIMULACRA2 83.5 vs 旧 600px JPEG q100 的 85.6（98% 观感），体积 32KB vs 248KB |
| 占位图（阅览器，长边 `2560`） | **AVIF 10-bit** | `quality: 45`, `effort: 6`, `bitdepth: 10` | 点开大图时先显示它，原图下完无缝替换。4K 全屏实测 S2 27.3 / XPSNR 37.8 / SSIM 0.80，旧 600px JPEG q100 占位只有 −16.1 / 33.9 / 0.70，而体积还小 17%。按**长边**而非宽度缩放，竖图不会白付 1.5 倍像素 |
| OG 卡（分享图） | **WebP** | `quality: 88` | 按原图比例、**横边上限 1200**（>1200 缩、≤1200 不放大、不裁切），**无底色无文字**；站点级是独立的 1200×630 横幅（从近期横向照片里挑一张）。PNG 时代 421KB → WebP ~30–180KB。**OG 永远不要用 AVIF**：跨平台实测只有 Facebook 支持 |

编码器是 sharp（libvips 8.18.7 → libheif 1.23.5 → libaom 3.15.1）。`effort` 是 libaom 速度档（0–9），6 比默认 4 慢但同质量更小。**产物文件名不含编码参数**（`<photoId>.avif`），所以「参数变了要不要重编」完全靠 `apps/web/src/data/.cache/asset-signatures.json` 里的签名：入口门禁（`filterTaskImages`）和编码函数都以它为准，只看「文件在不在」是不够的。

- **10-bit（Main10）而不是 8-bit**：源图本身是 8-bit，10-bit 不会凭空多出信息，但 libaom 的高位深量化步进更细。8 张样图按**各自当前的 SSIMULACRA2** 逐图对齐后，**8 张全部变小**：占位图几何平均 −2.9%（单张 −0.6% ~ −7.1%）、缩略图 −4.4%（−1.5% ~ −9.4%）；换成**等字节**看，同一批图 10-bit 平均高 +0.64 / +0.70 分 SSIMULACRA2（两个尺寸档 `8/8` 全为正），说明不是「q 映射变宽了」而是真的 RD 改善。代价是编码慢约 10–15%（占位图 1.77s → 2.04s/张）。
- **带 alpha 的源图回退 8-bit**（`image/avif-bitdepth.ts`）。Safari 对「10-bit + alpha」的 AVIF 有过不渲染的报告（WebKit #245669，转 Apple radar 后无公开结论）；本站现有 369 张都是 JPEG，不受影响，但 builder 也收 PNG/WebP/TIFF/BMP，所以按 `hasAlpha` 回落，签名仍只记录策略（`...b10.avif`）。
- 同一轮对照扫掉的替代方案（口径：逐图对齐到当前 SSIMULACRA2 后比字节，n 为能匹配上的张数）：SVT-AV1 最好的 preset 10 也要 **+46.5%**（n=6）、rav1e speed 8/10 **+30.5% / +46.3%**（n=8）、WebP effort 6 **+63.7%**（n=6）、ffmpeg libaom `tune=ssim` **+34.9%**（n=6）。`effort` 继续加到 7/8 只再省 1.4%，时间却 +50~67%，不值。
- **色度子采样不要动**：sharp 的 AVIF 默认是 **4:4:4**（不是 4:2:0）。显式设 `4:2:0` 在同 q 下确实少 4~6%，但按同画质对齐后反而**更费**（占位图 +1.9%），所以维持默认。
- 兼容性：AVIF 本身要求 Chrome 85+ / Firefox 93+ / Safari 16.4+（caniuse；Safari 16.1–16.3 只是 partial）。**10-bit（Main10）没有逐版本的门槛数据**，本次只在 Chromium 实测可解码渲染，Safari/iOS **没有真机验证**——上线前应该拿一台 iPhone 看一眼。
- 缩略图文件名/扩展名统一由 `packages/builder/src/image/thumbnail.ts` 的 `getThumbnailFilename()` 提供，不要再硬编码 `.jpg`（上游 #259 就是这么坏的）。
- **换参数（含位深/质量/尺寸）**：`image/media-format.ts` 的 `MEDIA_FORMAT_VERSION` 由 `THUMBNAIL_*` / `PREVIEW_*` 拼成，构建成功后会写到 `apps/web/src/data/.cache/media-format-version`。标记失配时入口门禁会把全部照片重新排队，所以改参数不需要再额外加 `--force-*`（这是 10-bit 这次补上的漏洞：在此之前只看「文件在不在」，换参数会静默复用旧产物）。`--force-thumbnails` 依然可用于强制刷一遍；**别用 `--force-manifest` 刷参数**——它只让照片进队列，缩略图仍会在 `data-processors` 的快路径被判为可复用，结果是占位图换了、缩略图没换的混合状态。
- `--dry-run` 不落盘，也不再写产物签名；否则下次构建会以为磁盘上已经是新参数的产物而永久跳过。
- **同名覆盖 + CDN**：位深变了但文件名没变，所以这次是**原地覆盖**：manifest 逐字节不变，`pnpm cleanup:assets` 也不会删任何东西（它按扩展名判定旧格式）。想让用户真的拿到新字节，必须去 CDN 刷新 `.afilmory/thumbnails/*` 与 `.afilmory/previews/*`（浏览器侧还有 `max-age=86400`）。
- **验证位深只能读容器**：`thumbnailUrl`/`previewUrl` 的 HTTP 头一律是 `image/avif`，位深在 AVIF 的 `pixi` 盒（或 `av1C` 的 `high_bitdepth` 位）里。抽样时对每个 URL 额外带一个 query 命中回源（实测带 query 会 `EO-Cache-Status: MISS`，与下面「忽略 query string」的旧记录不一致，规则可能已经改过），再解析前若干字节，才能区分「源站换了」和「CDN 还在发旧字节」。
- 远端存储里的旧格式对象**不会**自动删（`thumbnail-storage` 把自己的前缀排除在扫描外）：用 `pnpm cleanup:assets` 统计，`-- --delete` 清缩略图，其他目录加 `--directory=.afilmory/og-images --keep=webp`。**先确认线上 manifest 已经不引用旧格式再删**。
- 缩略图 / 占位图 / OG 卡上传时会带 `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`
  （`packages/builder/src/plugins/thumbnail-storage/shared.ts` 的 `MEDIA_CACHE_CONTROL`）。
  这些产物的文件名固定、照片重处理时原地覆盖，所以不能 `immutable`；但完全不带头时浏览器只能用
  启发式缓存（≈10% 文件年龄），新上传的照片几乎每次都要重下。
  **仅对 S3 兼容 provider（s3 / oss / cos）生效**：`b2`、`github`、`local` 三个 provider 会丢弃这个选项。
  **也只对之后上传的对象生效**——存量对象要生效必须重传，用 `pnpm refresh:cache -- --apply`
  （只读出来原样写回、不重编码，先 `--verify` 复查；详见下面「媒体产物的缓存与 CDN 刷新」）。
- **媒体产物的缓存与 CDN 刷新（踩过的坑）**：`S3_CUSTOM_DOMAIN` 指向的域名前面如果还有一层 CDN
  （本站是腾讯 EdgeOne），它在两种情况下会让「桶里已经更新了、线上还是旧的」：
  1. **缓存键忽略 query string** —— 加 `?t=<时间戳>` 或 `cache: no-store` 都绕不过；
  2. **不遵循源站 `Cache-Control` / 覆盖上传后不失效** —— 改了缩略图尺寸或重传了对象，只要它的 TTL
     没过，就一直在发旧内容。实测：给 1107 个存量产物补上 `Cache-Control` 后，源站 S3 直连 HEAD
     全部正确，而公开域名上 `og-images/*.webp`（几乎没人访问、没进缓存）40/40 生效，
     `thumbnails|previews/*.avif`（被大量访问、早已进缓存）0/40 生效，甚至还有 URL 在发
     512px 的老缩略图（桶里已经是 500px）。根因是站点上手工加过一条规则：
     `Host ∈ {gallery-store, r2-gallery}` + 图片后缀 → 「自定义 TTL 30 天 + 忽略 query」。
     **正确的做法是删掉这条特例，用全局的「遵循源站 Cache-Control」**，再刷新一次缓存。
  排查时可以直接比对两侧：`S3ProviderClient.headObject(key)`（源站）vs 公开 URL 的 HEAD，
  两边 `cache-control` / `content-length` / `etag` 是否一致。
- **原图和产物用同一套缓存策略**：`public, max-age=86400, stale-while-revalidate=604800`。
  **不要给原图加 `immutable`**：`immutable` 的语义是有效期内连条件请求都不发，它只对
  **文件名里带内容哈希**的资源成立；而这里的文件名是「日期+相机编号」，重新导出同一张照片时
  文件名不变、内容会变，用 `immutable` 会让回访用户最长一年看不到新图。
  存量对象补头用 `pnpm refresh:cache -- --apply`（`CopyObject` 原地改元数据、零出网流量）。
- 分享图不走 Satori/resvg，直接用 sharp 从 2560px 的占位图（preview）按原图比例缩放出 WebP（横边上限 1200，不裁切）：源图够大、不用再解码重编码成 PNG，也不依赖构建机装中文字体。
- 原图与产物都有缓存：下载过的原图存在 `apps/web/src/data/.cache/originals/`，每张照片每种产物用哪组参数编码记录在 `.cache/asset-signatures.json`。只改一档参数时其他档不会重算。`MFILMORY_NO_ORIGINAL_CACHE=1` 跳过原图缓存，`MFILMORY_FORCE_ENCODE=1` 强制重编码。

#### AVIF 作为**输入**（照片本身就是 .avif）

`.avif` 在 `SUPPORTED_FORMATS` 里，可以跟 JPEG 一样入库，实测能完整走完 EXIF / 影调分析 / blurhash / 缩略图 / 占位图 / OG 卡。已知限制：

- **10-bit AVIF 可以解码**。当前 sharp 预编译版带着 libaom 3.15.1 的高位深解码，10-bit 文件（如仓库里那张 3888×5184 的测试图）能正常出缩略图和直方图。上游 issue #109 里「预编译 sharp 不支持 10-bit AVIF、需要自己编 libvips」的结论对现在这个版本**不再成立**，`node-gyp` 那套不用带回来。
- **AVIF 原生 HDR gain map 不支持**。`isHDR` 只认 JPEG Ultra HDR 的三个标记（`MPImageType=Gain Map Image`、URN `urn:iso:std:iso:ts:21496:-1`、EXIF `ContainerDirectory` 里的 `GainMap` 项）。带 `tmap` 项的 AVIF 会被当作 SDR 处理，`isHDR` 为 `false`；阅览器侧的 gain map 渲染依赖上游尚未合并的 PR #300 / #301。
- **JPEG XL 不支持**（上游 issue #250 的另一半仍未做）。
- 多帧 / 动画 AVIF 没有处理，只会用第一帧。

### 开发

```bash
pnpm dev             # http://localhost:1924，SPA 热更新（会先跑一次 build:manifest precheck）
pnpm type-check      # 递归 tsc --noEmit
pnpm lint            # eslint --fix
```

### 部署

`apps/web/dist` 是**纯静态**目录（`index.html` + assets + manifest），可直接：

- Cloudflare Pages：见下面的专用小节（项目 `mgt-afilmory`，`gallery.mgt.moe`）
- Vercel：`apps/web/vercel.json`
- 任意静态服务器 / 对象存储 + CDN

照片本体与缩略图由 `builder.config.ts` 指向的存储/CDN 提供，构建产物里只有 manifest 与前端资源。

照片 manifest 默认**外置**成内容 hash 命名的 `photos-manifest.<hash>.json`（HTML 里只有一条
`preload` + `window.__MANIFEST__`/`window.__MANIFEST_URL__`），这样 HTML 只有几 KB 且能被边缘缓存；
设 `AFILMORY_EMBED_MANIFEST=true` 可切回「整份内联进 HTML」的老行为（`pnpm dev` 默认内联）。
静态资源的缓存头在 `apps/web/public/_headers`（Cloudflare Pages 格式），带 hash 的资源一年 immutable。

**Pages Function 的调用范围由 `_routes.json` 控制，别让它吞掉静态页面**：

- `apps/web/public/_routes.json` 只把 `/og/*` 交给 Pages Function（分享图 302 跳转）。
  `/`、`/map`、`/manifest` 与全部 `/photos/<id>` 已在构建期通过 Vite SSG 生成静态 `.html` 文件，
  直接由静态资源 CDN 返回、可配合 `_headers` 做 `public, max-age=0, must-revalidate` + ETag 304 验证，
  不会触发 Worker/Function 调用（旧方案把 `/photos/*` 也放进 Function，导致每张照片页恒为 `DYNAMIC` 无法缓存）。
  新增需要 Function 的路径时必须同时加进这个 include 列表，否则请求会落到静态资源/SPA 回退
  （`/og/*` 就是这么坏过一个版本的：返回 200 text/html，图片永远破图）。
- **`exclude` 键必须存在，哪怕是空数组**。`wrangler pages deploy` 会按
  `{ version, include: string[], exclude: string[] }` 校验，只写 `include` 会直接让部署失败并报
  `Invalid _routes.json file found`。所以正确写法是
  `{"version": 1, "include": ["/og/*"], "exclude": []}`。
- `_headers` 按**请求 URL** 匹配，已为 `/`、`/photos/*`、`/map`、`/manifest` 分别声明 `max-age=0, must-revalidate`，
  `/assets/*`、`/vendor/*`、`/fonts/*` 为一年 immutable。
- 以后若要给 HTML 加共享缓存，注意 `s-maxage` 会**禁用** `stale-while-revalidate`（RFC 语义：
  s-maxage 隐含 proxy-revalidate），且 `max-age=0` + SWR 允许浏览器 24h 内先渲染旧 HTML——
  旧 HTML 引用的 hashed chunk 在新部署后可能已不存在，会白屏。

#### Cloudflare Pages

现网项目是 **`mgt-afilmory`**（`mgt-afilmory.pages.dev` + `gallery.mgt.moe`），历史部署全部是 **CLI 部署**、生产分支 `main`。

关键点：仓库根的 `functions/_middleware.ts`（CF OG 中间件）只有当 `wrangler` 的工作目录是**仓库根**时才会被打包进去。仓库里已经封好了 `scripts/deploy.mjs`，它会在部署前校验 dist 和中间件（中间件缺失时先尝试用 `pnpm og:middleware` 补生成），所以直接用脚本：

```powershell
pnpm deploy:cloudflare        # 构建 + 部署到生产（branch main）
pnpm deploy:preview           # 构建 + 发预览部署（branch mfilmory-preview，不碰 production）
node scripts/deploy.mjs --skip-build       # 复用现有 dist（不重新构建；中间件缺失时会先补生成）
node scripts/deploy.mjs --dry-run          # 只打印将要执行的 wrangler 命令
node scripts/deploy.mjs --project=xxx --branch=yyy --dirty
```

脚本做的事：`pnpm build`（可 `--skip-build` 跳过）→ 校验 `apps/web/dist/index.html`，`functions/_middleware.ts` 缺失**或与模板不一致**（`pnpm og:middleware -- --check`）时调用 `pnpm og:middleware` 补生成 → 工作区脏时自动加 `--commit-dirty=true` → 在**仓库根**执行 `pnpx wrangler pages deploy apps/web/dist --project-name mgt-afilmory --branch main`。项目名/分支可用 `CF_PAGES_PROJECT` / `CF_PRODUCTION_BRANCH` / `CF_PREVIEW_BRANCH` 覆盖。

等价的裸命令（想手工跑时）：

```powershell
pnpx wrangler pages deploy apps/web/dist --project-name mgt-afilmory --branch main
```

- 本地没登录过就先 `pnpx wrangler login`
- 部署后验证 OG 中间件是否生效：

  ```powershell
  curl.exe -s https://gallery.mgt.moe/photos/<photoId> | Select-String 'og:image|og:title|og:description'
  # 期望：https://r2-gallery.996404.xyz/mgt-gallery/.afilmory/og-images/<photoId>.webp
  #       og:title 是地名（不是站名），og:description 是逐行 EXIF 明细

  curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' https://gallery.mgt.moe/og/<photoId>
  # 期望：302  https://r2-gallery.996404.xyz/mgt-gallery/.afilmory/og-images/<photoId>.webp
  ```

- 本地要验证「分享预览图跳转（`/og/*` 302）」必须在 **Pages 运行时**里跑，`pnpm preview`（纯静态 serve）没有 Functions，`/og/*` 仍是 404（`/photos/*` 的 OG meta 已在静态 `.html` 内，无需 Functions）：

  ```powershell
  pnpm --filter @afilmory/web exec vite build
  pnpx wrangler pages dev apps/web/dist --port 4820    # 在仓库根执行，自动带上 functions/
  # 然后：curl.exe -sI http://127.0.0.1:4820/og/<photoId>   # 期望 302 + R2 的 og-images URL
  ```

- 想单独重新生成中间件（改模板/换 CDN 后不必跑整套照片流水线）：

  ```powershell
  pnpm og:middleware                 # 用 .env 里的 S3_CUSTOM_DOMAIN 作 storageURL
  pnpm og:middleware -- --storage-url=https://cdn.example.com/gallery
  pnpm og:middleware -- --check       # 校验磁盘上的 functions/_middleware.ts 是否最新 + 中间件处理的路径都在 _routes.json 里（该文件不提交，仅供本地检查）
  ```

- `apps/web/wrangler.jsonc`（`name: afilmory-web`）只在 `apps/web` 目录里部署时生效，那条路径带不上根 `functions/`，所以**不要**在 `apps/web` 里直接 `wrangler pages deploy`

## Windows 说明

本 fork 已做 Windows 兼容处理（上游在 Linux 上开发）：

- `scripts/preinstall.mjs` / `build:demo` 由 `sh` 脚本改成 Node 脚本（`scripts/preinstall.mjs`、`scripts/prepare-demo-data.mjs`）
- 根 `env.ts` 显式加载仓库根的 `.env`，不再依赖 `process.cwd()`（pnpm 在 workspace 包里跑脚本时 cwd 是包目录，原先会读不到 `.env` → `S3 bucket is required`）
- 去掉了仓库内的 git 符号链接（`packages/data/src/photos-manifest.json`、`apps/web/src/lib/zeroperl.wasm`、`apps/web/.env` 等），manifest 路径和 wasm 资源改为直接引用
- `vite.config.ts` 里的 manifest 路径改用 `fileURLToPath`，不再依赖 `new URL(...).pathname`
- `vite-plugin-route-builder` 的页面 glob 改成 POSIX 路径：Windows 上原生 `C:\...` 模式匹配不到任何页面，会静默生成空路由表 → 白屏
- `modules/gallery/PageFooter.tsx` 里写坏的 `~/../../site.config` 导入改为 `@config`（上游该文件在生成路由后会直接构建失败）
- 要求 Node 24+；pnpm 版本由 `packageManager` 字段自动切换（本 fork pin 到 `pnpm@11.28.11`：上游写的是不存在的 `pnpm@12.3.2`，且 Windows 侧 pnpm 12 没有发布平台二进制包）

## 与上游同步

```bash
git remote add upstream https://github.com/Afilmory/afilmory
git fetch upstream
# 因为后端/SSR/移动端已删除，不要直接 merge；按需 git cherry-pick <sha>
```

上游的 `apps/web` 改动通常可以 cherry-pick；涉及 `be/`、`apps/ssr`、`apps/mobile` 的提交需要手工裁剪。

