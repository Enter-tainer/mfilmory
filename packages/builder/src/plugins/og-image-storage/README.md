# OG Image Storage Plugin

分享图（Open Graph card）插件。

卡片**只有照片**：把 2560px 的阅览器占位图按原图比例缩放成 WebP 上传到存储，没有黑底、边框、站名，也不画标题和 EXIF。
**横边上限 1200**（>1200 缩到 1200，≤1200 保持原尺寸不放大），纵边按比例，不裁切。
卡片上的文字全部交给分享平台从页面 meta 原生渲染，所以每张照片页的 `og:image` / `twitter:image` /
`og:title` / `og:description` / `<title>` / `meta[name=description]` 在 Vite 生产构建期由
`apps/web/plugins/vite/ssg-prerender.ts` 直接调用 `photo-text.ts`（`buildPhotoOgText`）写入各自的静态
`photos/<id>.html`，无需经过 Cloudflare 中间件，使 `/photos/*` 可直接走静态 CDN 缓存。

## 卡片长什么样

- 单张照片页：照片按原图比例、横边上限 1200 缩放（3:4 竖图 → 1200×1600，3:2 横图 → 1200×800），
  不裁切、不放大。依据：聊天软件里预览图展示宽度受气泡/卡片列宽限制（桌面约 400–600 CSS px），
  源图横边 1200 已覆盖 2× DPR；再宽只会让文件变大。
- 平台差异是平台侧行为，单张 `og:image` 无法全部满足：Telegram / iMessage / Slack 按卡片宽度等比缩放
  （竖图能完整显示）；Discord 大图约 400×300 展示上限，高图会被缩小；X / Facebook / LinkedIn 会按
  1.91:1–2:1 裁切。
- 首页/站点级卡片：从最近的照片里挑第一张适合做横幅的横向照片（1.45:1 – 2.6:1），满幅 1200×630（不跟随照片比例）。

文字部分（`photo-text.ts`）：

```
title       ← 拍摄地点（或照片本来的名字）           → og:title / twitter:title / <title>
description ← EXIF 明细，一行一个 emoji 字段        → og:description / twitter:description
               📸: SONY ILCE-7RM5 / Viltrox 55mm F1.8 FE
               📝: 55mm, f/3.5, 1/3200s, ISO 100
               📅: 2026-10-02 15:08:41
               🗺: 丹东镇, 丹巴县, 甘孜藏族自治州, 四川省, 626300, 中国
               📍: 31.047980° N, 101.349466° E
summary     ← 单行版，给搜索结果摘要                 → meta[name=description]
```

标题只在照片标题「像人写的」时候才用它：这个库 369 张照片里只有 1 张真有标题，其余都是
`20260103 MGT07818`、`DSC09104 已增强 降噪` 这类相机/软件产出的串，所以默认用反向地理编码出的地名。

## 用法

```ts
import { defineBuilderConfig, ogImagePlugin, thumbnailStoragePlugin } from '@afilmory/builder'

export default defineBuilderConfig(() => ({
  storage, // 与 build:manifest 用同一套存储配置
  plugins: [
    thumbnailStoragePlugin(),
    ogImagePlugin(),
  ],
}))
```

第一次使用（或改了卡片参数）需要重跑 manifest 才会补齐已有照片的分享图：

```bash
pnpm build:manifest -- --force-manifest
```

`--force-manifest` 不会重新生成缩略图/占位图，只重渲染分享图并重新上传。

## 分享卡片 meta 从哪来

`/photos/:id` 的 `og:image` / `twitter:image` / `og:title` / `og:description` / `<title>` /
`meta[name=description]` 由 `apps/web/plugins/vite/ssg-prerender.ts` 在构建期调用
`photo-text.ts`（`buildPhotoOgText`）直接写进静态 `photos/<id>.html`，分享平台读的就是这些静态 meta。

**站点没有 Cloudflare Pages Functions**：`vendors/`（`cloudflare-middleware` 模板）、
`functions/_middleware.ts`、`apps/web/public/_routes.json`、`pnpm og:middleware` 都已删除。
分享弹窗的预览与「下载预览图」直接用运行时 manifest 里的 `previewUrl`（2560px 占位图，
打开 viewer 时通常已缓存），不再经过 `/og/:photoId` 跳转。

## 配置

- `enable` (boolean)：开关，默认 `true`。
- `directory` (string)：远端目录前缀，默认 `.afilmory/og-images`。
- `storageConfig` (storage config)：覆盖存储配置，默认用 builder 当前存储。
- `contentType` (string)：上传 MIME，默认 `image/webp`。

## 实现要点

- **源图用占位图（preview，长边 2560）而不是 600px 缩略图**：1200px 宽的卡片用缩略图会被放大到发糊。
  两者都由上一个插件（`thumbnail-storage`）在内存里准备好，正常构建不额外读盘或联网；只有都缺失时才回落到
  `public/previews` / `public/thumbnails` 本地缓存，最后一招才走 CDN。
- 换卡片参数（横边上限、WebP 质量）时记得同步 `photo-og.ts` 里的常量——asset signature 会据此判定是否需要
  重渲染（`.cache/asset-signatures.json` 的 `og:` 键）。
- 换尺寸/构图策略时还要递增 `photo-og.ts` 里的 `PHOTO_OG_LAYOUT_VERSION`（它也在签名里），否则增量构建
  会把旧卡片当成新参数产物继续复用；已生成的照片用 `--force-manifest` 重跑一遍即可刷新。
- 不支持 Eagle 存储（插件会自动禁用）。
- 分享图 URL 写回 manifest 的 `ogImageUrl` 字段。
