# AGENTS.md — mfilmory

本仓库是 Afilmory 的**静态 Web 前端 fork**。原项目的 `AGENTS.md` 里关于后端（`be/`）、SSR（`apps/ssr`）、iOS（`apps/mobile`）、官网/文档站的规则全部作废，那些目录已删除。以下规则只适用于本仓库现存内容。

## 权威文档

- `DESIGN.md` — `apps/web` + `packages/ui` 的**规范性设计系统**：UIKit 颜色 token、material/blur 角色、圆角、字体、弹簧动效、z-index 分层、布局、图标，以及 §13 里明确「不要照抄」的违规文件清单。改 UI 前必读。
- `apps/web/AGENTS.md` — 指向 `DESIGN.md` 的简短红线清单。
- `README.md` — 安装、配置（`config.json` / `builder.config.ts` / `.env`）、构建与部署。
- `rss-spec.md` — SPA 的 RSS 输出规范。

## 命令

```bash
pnpm install              # preinstall 会 seed config.json / builder.config.ts
pnpm dev                  # SPA 开发服务器 :1924（先跑 build:manifest precheck）
pnpm build                # 生产构建 → apps/web/dist（纯静态）
pnpm build:manifest       # 照片流水线：存储同步 → EXIF/缩略图/blurhash → photos-manifest.json
pnpm build:manifest -- --force   # 全量重建照片与 manifest
pnpm build:demo           # 无 S3 的 demo 数据 + 构建
pnpm preview              # 预览 dist/
pnpm type-check           # pnpm -r type-check
pnpm lint                 # eslint --fix
```

注意：`apps/web/src/generated-routes.ts` 由 `vite-plugin-route-builder` 在首次构建时生成（已 gitignore）。全新 clone 后先 `pnpm build` 再 `pnpm type-check`，否则 `type-check` 会因为找不到生成文件而报错——上游 CI 也是这个顺序。

## 架构（现存部分）

```
packages/builder (CLI 流水线)
   sync (S3 / local / GitHub) → EXIF/thumb/blurhash → apps/web/src/data/photos-manifest.json
                                        │
apps/web (Vite + React 19 SPA) ←────────┘
   manifestInjectPlugin 把 JSON 外置成 photos-manifest.<hash>.json（dev 时内联），
   并把首屏缩略图 preload 写进 HTML；packages/data 的 PhotoLoader 读 window.__MANIFEST_URL__
```

- **没有后端**。`apps/web` 必须能脱离任何 API 独立运行：不要假设有登录、点赞、评论、后台。需要后端的能力走 feature-detect 或直接不渲染。
- `apps/web` 是唯一的 Web UI 代码库；页面（`src/pages`）只做路由壳，真实 UI/逻辑在 `src/modules/<domain>/`。
- 配置分层不要混：`builder.config.ts` 是**基础设施**（照片来源、并发、插件）；`site.config.ts` + `config.json` 是**展示**（站名、作者、主题色、地图、备案）。二者都只在构建期被读取。
- 照片流水线只允许 `packages/builder` 碰存储；共享类型在 `packages/typing`；照片查询一律走 `packages/data` 的 `PhotoLoader`。
- `pnpm dev` 的 `precheck` 会真的去跑 `build:manifest`（因此需要 `.env` / `builder.config.ts` 可用）；只想跑 Vite 时用 `pnpm --filter @afilmory/web exec vite`。

## 插件（全部在仓库内，没有外部插件目录）

- `apps/web/plugins/vite/*` — SPA 的 Vite 插件：`manifest-inject`（外置 manifest + 首屏图片 preload/preconnect）、`site-config-inject`、`photos-static`、`og-image-plugin`（构建期 OG + favicon）、`feed-sitemap`、`locales-json`（点号 key 展开）、`i18n-hmr`、`deps`（分包）、`ast`（`tw` 宏）。
- `packages/builder/src/plugins/*` — 流水线插件：`storage/{local,s3,b2,github,eagle}`、`thumbnail-storage`、`geocoding`、`github-repo-sync`、`og-image-storage`。
- **Cloudflare 分享图插件** = `og-image-storage/vendors/cloudflare-moddleware.ts` + `vendors/templates/cloudflare-middleware.njk`。卡片图就是照片本身（1200×630 满幅 WebP，不画底色/站名/标题），文字由平台原生渲染；中间件把 `/photos/:slug` 的 `og:image`/`twitter:image` 改写到 R2 的 `.afilmory/og-images/*.webp`，并按 manifest 注入该照片的 `og:title`/`og:description`/`<title>`/`meta[name=description]`。产物是仓库根 `functions/_middleware.ts`（**构建产物，不提交、已被 ignore**；`pnpm build` 时由 builder 重新生成，改模板后可用 `pnpm og:middleware` 单独重生成，`-- --check` 校验磁盘文件是否最新）。
- **部署 = Cloudflare Pages 项目 `mgt-afilmory`（生产分支 `main`）**，用仓库里的脚本，别手搓：`pnpm deploy:cloudflare`（构建 + 部署）/ `pnpm deploy:preview`（预览）/ `node scripts/deploy.mjs --skip-build --dry-run`（调试）。脚本必须在**仓库根**执行并以参数传 dist 目录，否则根 `functions/` 不会被打包，OG 改写失效；`apps/web/wrangler.jsonc` 只在 `apps/web` 里部署时生效，别用。中间件缺失时部署脚本会先调用 `pnpm og:middleware` 补生成（依赖 `.env` 里的 `S3_CUSTOM_DOMAIN`）。
- `plugins/eslint/*` — 本地 ESLint 插件（i18n JSON、no-debug、package.json、递归排序）。

