# AVIF Ultra HDR（2026-11）

## 症状

Lightroom Classic 从 `P1120094.RW2` 导出的 AVIF（样本：`.cache/originals/aviftest.avif`，4.0MB）
在站点上有两个问题：

1. `isHDR` 被标成 `false`，WebGPU 渲染器不叠加增益图，查看器只剩 SDR 基准层；
2. 网格缩略图 / 占位图 / 分享图比原图偏灰。

## 容器里到底有什么

```
ftyp  avif, 兼容品牌 [avif, mif1, miaf, MA1A, tmap]
meta
  pitm  → 1
  iinf  1 Color(av01) / 2 Exif / 3 mime(XMP) / 4 GMap(av01) / 5 GMap(tmap)
  iref  dimg: 5 → [1, 4]
  iloc  1、4 在 mdat；5（tmap）在 idat（142 字节）
  iprp  colr(nclx 12/13/6) 关联主图；colr(nclx 2/2/6) 关联增益图；colr(nclx 9/16/9) 关联 tmap
```

- 主图是 10-bit Display P3（`primaries=12, transfer=13, matrix=6`）；
- 增益图是同样 3888×5184 的 10-bit `av01` 辅助图；
- `tmap` 项载荷 = **1 字节 version(0) + 141 字节 ISO 21496-1 二进制元数据**，去掉首字节后
  `parseISOGainMap()` 能直接解析。实测值：`capacityMax ≈ 2.93`（≈ +2.9EV）、
  `gamma ≈ 0.375–0.390`、`offsetBase/Alternate = 1/64`、`flags = 0b11000000`
  （3 通道 + 使用基准色域）。

## 为什么 `isHDR` 是 false

现有的三条判据都只对 JPEG 生效：

- `exifData.MPImageType === 'Gain Map Image'`、`UniformResourceName`、`ContainerDirectory`
  都是 exif 层面/JPEG 容器层面的信号，AVIF 的 `tmap` 在那里完全看不见；
- `sharp.metadata().gainMap` 也只认 JPEG（类型上就是 `{ image: Buffer }`）。

所以判定只能读 ISO-BMFF 容器本身：`meta` 里存在 `tmap` 派生项。

## 为什么缩略图偏灰

**libvips 不解释 `colr` 里的 nclx CICP**，只认 ICC（`prof` / `rICC`）：

- `sharp(aviftest.avif).metadata().hasProfile === false`，解出来的像素是 **Display P3 编码值**；
- sharp 重新编码 AVIF / WebP 时不会写任何 `colr` / `ICCP`，于是产物是「P3 数值 + 无标记」；
- 浏览器把无标记产物当 sRGB，直接显示 P3 数值 → 比正确渲染更暗淡。

同一像素的实测（500px 缩略图，Chrome 157 headless）：

| 渲染方式 | 像素 |
| --- | --- |
| 原图（Chrome 按 nclx 转 sRGB） | `(210, 181, 74)` |
| sharp 解码（P3 数值，未转换） | `(206, 182, 93)` |

把 P3 数值按 P3→sRGB 矩阵手工换算，得到 `(212, 182, 74)`，与 Chrome 的原图渲染一致 ——
证明 Chrome 会转换、libvips 不会。

## 改法

### 构建期（`packages/builder`）

1. `src/image/avif-color.ts`（只读 ISO-BMFF 容器解析器）：
   - `readAvifInfo()` / `hasAvifGainMap()`：解析 `ftyp` / `meta` / `iinf` / `pitm` / `iprp`，
     报告主图 CICP 与是否存在 `tmap`；顺序扫到 `meta` 即停，读头切片不会被后方的 `mdat` 阻断；
   - `isAvifDisplayP3()`：源图是没有 ICC、仅靠 `colr/nclx` 声明为 Display P3（且为 SDR 传递函数）的 AVIF 时返回 `true`（PQ/HLG 返回 `false`）。
2. `src/image/color-profile.ts`（统一策略）：
   - `resolveColorProfileStrategy()` 返回 `'keep-icc' | 'attach-p3' | 'srgb'`；
   - 对 `'attach-p3'`，调用 `pipeline.pipelineColourspace('rgb16').withIccProfile('p3')`：
     直接调用 `.withIccProfile('p3')` 时 sharp 会把无 ICC 输入当 sRGB 再转换一遍（导致 P3 像素被二次拉伸），
     而切到 `rgb16` 管道色彩空间后，sharp **跳过 `vips_icc_transform`**，原样保留 P3 像素并把 480B 的 Display P3 ICC 写入 `colr(rICC)`（AVIF）或 `ICCP`（WebP）。
   - `thumbnail.ts` / `preview.ts` / `photo-og.ts` 共用 `applyColorProfileStrategy()`，缩略图、占位图与 OG 分享图均保留 P3 ICC；
     `THUMBNAIL_SIGNATURE` / `PREVIEW_SIGNATURE` 加 `-icc-cicp`，`PHOTO_OG_LAYOUT_VERSION` 升至 `v4`，`MEDIA_FORMAT_VERSION` 加 `cicp`，
     让增量构建重编旧产物。
