# 缩略图 / 占位图 / 分享图的广色域（2026-11）

## 症状

网格缩略图（`thumbnails/<id>.avif`）和点开大图首屏的占位图（`previews/<id>.avif`）比原图暗淡、
色相偏死；原图（10MB 级）加载完成后颜色突然"亮"起来。样本：
<https://gallery.mgt.moe/photos/20261121-MGT07132>。

## 原因

原图由 Lightroom Classic 导出，内嵌 548 字节的 Display P3 ICC Profile（因此 EXIF `ColorSpace`
是 `Uncalibrated`）。构建期 sharp（libvips）的默认行为是**把像素转成 sRGB 并从输出里剥掉
Profile**，于是超出 sRGB 边界的颜色被硬裁到 0/255：

- 该图 P3 → sRGB 后 **2.3% 的通道**落在 0/255 边界，单通道最大偏差 **68/255**；
- 高饱和的秋叶、霓虹、舞台光最容易看出这种"平掉"的差别。

而原图在查看器里是按 P3 渲染的（`WebGPUImageViewerEngine` 的 `colorSpace: 'display-p3'`），
所以「缩略图/占位图 → 原图」会有肉眼可见的颜色跳变。

## 改法

1. `packages/builder/src/image/color-profile.ts`：解析 ICC 的 `rXYZ/gXYZ/bXYZ`（PCS D50），
   只有「RGB 矩阵 Profile 且原色 ≠ sRGB」才判定为需要保留。认不出的一律按不保留处理，
   免得把 Gray / CMYK Profile 贴到 RGB 输出上。
2. `thumbnail.ts` / `preview.ts` / `photo-og.ts` 在编码链路里按判断结果调用
   `.keepIccProfile()`；`THUMBNAIL_SIGNATURE` / `PREVIEW_SIGNATURE` 加 `-icc`、
   `PHOTO_OG_LAYOUT_VERSION` → `v3`、`MEDIA_FORMAT_VERSION` 加 `icc`，
   让增量构建把旧产物全部重编（文件名不含参数，光看文件在不在判断不出来）。
3. WebGL 降级路径补齐 P3：`drawingBufferColorSpace` 与 `unpackColorSpace` **成对**设成
   `display-p3`，`texture.worker.js` 的 `OffscreenCanvas` 2D 上下文也用
   `colorSpace: 'display-p3'`。

### 为什么不是无条件 `.keepIccProfile()`

Lightroom 导出的 **sRGB** 原图内嵌的是 3.1KB 的 HP/Microsoft sRGB IEC61966-2.1 Profile，
保留它像素一个字节都不会变（没有 Profile 的 AVIF/WebP 本来就按 sRGB 解释），只是白多 3KB。
而 P3 的 548B Profile 保留后产物反而更小：同参数缩略图 **104.9KB（保留 ICC） vs
109.0KB（裁到 sRGB 后剥离）**——色域裁切会在边界处制造高频伪影。

### 为什么 WebGL 两个属性必须成对

`texImage2D` 上传 `ImageBitmap` 时按 `unpackColorSpace` 换算，`drawingBufferColorSpace` 只负责
解释画布。只设后者时 sRGB 图会以 sRGB 数值直接塞进 P3 画布被拉过头（headless Chrome 157
实测：sRGB 纯红读出 `(255,0,0)`，正确值应是 P3 编码的 `(234,51,35)`）；只设前者则 P3 图仍被
压回 sRGB。

## 验证方式（可复现）

- 产物 ICC 与源图**字节级一致**（`sharp(out).metadata().icc` 与源图比较）。
- Chrome 会应用 AVIF 里的 ICC：把同一个颜色分别编码成 P3-tagged 与 sRGB-tagged 的 AVIF，
  在 `colorSpace: 'display-p3'` 的 2D 画布上读出**同一个值**，说明 `colr`/`rICC` 生效。
- WebGL 链路（P3 OffscreenCanvas 瓦片 → `texImage2D` → P3 画布 `readPixels`）与 2D P3 画布的
  像素值**完全一致**（真实 P3 照片采样，max diff = 0）。
- 重新生成：`pnpm build:manifest`（签名 + `MEDIA_FORMAT_VERSION` 都会失配，自动全量重编）。

## 已知遗留

- HEIC/HEIF 原图仍走 `heic-convert` → JPEG（`processor.ts`），这一步就把 iPhone 的 P3 照片
  变成未标注的 sRGB 数据；本仓库当前没有 HEIC 原图（373 JPG + 1 AVIF），所以没有一并处理。
  以后接入 HEIC 时需要在转换前把 ICC 取出来重新嵌入，或换成颜色管理正确的解码路径。
- blurhash 用（现在是 P3 数值的）缩略图算，占位色会略微偏饱和；它只是极小的模糊色块，
  不单独处理。
