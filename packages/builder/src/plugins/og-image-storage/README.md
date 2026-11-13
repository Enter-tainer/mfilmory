# OG Image Storage Plugin

分享图（Open Graph card）插件。

卡片**只有照片**：把 2560px 的阅览器占位图缩成 1200×630 WebP 上传到存储，没有黑底、边框、站名，也不画标题和 EXIF。
卡片上的文字全部交给分享平台从页面 meta 原生渲染，所以每张照片页的 `og:title` / `og:description` / `<title>` 由
Cloudflare 中间件在边缘按 manifest 注入（SPA 每张照片返回的是同一份 `index.html`）。

## 卡片长什么样

- 单张照片页：照片满幅铺进 1.91:1（Twitter/X、WhatsApp、Telegram、Facebook、iMessage 的通用卡片比例），
  用 `sharp.strategy.attention` 挑裁切位置，避免竖构图居中裁切切掉主体。
- 首页/站点级卡片：从最近的照片里挑第一张适合做横幅的横向照片（1.45:1 – 2.6:1），同样满幅 1200×630。

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
    ogImagePlugin({
      vendor: {
        type: 'cloudflare-middleware',
        storageURL: 'https://your-cdn.example.com', // 提供 .afilmory/og-images/* 的 CDN / 对象存储
        siteConfigPath: './config.json', // 可选，默认仓库根 config.json
        manifestPath: 'apps/web/src/data/photos-manifest.json', // 可选，默认就是这个
      },
    }),
  ],
}))
```

第一次使用（或改了卡片参数）需要重跑 manifest 才会补齐已有照片的分享图：

```bash
pnpm build:manifest -- --force-manifest
```

`--force-manifest` 不会重新生成缩略图/占位图，只重渲染分享图并重新上传。

## Cloudflare Pages 中间件

`vendors/cloudflare-moddleware.ts` + `vendors/templates/cloudflare-middleware.njk` 生成仓库根的
`functions/_middleware.ts`（**构建产物，不提交**）。`pnpm build` 会自动生成，也可以单独重生成：

```bash
pnpm og:middleware                 # 用 .env 里的 S3_CUSTOM_DOMAIN 作 storageURL
pnpm og:middleware -- --check      # 校验磁盘文件是否最新
```

它做四件事（都只针对 `/photos/:slug` 的 HTML 响应）：

1. 把站点级卡片的 `og:image` / `twitter:image` 换成该照片在 R2 的分享图；
2. 注入 `og:title` / `twitter:title`、`og:description` / `twitter:description`；
3. 把 `meta[name=description]` 换成单行摘要，`<title>` 换成 `{标题} | {站名}`；
4. 把 `og:url` / `twitter:url` 换成本页 URL。

整库文案表在构建期内嵌进中间件（`PHOTO_TEXT`，369 张约 55KB），所以边缘函数不需要额外请求。
manifest 读不到时只换图、文字保持站点级，不会让中间件报错。

部署到 Cloudflare Pages 时 **project root 必须是仓库根**（或显式 `--functions-directory`），
否则 `functions/` 不会被带上，改写就失效。

## 配置

- `enable` (boolean)：开关，默认 `true`。
- `directory` (string)：远端目录前缀，默认 `.afilmory/og-images`。
- `storageConfig` (storage config)：覆盖存储配置，默认用 builder 当前存储。
- `contentType` (string)：上传 MIME，默认 `image/webp`。
- `vendor` (object)：可选自动化。
  目前只有 `cloudflare-middleware`：
  - `storageURL`（必填）：提供 `.afilmory/og-images` 的地址；
  - `siteConfigPath`（可选）：站点配置路径，默认仓库根 `config.json`；
  - `manifestPath`（可选）：manifest 路径，默认 `apps/web/src/data/photos-manifest.json`。

## 实现要点

- **源图用占位图（preview，长边 2560）而不是 600px 缩略图**：1200px 宽的卡片用缩略图会被放大到发糊。
  两者都由上一个插件（`thumbnail-storage`）在内存里准备好，正常构建不额外读盘或联网；只有都缺失时才回落到
  `public/previews` / `public/thumbnails` 本地缓存，最后一招才走 CDN。
- 换卡片参数（尺寸、WebP 质量）时记得同步 `photo-og.ts` 里的常量——asset signature 会据此判定是否需要
  重渲染（`.cache/asset-signatures.json` 的 `og:` 键）。
- 不支持 Eagle 存储（插件会自动禁用）。
- 分享图 URL 写回 manifest 的 `ogImageUrl` 字段。
