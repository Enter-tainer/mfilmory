import type { Buffer } from 'node:buffer'

import type { Sharp } from 'sharp'
import sharp from 'sharp'

import { isAvifDisplayP3 } from './avif-color.js'

/**
 * 源图 ICC Profile 的保留策略。
 *
 * sharp（libvips）默认把内嵌 ICC 转成 sRGB、并把 Profile 从输出里剥掉。对 Display P3
 * 这类广色域原图，这一步会把超出 sRGB 的颜色硬裁到 0/255：高饱和的秋叶、霓虹、舞台光
 * 尤其明显。而原图在查看器里是按 P3 渲染的（`WebGPUImageViewerEngine` 的
 * `colorSpace: 'display-p3'`），于是「缩略图 / 占位图 → 原图」会看到明显的颜色跳变
 * （gallery.mgt.moe 的 20261121-MGT07132 就是这个症状）。
 *
 * 但也不该无条件 `.keepIccProfile()`：Lightroom 导出的 sRGB 原图内嵌的是 3.1KB 的
 * HP/Microsoft sRGB IEC61966-2.1 Profile，保留它每张产物白多 3KB，像素却没有一个字节
 * 的变化——没有 Profile 的 AVIF / WebP 在浏览器里本来就按 sRGB 解释。所以只保留
 * 「RGB 矩阵 + 原色不等于 sRGB」的 Profile，其余照旧交给 sharp 转换并剥离。
 *
 * 判据是 ICC 自己的 rXYZ / gXYZ / bXYZ（PCS 为 D50）：sRGB 的原色与 P3 / Adobe RGB /
 * ProPhoto / Rec.2020 差得远，而各家 sRGB Profile 只是把这些数四舍五入到 4 位小数，
 * 所以容差 0.002（8-bit 下不到 1/255）足以区分。认不出的一律按「不保留」处理：
 * 非 RGB（Gray / CMYK）、头部签名不对、Profile 截断，都让 libvips 走默认的 sRGB 转换，
 * 免得把不相干的 Profile 贴到 RGB 输出上。
 */

/** sRGB 原色（ICC XYZType，PCS D50），取自 IEC 61966-2-1。 */
const SRGB_COLORANTS = [
  0.4360747,
  0.2225045,
  0.0139322, // rXYZ
  0.3850649,
  0.7168786,
  0.0971045, // gXYZ
  0.1430804,
  0.0606169,
  0.7141733, // bXYZ
]
const COLORANT_TOLERANCE = 0.002
/** ICC 头固定 128 字节，紧随其后是 tag 数量（uint32）。 */
const ICC_HEADER_SIZE = 128
const ICC_TAG_ENTRY_SIZE = 12

/** 头部 'acsp' 签名 + 'RGB ' 数据色彩空间。 */
function hasRgbHeader(icc: Buffer): boolean {
  return icc.length >= ICC_HEADER_SIZE + 4
    && icc.toString('latin1', 36, 40) === 'acsp'
    && icc.toString('latin1', 16, 20) === 'RGB '
}

function findTagOffset(icc: Buffer, signature: string): number | null {
  const count = icc.readUInt32BE(ICC_HEADER_SIZE)
  if (count === 0 || ICC_HEADER_SIZE + 4 + count * ICC_TAG_ENTRY_SIZE > icc.length) {
    return null
  }
  for (let index = 0; index < count; index++) {
    const entry = ICC_HEADER_SIZE + 4 + index * ICC_TAG_ENTRY_SIZE
    if (icc.toString('latin1', entry, entry + 4) !== signature) {
      continue
    }
    const offset = icc.readUInt32BE(entry + 4)
    // XYZType：4 字节 'XYZ ' + 4 字节保留 + 3 个 s15Fixed16
    return offset + 20 <= icc.length ? offset : null
  }
  return null
}

