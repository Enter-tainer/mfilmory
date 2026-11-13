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
| `packages/{typing,ui,hooks,utils,renderer,sdk,viewer-motion,webgl-viewer}` | SPA 依赖的共享包（OG 图渲染、WebGL 查看器、视图动效、UI 原语等） |
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
| `manifest-inject.ts` | 把 `photos-manifest.json` 内联成 `<script id="manifest">window.__MANIFEST__ = …` |
| `site-config-inject.ts` | 注入 `window.__SITE_CONFIG__`（`site.config.ts` + `config.json`） |
| `photos-static.ts` | 静态站的照片数据 / 路由辅助 |
| `og-image-plugin.ts` | 构建期生成站点 OG 图 + 全部 favicon（`logo.jpg` + `sharp`） |
| `feed-sitemap.ts` | 生成 `feed.xml` / `sitemap.xml` |
| `locales-json.ts` | 把 `locales/app/*.json` 的扁平点号 key 展开成嵌套对象（Windows 路径比较已修） |
| `i18n-hmr.ts` / `locales.ts` | 文案热更新辅助（`locales.ts` 是死代码，上游如此） |
| `deps.ts` | 手动分包（react / i18next / heic-to） |
| `ast.ts` | `tw` 模板字符串压缩宏（unplugin-ast） |
| `vibeloft-telemetry.ts` | 可选统计注入（`config.json` 的 `telemetry.vibeloft`） |

**2. `packages/builder` 的照片流水线插件** — `packages/builder/src/plugins/`

- `storage/`：local / s3 / b2 / github / eagle 五种存储 provider
- `thumbnail-storage/`：缩略图上传
- `geocoding.js`：照片地点反查（`geocodingPlugin`）
- `github-repo-sync.js`：把 manifest / 缩略图写回 GitHub 仓库
- `og-image-storage/`：**OG 图插件**。其中 `vendors/cloudflare-moddleware.ts` + `vendors/templates/cloudflare-middleware.njk` 就是 **Cloudflare Pages 中间件**：拦截 `/photos/:slug` 的 HTML，把 `og:image` / `twitter:image` 重写到 R2 上的 `.afilmory/og-images/*.png`
  - 产物写到仓库根 `functions/_middleware.ts`，由 `builder.config.ts` 里的 `ogImagePlugin({ vendor: { type: 'cloudflare-middleware', storageURL } })` 触发
  - 该文件已提交一份（`.gitignore` 里做了例外）；内容由 `config.json` 的 `url` + `builder.config.ts` 的 `storageURL` 决定。真实 `pnpm build` 会重新生成，也可以 `pnpm og:middleware` 单独重生成（`-- --check` 校验是否过期，`--storage-url=…` 临时覆盖 CDN 地址）
  - 部署到 Cloudflare Pages 时 **project root 必须是仓库根**（或显式 `--functions-directory`），否则 `functions/` 不会被带上，OG 改写就失效

**3. 根级本地 ESLint 插件** — `plugins/eslint/`（i18n JSON 校验、no-debug、package.json 校验、递归排序），由 `eslint.config.mjs` 加载。

> 已删除：根 `plugins/vite/ast.ts` —— 只有已删的 `apps/docs` 和 `be/apps/dashboard` 引用它，`apps/web` 自带一份同功能实现。

## 去掉了什么

- `be/` —— SaaS 后端（Hono API、dashboard、Drizzle DB、Redis、task-queue、OAuth gateway）
- `apps/ssr` —— Next.js SSR 宿主（服务端注入 manifest、动态 OG/SEO、自己的 drizzle 库）
- `apps/mobile` —— 原生 Swift/UIKit iOS App
- `apps/site` / `apps/docs` / `apps/landing` / `apps/promo` —— Astro 官网、文档站、推广页
- `docs/`、`.specstory/`、Dockerfile / docker-compose、以及只服务上述部分的 CI workflow
- 依赖后端才有意义的能力（登录、点赞/评论同步、后台管理）在静态模式下自动降级或缺省

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
pnpm build            # 把 manifest 内联进 SPA，产物在 apps/web/dist
```

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

#### Cloudflare Pages

现网项目是 **`mgt-afilmory`**（`mgt-afilmory.pages.dev` + `gallery.mgt.moe`），历史部署全部是 **CLI 部署**、生产分支 `main`。

关键点：仓库根的 `functions/_middleware.ts`（CF OG 中间件）只有当 `wrangler` 的工作目录是**仓库根**时才会被打包进去。仓库里已经封好了 `scripts/deploy.mjs`，它会在部署前校验 dist 和中间件，所以直接用脚本：

```powershell
pnpm deploy:cloudflare        # 构建 + 部署到生产（branch main）
pnpm deploy:preview           # 构建 + 发预览部署（branch mfilmory-preview，不碰 production）
node scripts/deploy.mjs --skip-build       # 复用现有 dist（不重新构建）
node scripts/deploy.mjs --dry-run          # 只打印将要执行的 wrangler 命令
node scripts/deploy.mjs --project=xxx --branch=yyy --dirty
```

脚本做的事：`pnpm build`（可 `--skip-build` 跳过）→ 校验 `apps/web/dist/index.html` 和 `functions/_middleware.ts` → 工作区脏时自动加 `--commit-dirty=true` → 在**仓库根**执行 `pnpx wrangler pages deploy apps/web/dist --project-name mgt-afilmory --branch main`。项目名/分支可用 `CF_PAGES_PROJECT` / `CF_PRODUCTION_BRANCH` / `CF_PREVIEW_BRANCH` 覆盖。

等价的裸命令（想手工跑时）：

```powershell
pnpx wrangler pages deploy apps/web/dist --project-name mgt-afilmory --branch main
```

- 本地没登录过就先 `pnpx wrangler login`
- 部署后验证 OG 中间件是否生效：

  ```powershell
  curl.exe -s https://gallery.mgt.moe/photos/<photoId> | Select-String 'og:image'
  # 期望：https://r2-gallery.996404.xyz/mgt-gallery/.afilmory/og-images/<photoId>.png
  ```

- 想单独重新生成中间件（改模板/换 CDN 后不必跑整套照片流水线）：

  ```powershell
  pnpm og:middleware                 # 用 .env 里的 S3_CUSTOM_DOMAIN 作 storageURL
  pnpm og:middleware -- --storage-url=https://cdn.example.com/gallery
  pnpm og:middleware -- --check       # 校验已提交的 functions/_middleware.ts 是否过期（CI 可用）
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
