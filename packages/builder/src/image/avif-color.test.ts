import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { detectAvifGainMap } from '../photo/gainmap-detector'
import { renderPhotoOgImage } from '../plugins/og-image-storage/photo-og'
import {
  hasAvifGainMap,
  isAvif,
  isAvifDisplayP3,
  isSdrTransfer,
  readAvifInfo,
} from './avif-color'
import { classifyIccProfile, resolveColorProfileStrategy } from './color-profile'
import { encodePreviewBuffer } from './preview'
import { encodeThumbnailBuffer } from './thumbnail'

const encoder = new TextEncoder()

/** 本机缓存里的 Lightroom AVIF Ultra HDR 样图（gitignore，CI 上没有 → 相关用例跳过）。 */
const SAMPLE = new URL('../../../../apps/web/src/data/.cache/originals/aviftest.avif', import.meta.url)

function u16(value: number): Buffer {
  return Buffer.from([(value >> 8) & 0xFF, value & 0xFF])
}

function u32(value: number): Buffer {
  return Buffer.from([(value >>> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF])
}

function box(type: string, ...parts: Uint8Array[]): Buffer {
  const data = Buffer.concat(parts.map(part => Buffer.from(part)))
  return Buffer.concat([u32(data.length + 8), Buffer.from(type, 'latin1'), data])
}

function fullBox(type: string, version: number, ...parts: Uint8Array[]): Buffer {
  return box(type, u32(version << 24), ...parts)
}

/** 造一个结构完整（ftyp/meta/iinf/pitm/iloc/iprp/mdat）但像素无意义的 AVIF。 */
function makeContainer(options: {
  items: { id: number, type: string }[]
  primary: number
  primaries?: number
  transfer?: number
  matrix?: number
  majorBrand?: string
  compatibleBrands?: string
}): Buffer {
  const {
    items,
    primary,
    primaries,
    transfer = 13,
    matrix = 6,
    majorBrand = 'avif',
    compatibleBrands = 'avifmif1miaf',
  } = options
  const properties = [
    fullBox('ispe', 0, u32(32), u32(24)),
    ...(primaries
      ? [box('colr', encoder.encode('nclx'), u16(primaries), u16(transfer), u16(matrix), Buffer.from([0x80]))]
      : []),
  ]
  const mdatData = Buffer.from([0x12, 0x00, 0xAA, 0xBB])
  const makeMeta = (mdatOffset: number) => fullBox(
    'meta',
    0,
    fullBox('hdlr', 0, u32(0), encoder.encode('pict'), Buffer.alloc(13)),
    fullBox('pitm', 0, u16(primary)),
    fullBox(
      'iloc',
      0,
      Buffer.from([0x44, 0x40]),
      u16(1),
      u16(primary),
      u16(0),
      u32(mdatOffset),
      u16(1),
      u32(0),
      u32(mdatData.length),
    ),
    fullBox('iinf', 0, u16(items.length), ...items.map(item =>
      box('infe', u32(2 << 24), u16(item.id), u16(0), encoder.encode(item.type), Buffer.from([0])))),
    box(
      'iprp',
      box('ipco', ...properties),
      box('ipma', u32(0), u32(1), u16(primary), Buffer.from([properties.length]), ...properties.map((_, i) => Buffer.from([i + 1]))),
    ),
  )
  const ftyp = box('ftyp', encoder.encode(majorBrand), u32(0), encoder.encode(compatibleBrands))
  const mdatOffset = ftyp.length + makeMeta(0).length + 8
  return Buffer.concat([ftyp, makeMeta(mdatOffset), box('mdat', mdatData)])
}

async function encodePlainAvif(channels: 3 | 4 = 3): Promise<Buffer> {
  const pixel = channels === 4 ? [255, 40, 10, 200] : [255, 40, 10]
  const raw = Buffer.from(Array.from({ length: 16 * 16 }).fill(pixel).flat() as number[])
  return await sharp(raw, {
    raw: { width: 16, height: 16, channels },
  })
    .avif({ lossless: true, effort: 0 })
    .toBuffer()
}

async function encodeNclxP3Avif(channels: 3 | 4 = 3): Promise<Buffer> {
  const avif = await encodePlainAvif(channels)
  const nclxPos = avif.indexOf('nclx', 0, 'ascii')
  expect(nclxPos).toBeGreaterThan(-1)
  const patched = Buffer.from(avif)
  // 只改 primaries 为 Display P3 (12)，保留 lossless 码流实际的 transfer(13)/matrix(0)
  patched.writeUInt16BE(12, nclxPos + 4)
  return patched
}

describe('isAvif', () => {
  it('accepts avif major and compatible brands even on a 64B header probe, and rejects jpeg', async () => {
    const plain = new Uint8Array(await encodePlainAvif())
    expect(isAvif(plain)).toBe(true)
    expect(isAvif(plain.subarray(0, 64))).toBe(true)

    const mif1 = makeContainer({
      items: [{ id: 1, type: 'av01' }],
      primary: 1,
      majorBrand: 'mif1',
      compatibleBrands: 'mif1avifmiaf',
    })
    expect(isAvif(mif1)).toBe(true)
    expect(isAvif(mif1.subarray(0, 64))).toBe(true)

    expect(isAvif(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46]))).toBe(false)
  })
})