## 本 fork 相对上游的改动（改代码时注意别改回去）

- 删除 `be/`、`apps/ssr`、`apps/mobile`、`apps/site(s)`、`apps/docs`、`apps/promo` 及其 CI/Docker 文件。
- 根 `scripts/` 里 `sh` 脚本改为 Node：`preinstall.mjs`、`prepare-demo-data.mjs`（Windows 兼容）。
- 去掉 git 符号链接：manifest 直接从 `apps/web/src/data/photos-manifest.json` 读（`apps/web/plugins/vite/__internal__/constants.ts` 用 `fileURLToPath`）；`zeroperl.wasm` 改为从 `@6over3/zeroperl-ts/zeroperl.wasm?url` 引入。
- `apps/web/vite.config.ts` 的页面 glob 必须保持 POSIX 路径（`toPosixPath`）。Windows 下用原生路径拼 glob 会匹配到 0 个页面，静默生成空 `generated-routes.ts`，页面白屏且没有任何报错。
- `apps/web/src/modules/gallery/PageFooter.tsx` 的 `@config` 导入是修过的（上游是坏的 `~/../../site.config`）；不要按上游原样 merge 回去。
- `packages/data` 只导出 `PhotoLoader`（`./manifest` 导出已删除）。
- 根 `package.json` 只剩静态站相关脚本；`@afilmory/*` 包名保持不变（方便与上游对齐代码）。

## 代码规范（沿用上游）

- **UI 只用语义 token**：`text-text-*`、`bg-fill-*`、`bg-material-*`、`border-accent/20`；不要裸 hex / `gray-*`。深色模式唯一，不做主题切换。
- 空间动效用 `Spring.presets.*`（`@afilmory/utils`），不要新写 `cubic-bezier`。
- 图标用 `i-mingcute-*`，不要新增 `lucide-react`。
- i18n：`locales/app/*.json` 扁平 key + `.` 分隔；先改 `en.json`，其他语言由 ESLint 自动裁剪；禁止 `a.b` 与 `a.b.c` 同时存在。
- 没有 feature flag、没有向后兼容 shim —— 直接改代码。
- TypeScript 严格模式，`pnpm type-check` 必须通过；提交前跑 `pnpm lint`。

## 文档与生成物一致性（改代码前必查）

同一个事实在仓库里通常有多处描述：`README.md`、本文件、`scripts/*` 的注释与提示文案、`.github/workflows/*`、以及模板 `builder.config.default.ts`。改动下列内容时，必须先用 grep 找出所有引用并一起更新，不能只提交最小 diff：

- 删除、重命名，或把某个**已跟踪文件**改成「构建生成 + gitignore」
- 改变脚本语义或提示文案（例如 `og:middleware --check` 里的“过期”是相对哪个文件）
- 改变部署/CI 路径的前置条件（例如 `deploy.mjs --skip-build` 依赖仓库里的生成物）
- 修改真正在用的 `builder.config.ts`，而模板 `builder.config.default.ts` 没有同步

提交前至少跑一次（把 `<pattern>` 换成被删/改名/改语义的对象）：

```bash
git grep -n "<pattern>" -- ':!node_modules' ':!apps/web/dist'
```

- 多 commit 或 squash 后，检查 PR body 与最终 diff 是否一致。

判据：README、AGENTS.md、脚本输出、模板、CI 必须与代码行为描述同一套事实；“生成物是否入库”只能有一个结论。反例：中间件改为 ignore 后，README/AGENTS 仍写“已提交”、`og:middleware --check` 仍提示“commit the result”、`deploy.mjs --skip-build` 缺少补生成兜底。

## 已知遗留 / 下一步

- **`--dry-run` 的计数不可信（会偏高）**：`packages/builder/src/builder/builder.ts:87` 在 `dryRun` 时跳过 `ensurePluginsReady()`，于是 thumbnail / og-image 插件注册的 `.afilmory/thumbnails/`、`.afilmory/og-images/` 排除前缀不生效，桶里已生成的缩略图和 OG 图会被当成"照片"（实测对 369 张的库会虚报成 1110 张、要求处理 741 张）。真实构建（不加 `--dry-run`）会排除这些生成物，实测扫描结果 382 个文件 → 369 张照片 → 0 张需要处理。估算增量时别信 dry-run 的数字。

- 分享图不再经过 Satori/resvg：`packages/renderer`（`@afilmory/og-renderer`）与 `packages/builder/assets/og` 的中文字体已随「照片直放」方案一起删掉。图片由 `og-image-storage/photo-og.ts` 用 sharp 从 2560px 占位图缩放，文案由 `photo-text.ts` 生成；要回到「设计卡片」方案得从 git 历史里取回这两块。
- 本 fork 已同步到 `upstream/main` `cdeada39`（2026-11）。上游 `c392e065..cdeada39` 的 40 个提交全是 `apps/mobile`（+ 移动端 CI/设计文档），`apps/web`、`packages`、`locales`、`scripts` 一个文件都没动；之后上游再有 `apps/web` 改动可直接 `git cherry-pick`。
