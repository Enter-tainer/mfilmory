import type { Buffer } from 'node:buffer'

import sharp from 'sharp'

/**
 * 决定这张图 AVIF 编码用几位。
 *
 * 10-bit 的收益来自 libaom 内部量化更细（同 SSIMULACRA2 下体积更小），与源图位深无关。
 * 但**带 alpha 的源图必须回退 8-bit**：Safari 对「10-bit + alpha」的 AVIF 有过不渲染的
 * 报告（WebKit #245669，转 Apple radar 后无公开结论），不透明图不受影响。
 *
 * 注意签名仍然只记录「策略」（`...b10.avif`），不记录单张图实际落到的位深——
 * 入口门禁拿签名判断「参数有没有变」，而 alpha 是源图属性、重编码时结论一致。
 */
export async function resolveAvifBitdepth(
  target: 8 | 10,
  imageBuffer: Buffer,
  limitInputPixels?: number | boolean,
): Promise<8 | 10> {
  if (target === 8) {
    return 8
  }

  try {
    const { hasAlpha } = await sharp(imageBuffer, { limitInputPixels }).metadata()
    return hasAlpha ? 8 : 10
  }
  catch {
    // 读不出元信息时保持目标位深：编码本身会再抛一次，错误照常冒泡。
    return target
  }
}