describe('readAvifInfo', () => {
  it('reports the CICP of the primary item and no gain map for plain AVIF', async () => {
    const info = readAvifInfo(new Uint8Array(await encodePlainAvif()))
    expect(info?.primaryType).toBe('av01')
    expect(info?.hasGainMap).toBe(false)
    expect(info?.color).toEqual({ primaries: 1, transfer: 13, matrix: 0, fullRange: true })
  })

  it('detects the tmap derivative item used by AVIF Ultra HDR', () => {
    const container = makeContainer({
      items: [
        { id: 1, type: 'av01' },
        { id: 4, type: 'av01' },
        { id: 5, type: 'tmap' },
      ],
      primary: 1,
      primaries: 12,
    })
    const info = readAvifInfo(new Uint8Array(container))
    expect(info?.hasGainMap).toBe(true)
    expect(info?.color).toEqual({ primaries: 12, transfer: 13, matrix: 6, fullRange: true })
    expect(hasAvifGainMap(container)).toBe(true)
  })

  it('still parses meta when truncated inside trailing mdat', () => {
    const container = makeContainer({
      items: [
        { id: 1, type: 'av01' },
        { id: 5, type: 'tmap' },
      ],
      primary: 1,
      primaries: 12,
    })
    // 截掉 mdat 的最后一个字节，使 mdat declared size 超出缓冲区，但 meta 本身完整
    const truncatedInMdat = container.subarray(0, container.length - 1)
    expect(hasAvifGainMap(truncatedInMdat)).toBe(true)
  })

  it('returns null for unparseable containers and false for non-AVIF', () => {
    expect(readAvifInfo(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]))).toBeNull()
    expect(hasAvifGainMap(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]))).toBe(false)
    const truncated = makeContainer({ items: [{ id: 1, type: 'av01' }], primary: 1 }).subarray(0, 12)
    expect(hasAvifGainMap(truncated)).toBe(false)
  })
})

