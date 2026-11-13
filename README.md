# mfilmory

**Afilmory 的纯静态 Web 前端 fork**：只保留「照片画廊 SPA + 照片处理流水线」，不带任何后端、SaaS、SSR 宿主或移动端。

- 上游：<https://github.com/Afilmory/Afilmory>
- 本 fork 的基线：`c392e065`（Enter-tainer/afilmory 的工作副本）
- 许可证：沿用上游 `LICENSE`（AGPL，见文件正文），修改部分同样以该许可证发布

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

- Cloudflare Pages：`pnpm deploy:cloudflare`（`wrangler pages deploy`，配置见 `apps/web/wrangler.jsonc`）
- Vercel：`apps/web/vercel.json`
- 任意静态服务器 / 对象存储 + CDN

照片本体与缩略图由 `builder.config.ts` 指向的存储/CDN 提供，构建产物里只有 manifest 与前端资源。

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