function readColorants(icc: Buffer): number[] | null {
  if (!hasRgbHeader(icc)) {
    return null
  }
  const colorants: number[] = []
  for (const signature of ['rXYZ', 'gXYZ', 'bXYZ']) {
    const offset = findTagOffset(icc, signature)
    if (offset === null || icc.toString('latin1', offset, offset + 4) !== 'XYZ ') {
      return null
    }
    for (let axis = 0; axis < 3; axis++) {
      colorants.push(icc.readInt32BE(offset + 8 + axis * 4) / 65536)
    }
  }
  return colorants
}

/** 解析结论：sRGB（可安全剥离）/ 广色域（要保留）/ 认不出（按不保留处理）。 */
export function classifyIccProfile(icc: Buffer): 'srgb' | 'wide-gamut' | 'unknown' {
  const colorants = readColorants(icc)
  if (!colorants) {
    return 'unknown'
  }
  return colorants.every((value, index) => Math.abs(value - SRGB_COLORANTS[index]) <= COLORANT_TOLERANCE)
    ? 'srgb'
    : 'wide-gamut'
}

/** 编码产物时是否要 `.keepIccProfile()`：只有确认是广色域 RGB 才保留。 */
export function shouldKeepIccProfile(icc: Buffer | undefined): boolean {
  if (!icc || icc.length < ICC_HEADER_SIZE + 4) {
    return false
  }
  return classifyIccProfile(icc) === 'wide-gamut'
}

export type ColorProfileStrategy = 'keep-icc' | 'attach-p3' | 'srgb'

/**
 * 读源图元信息再判断要不要保留 ICC。
 *
 * 与 `resolveAvifBitdepth` 一样只记录「策略」，不记录单张图的结论：签名描述的是
 * 「用哪套规则编的」，Profile 是源图属性，重编码时结论必然一致。
 */
export async function resolveIccPreservation(
  imageBuffer: Buffer,
  limitInputPixels?: number | boolean,
): Promise<boolean> {
  return (await resolveColorProfileStrategy(imageBuffer, limitInputPixels)) === 'keep-icc'
}

/**
 * 决定编码产物的色彩配置策略：
 * - `'keep-icc'`：源图内嵌广色域 ICC（如 Display P3 JPEG），原样保留；
 * - `'attach-p3'`：源图是没有 ICC、仅通过 `colr/nclx` 标记为 Display P3（SDR 传递函数）的 AVIF；
 *   libvips 解码这种图不会做色域转换且会丢掉标记，必须配合 `pipelineColourspace('rgb16').withIccProfile('p3')`
 *   原样保留像素值并挂上 P3 ICC；
 * - `'srgb'`：sRGB 或未知配置，走 sharp 默认转换并剥离冗余 ICC。
 */
export async function resolveColorProfileStrategy(
  imageBuffer: Buffer,
  limitInputPixels?: number | boolean,
): Promise<ColorProfileStrategy> {
  try {
    const { icc } = await sharp(imageBuffer, { limitInputPixels }).metadata()
    if (shouldKeepIccProfile(icc)) {
      return 'keep-icc'
    }
    if (!icc && isAvifDisplayP3(imageBuffer)) {
      return 'attach-p3'
    }
    return 'srgb'
  }
  catch {
    // 读不出元信息时保持 sharp 默认（转 sRGB 并剥离）；编码阶段会再抛一次。
    return 'srgb'
  }
}

/** 将 `resolveColorProfileStrategy` 决定的策略应用到 sharp 管线。 */
export function applyColorProfileStrategy(pipeline: Sharp, strategy: ColorProfileStrategy): Sharp {
  if (strategy === 'keep-icc') {
    return pipeline.keepIccProfile()
  }
  if (strategy === 'attach-p3') {
    // `pipelineColourspace('rgb16')` 阻止 sharp 对无 ICC 输入执行 sRGB→P3 转换，只把 P3 ICC 写进输出容器。
    return pipeline.pipelineColourspace('rgb16').withIccProfile('p3')
  }
  return pipeline
}