describe('isAvifDisplayP3 and color profile strategy', () => {
  it('recognizes Display P3 SDR AVIFs and skips sRGB or HDR transfer functions', async () => {
    const srgb = await encodePlainAvif()
    expect(isAvifDisplayP3(srgb)).toBe(false)
    expect(await resolveColorProfileStrategy(srgb)).toBe('srgb')

    const p3 = await encodeNclxP3Avif()
    expect(isAvifDisplayP3(p3)).toBe(true)
    expect(await resolveColorProfileStrategy(p3)).toBe('attach-p3')

    const pq = makeContainer({ items: [{ id: 1, type: 'av01' }], primary: 1, primaries: 12, transfer: 16 })
    expect(isAvifDisplayP3(pq)).toBe(false)
    expect(isSdrTransfer({ primaries: 12, transfer: 16, matrix: 9, fullRange: true })).toBe(false)
  })

  it('attaches P3 ICC to thumbnail, preview, and OG WebP without double-converting pixels', async () => {
    for (const channels of [3, 4] as const) {
      const source = await encodeNclxP3Avif(channels)
      const [thumb, preview, og] = await Promise.all([
        encodeThumbnailBuffer(source),
        encodePreviewBuffer(source),
        renderPhotoOgImage(source),
      ])

      for (const output of [thumb, preview, og]) {
        const meta = await sharp(output).metadata()
        expect(meta.hasProfile).toBe(true)
        expect(classifyIccProfile(meta.icc!)).toBe('wide-gamut')
      }

      // 编码时像素值不得经过 sRGB→P3 二次转换：高饱和 [255, 40, 10] 在 P3 空间仍保持饱和
      const rawThumb = await sharp(thumb).keepIccProfile().raw().toBuffer()
      expect(rawThumb[0]).toBeGreaterThanOrEqual(250)
      expect(rawThumb[1]).toBeLessThanOrEqual(45)
      expect(rawThumb[2]).toBeLessThanOrEqual(15)
    }
  })

  it.skipIf(!existsSync(SAMPLE))('handles real Lightroom AVIF Ultra HDR sample end-to-end', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(SAMPLE)

    const info = readAvifInfo(new Uint8Array(source))
    expect(info?.color).toEqual({ primaries: 12, transfer: 13, matrix: 6, fullRange: true })
    expect(info?.hasGainMap).toBe(true)
    expect(await resolveColorProfileStrategy(source)).toBe('attach-p3')

    const [thumbnail, preview, og] = await Promise.all([
      encodeThumbnailBuffer(source),
      encodePreviewBuffer(source),
      renderPhotoOgImage(source),
    ])

    for (const output of [thumbnail, preview, og]) {
      const meta = await sharp(output).metadata()
      expect(meta.hasProfile).toBe(true)
      expect(classifyIccProfile(meta.icc!)).toBe('wide-gamut')
    }

    const thumbMeta = await sharp(thumbnail).metadata()
    expect(thumbMeta.width).toBe(500)

    // 贴标前后解码像素逐字节一致（未触发 sRGB→P3 二次转换）
    const untagged = await sharp(source)
      .rotate()
      .resize(500, null, { withoutEnlargement: true })
      .avif({ quality: 70, effort: 6, bitdepth: 10 })
      .toBuffer()
    const before = await sharp(untagged).raw().toBuffer()
    const after = await sharp(thumbnail).keepIccProfile().raw().toBuffer()
    expect(after.equals(before)).toBe(true)
  })
})

describe('detectAvifGainMap', () => {
  it('detects tmap containers from buffer and file path while skipping non-AVIF fast', async () => {
    const hdrAvif = makeContainer({
      items: [
        { id: 1, type: 'av01' },
        { id: 5, type: 'tmap' },
      ],
      primary: 1,
      primaries: 12,
    })
    expect(await detectAvifGainMap(hdrAvif)).toBe(true)
    expect(await detectAvifGainMap(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]))).toBe(false)
    expect(await detectAvifGainMap(undefined, undefined)).toBeNull()

    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'afilmory-avif-test-'))
    try {
      const avifFile = path.join(tmpDir, 'sample.avif')
      const jpgFile = path.join(tmpDir, 'sample.jpg')
      await writeFile(avifFile, hdrAvif)
      await writeFile(jpgFile, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46]))
      expect(await detectAvifGainMap(undefined, avifFile)).toBe(true)
      expect(await detectAvifGainMap(undefined, jpgFile)).toBe(false)
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