3. `photo/gainmap-detector.ts`：`detectAvifGainMap()` 读原图（内存 buffer 优先；cpu-worker 模式先读 64B 探测头判断 `isAvif()`，确认是 AVIF 才读 1MB `meta`，避免给大量 JPEG 分配 1MB 缓冲）。**拿不到原图字节时返回 `null`**，`image-pipeline.ts` 用它区分「不是 HDR」和「这次判不了」，后者保留上次构建的 `isHDR`，不覆写成 `false`。

### 查看器（`packages/webgl-viewer`）

1. `src/avif-gainmap.ts`（新）`extractAVIFGainMap()`：
   - 导出 `looksLikeAvif()`，同时支持 `avif`/`avis` 主品牌和 `mif1` 兼容品牌；
   - 从 `iref dimg` 找出 [主图, 增益图]，`iloc` 支持 `mdat` 绝对偏移、`idat` 相对偏移及 64 位偏移宽度；
   - `tmap` 载荷跳过首字节后交给现成的 `parseISOGainMap()`；
   - `useBaseColorSpace === false` 时优先读取挂在 **`tmap` 派生项**上的 `colr`（而非增益图本身无意义的 `nclx 2/2/6`），按 nclx（1/12/9 → sRGB / Display P3 / BT.2020）或 ICC 算 `toGainSpace` / `toDisplayP3`（列主序，与 `jpeg-gainmap.ts` 同一套矩阵）；
   - 把增益图的 `ispe` / `pixi` / `av1C` / `colr`（以及继承自`gainId`或主图的 `irot`/`imir`/`clap`）重新包成一个独立的迷你 AVIF `Blob`，`ipma` 对 `av1C`/`irot`/`imir`/`clap` 置 `essential = 1`（`0x80`），浏览器可原生 `createImageBitmap()` 硬解；
   - `orientation` 恒为 1：AVIF 的 `irot`/`imir` 由解码器应用（迷你容器里也带了一份），不能再按 EXIF 转一遍。
2. `src/webgpu-texture.worker.ts`：读前 64B 探测头并用 `looksLikeAvif()` 分派 JPEG / AVIF 两条解包路径，其它逻辑（增益图方向校验、overview、瓦片）不变。
3. WebGPU 渲染器与 `webgpu-shaders.ts` **一行没改**。

## 验证方式（可复现）

- 容器解析：真实样图解析出 `metadata.max = [3.80, 3.50, 3.56]`、`gamma ≈ 0.376–0.390`、`capacityMax = 2.93`。
- 迷你增益图容器：`sharp` 与 Chrome `createImageBitmap()` 均解出 **3888×5184** 增益图。
- 像素零篡改：`aviftest.avif` 经 `encodeThumbnailBuffer()` 编码后带 480B Display P3 `colr(rICC)`，用 `.keepIccProfile().raw()` 解出的像素与未贴标产物**逐字节完全一致**（`mdat` / 像素值零二次转换），且 `encodePreviewBuffer()` 与 `renderPhotoOgImage()`（WebP）均带有 `wide-gamut` P3 ICC。
- 单元测试：
  - `packages/builder/src/image/avif-color.test.ts`（9 例，含合成 8-bit RGB/RGBA `nclx` P3 AVIF 与真实样图的端到端缩略图/占位图/OG 卡验证，样图在 CI 不存在时自动跳过）；
  - `packages/webgl-viewer/src/avif-gainmap.test.ts`（12 例，覆盖 `tmap`/`iref`/`ipma`/`idat`/64-bit `iloc`/`mif1` 兼容品牌/旋转与 `essential` 标记/`useBaseColorSpace: false` 时读取 `tmap` 的 BT.2020 色域/非法版本）。

## 已知遗留

- **缩略图仍是 SDR**：只编基准层，不复制增益图，HDR 效果只在查看器里（原图 + `tmap`）出现。
- **PQ / HLG 传递函数的 AVIF 不贴标**：这类像素是 HDR 编码值，贴 SDR 标记只会更糟；真要支持得先做色调映射。
- Safari / Firefox 实测待验证（本机只有 Chrome 157 / Edge 158，已按 MIAF 规范补齐 `ipma` 的 `essential` 位）。
