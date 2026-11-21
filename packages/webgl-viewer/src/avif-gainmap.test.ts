import { describe, expect, it } from 'vitest'

import { extractAVIFGainMap, looksLikeAvif } from './avif-gainmap'
import { multiplyMatrices } from './jpeg-gainmap'

const text = new TextDecoder()
const encoder = new TextEncoder()

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xFF, value & 0xFF])
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF])
}

function u64(value: number): Uint8Array {
  const high = Math.floor(value / 0x100000000)
  const low = value >>> 0
  return join([u32(high), u32(low)])
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const data = join(parts)
  return join([u32(data.length + 8), encoder.encode(type), data])
}

function fullBox(type: string, version: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return box(type, u32(version << 24), ...parts)
}

function nclx(primaries: number, matrix = 6): Uint8Array<ArrayBuffer> {
  return box('colr', encoder.encode('nclx'), u16(primaries), u16(13), u16(matrix), new Uint8Array([0x80]))
}

/**
 * ISO 21496-1 payload：version/writer（4 字节）+ flags + capacity 两段 + 每通道五段，
 * 每段是 numerator/denominator 两个 u32。141 字节，和 Lightroom 写的长度一致。
 */
function isoMetadata(useBaseColorSpace: boolean): Uint8Array<ArrayBuffer> {
  const data: number[] = [0, 0, 0, 0, useBaseColorSpace ? 0xC0 : 0x80]
  const fraction = (numerator: number, denominator = 64) => {
    data.push(...u32(numerator >>> 0), ...u32(denominator))
  }
  fraction(0) // capacityMin
  fraction(192) // capacityMax = 3
  for (let channel = 0; channel < 3; channel++) {
    fraction(-64) // min = -1
    fraction(64) // max = 1
    fraction(32) // gamma = 0.5
    fraction(1) // offsetBase = 1/64
    fraction(1) // offsetAlternate = 1/64
  }
  return new Uint8Array(data)
}

interface FixtureOptions {
  tmap?: boolean
  basePrimaries?: number
  gainPrimaries?: number
  tmapPrimaries?: number
  useBaseColorSpace?: boolean
  rotation?: boolean
  tmapVersion?: number
  withGainColor?: boolean
  majorBrand?: string
  compatibleBrands?: string
  ilocOffsetSize?: 4 | 8
  splitIpma?: boolean
}

/**
 * 照 Lightroom 的布局造容器：item 1 主图 / item 4 增益图（mdat），item 5 tmap（idat），
 * `iref dimg:5 → [1,4]`，属性走 iprp/ipco/ipma。
 */
function makeAvif(options: FixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const {
    tmap = true,
    basePrimaries = 12,
    gainPrimaries = 2,
    tmapPrimaries,
    useBaseColorSpace = true,
    rotation = false,
    tmapVersion = 0,
    withGainColor = true,
    majorBrand = 'avif',
    compatibleBrands = 'avifmif1miaf',
    ilocOffsetSize = 4,
    splitIpma = false,
  } = options
  const baseData = new Uint8Array([0x12, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const gainData = new Uint8Array([0x12, 0x00, 21, 22, 23, 24, 25, 26])
  const tmapData = join([new Uint8Array([tmapVersion]), isoMetadata(useBaseColorSpace)])

  const ftyp = box('ftyp', encoder.encode(majorBrand), u32(0), encoder.encode(compatibleBrands))
  const properties: Uint8Array[] = [
    fullBox('ispe', 0, u32(64), u32(48)), // 1
    fullBox('pixi', 0, new Uint8Array([3, 10, 10, 10])), // 2
    box('av1C', new Uint8Array([0x81, 0x30, 0x40, 0x00])), // 3
    nclx(basePrimaries), // 4
    fullBox('ispe', 0, u32(16), u32(12)), // 5
    fullBox('pixi', 0, new Uint8Array([1, 10, 10, 10])), // 6
    box('av1C', new Uint8Array([0x81, 0x00, 0x40, 0x00])), // 7
  ]
  const baseProps = [1, 2, 3, 4]
  const gainProps = [5, 6, 7]
  if (withGainColor) {
    properties.push(nclx(gainPrimaries))
    gainProps.push(properties.length)
  }
  if (rotation) {
    properties.push(fullBox('irot', 0, new Uint8Array([1])))
    baseProps.push(properties.length)
  }
  let tmapColorIndex: number | null = null
  if (tmapPrimaries !== undefined) {
    properties.push(nclx(tmapPrimaries, 9))
    tmapColorIndex = properties.length
  }

  const writeOffset = (value: number) => (ilocOffsetSize === 8 ? u64(value) : u32(value))
  const sizeNibble = ilocOffsetSize === 8 ? 0x84 : 0x44

  const makeMeta = (mdatOffset: number) => {
    const items = [
      { id: 1, type: 'av01', name: 'Color' },
      { id: 4, type: 'av01', name: 'GMap' },
      ...(tmap ? [{ id: 5, type: 'tmap', name: 'GMap' }] : []),
    ]
    const ilocEntries = [
      join([u16(1), u16(0), u16(0), writeOffset(mdatOffset), u16(1), writeOffset(0), u32(baseData.length)]),
      join([u16(4), u16(0), u16(0), writeOffset(mdatOffset + baseData.length), u16(1), writeOffset(0), u32(gainData.length)]),
      ...(tmap
        ? [join([u16(5), u16(1), u16(0), writeOffset(0), u16(1), writeOffset(0), u32(tmapData.length)])]
        : []),
    ]
    const tmapProps = [1, ...(tmapColorIndex !== null ? [tmapColorIndex] : [])]
    const ipmaBoxes = splitIpma
      ? [
          box(
            'ipma',
            u32(0),
            u32(2),
            u16(1),
            new Uint8Array([baseProps.length]),
            ...baseProps.map(index => new Uint8Array([0x80 | index])),
            u16(4),
            new Uint8Array([1]),
            new Uint8Array([gainProps[0]]),
          ),
          box(
            'ipma',
            u32(0),
            u32(tmap ? 2 : 1),
            u16(4),
            new Uint8Array([gainProps.length - 1]),
            ...gainProps.slice(1).map(index => new Uint8Array([0x80 | index])),
            ...(tmap
              ? [u16(5), new Uint8Array([tmapProps.length]), ...tmapProps.map(index => new Uint8Array([index]))]
              : []),
          ),
        ]
      : [
          box(
            'ipma',
            u32(0),
            u32(tmap ? 3 : 2),
            u16(1),
            new Uint8Array([baseProps.length]),
            ...baseProps.map(index => new Uint8Array([0x80 | index])),
            u16(4),
            new Uint8Array([gainProps.length]),
            ...gainProps.map(index => new Uint8Array([0x80 | index])),
            ...(tmap
              ? [u16(5), new Uint8Array([tmapProps.length]), ...tmapProps.map(index => new Uint8Array([index]))]
              : []),
          ),
        ]

    return fullBox(
      'meta',
      0,
      fullBox('hdlr', 0, u32(0), encoder.encode('pict'), new Uint8Array(13)),
      fullBox('pitm', 0, u16(1)),
      fullBox(
        'iloc',
        1,
        new Uint8Array([sizeNibble, sizeNibble & 0xF0]),
        u16(ilocEntries.length),
        ...ilocEntries,
      ),
      fullBox(
        'iinf',
        0,
        u16(items.length),
        ...items.map(item =>
          box('infe', u32(2 << 24), u16(item.id), u16(0), encoder.encode(item.type), join([encoder.encode(item.name), new Uint8Array([0])]))),
      ),
      ...(tmap ? [fullBox('iref', 0, box('dimg', u16(5), u16(2), u16(1), u16(4)))] : []),
      box(
        'iprp',
        box('ipco', ...properties),
        ...ipmaBoxes,
      ),
      box('idat', tmapData),
    )
  }

  const mdatOffset = ftyp.length + makeMeta(0).length + 8
  return join([ftyp, makeMeta(mdatOffset), box('mdat', baseData, gainData)])
}

function readMiniAvifPropertyAssociations(bytes: Uint8Array): Array<{ type: string, essential: boolean }> {
  const ipcoIdx = bytes.indexOf(0x69) // find 'ipco' via string scan on small container
  void ipcoIdx
  const findBoxOffset = (type: string, start: number, end: number): { data: number, end: number } => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let cursor = start; cursor < end;) {
      const size = view.getUint32(cursor)
      const fourcc = text.decode(bytes.subarray(cursor + 4, cursor + 8))
      if (fourcc === type) {
        return { data: cursor + 8, end: cursor + size }
      }
      cursor += size
    }
    throw new Error(`Missing box ${type}`)
  }
  const meta = findBoxOffset('meta', 0, bytes.length)
  const iprp = findBoxOffset('iprp', meta.data + 4, meta.end)
  const ipco = findBoxOffset('ipco', iprp.data, iprp.end)
  const ipma = findBoxOffset('ipma', iprp.data, iprp.end)

  const propTypes: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let cursor = ipco.data; cursor < ipco.end;) {
    const size = view.getUint32(cursor)
    propTypes.push(text.decode(bytes.subarray(cursor + 4, cursor + 8)))
    cursor += size
  }
  const assocCount = bytes[ipma.data + 10]
  const result: Array<{ type: string, essential: boolean }> = []
  for (let i = 0; i < assocCount; i++) {
    const raw = bytes[ipma.data + 11 + i]
    result.push({
      type: propTypes[(raw & 0x7F) - 1],
      essential: (raw & 0x80) !== 0,
    })
  }
  return result
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function expectMatrix(actual: number[], expected: number[]) {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 4))
}

describe('looksLikeAvif', () => {
  it('accepts avif major brand and mif1 with avif compatible brand on 64B probes', () => {
    const mif1 = makeAvif({ majorBrand: 'mif1', compatibleBrands: 'mif1avifmiaf' })
    expect(looksLikeAvif(mif1)).toBe(true)
    expect(looksLikeAvif(mif1.subarray(0, 64))).toBe(true)
    expect(looksLikeAvif(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46]))).toBe(false)
  })
})

describe('extractAVIFGainMap', () => {
  it('ignores non-AVIF payloads', () => {
    expect(extractAVIFGainMap(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer)).toBeNull()
  })

  it('returns null for AVIF without a tmap item', () => {
    expect(extractAVIFGainMap(toArrayBuffer(makeAvif({ tmap: false })))).toBeNull()
  })

  it('parses the ISO 21496-1 metadata out of the tmap item', () => {
    const result = extractAVIFGainMap(toArrayBuffer(makeAvif()))
    expect(result).not.toBeNull()
    const { metadata } = result!
    expect(metadata.capacityMin).toBeCloseTo(0, 6)
    expect(metadata.capacityMax).toBeCloseTo(3, 6)
    expect(metadata.min).toEqual([-1, -1, -1])
    expect(metadata.max).toEqual([1, 1, 1])
    expect(metadata.gamma).toEqual([0.5, 0.5, 0.5])
    expect(metadata.offsetBase).toEqual([1 / 64, 1 / 64, 1 / 64])
    expect(metadata.useBaseColorSpace).toBe(true)
  })

  it('keeps the original file as base and wraps the gain item into a valid mini AVIF', async () => {
    const source = makeAvif()
    const result = extractAVIFGainMap(toArrayBuffer(source))!
    expect(result.base.size).toBe(source.length)
    expect(result.base.type).toBe('image/avif')
    expect(result.gain.type).toBe('image/avif')

    const gain = new Uint8Array(await result.gain.arrayBuffer())
    expect(text.decode(gain.subarray(4, 8))).toBe('ftyp')
    expect(text.decode(gain)).toContain('mdat')
    expect(Array.from(gain.subarray(gain.length - 8))).toEqual([0x12, 0x00, 21, 22, 23, 24, 25, 26])
    expect(result.orientation).toBe(1)

    // MIAF / Safari 规范要求 av1C 标记为 essential
    const associations = readMiniAvifPropertyAssociations(gain)
    expect(associations).toEqual([
      { type: 'ispe', essential: false },
      { type: 'pixi', essential: false },
      { type: 'av1C', essential: true },
      { type: 'colr', essential: false },
    ])
  })

  it('derives identity matrices when base is Display P3 and the gain map uses the base space', () => {
    const result = extractAVIFGainMap(toArrayBuffer(makeAvif({ basePrimaries: 12 })))!
    expectMatrix(result.toDisplayP3, [1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(result.wideGamut).toBe(false)
  })

  it('uses tmap color space (not gainId 2/2/6) when useBaseColorSpace is false', () => {
    // 真实 Lightroom 输出中 gainId 挂的是 2/2/6 (Unspecified)，alternate 空间 (BT.2020 = 9) 挂在 tmap 上
    const result = extractAVIFGainMap(
      toArrayBuffer(makeAvif({ basePrimaries: 12, gainPrimaries: 2, tmapPrimaries: 9, useBaseColorSpace: false })),
    )!
    const srgbResult = extractAVIFGainMap(
      toArrayBuffer(makeAvif({ basePrimaries: 12, gainPrimaries: 2, tmapPrimaries: 1, useBaseColorSpace: false })),
    )!
    // 若误读了 gainId 的 2/2/6，toDisplayP3 会退化成 sRGB 矩阵而与 BT.2020 不同
    expect(result.toDisplayP3[0]).not.toBeCloseTo(srgbResult.toDisplayP3[0], 2)
    expectMatrix(multiplyMatrices(result.toGainSpace, result.toDisplayP3), [1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('maps sRGB base to Display P3 and back consistently', () => {
    const result = extractAVIFGainMap(toArrayBuffer(makeAvif({ basePrimaries: 1 })))!
    expectMatrix(multiplyMatrices(result.toGainSpace, result.toDisplayP3), [1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(result.wideGamut).toBe(false)
  })

  it('flags Rec.2020 bases as wider than Display P3', () => {
    const result = extractAVIFGainMap(toArrayBuffer(makeAvif({ basePrimaries: 9 })))!
    expect(result.wideGamut).toBe(true)
  })

  it('carries the base rotation onto the gain item and marks it essential', async () => {
    const result = extractAVIFGainMap(toArrayBuffer(makeAvif({ rotation: true })))!
    const gain = new Uint8Array(await result.gain.arrayBuffer())
    const associations = readMiniAvifPropertyAssociations(gain)
    expect(associations.find(entry => entry.type === 'irot')).toEqual({ type: 'irot', essential: true })
  })

  it('supports 64-bit iloc offsets and split ipma boxes', async () => {
    const source = makeAvif({
      majorBrand: 'mif1',
      compatibleBrands: 'mif1avifmiaf',
      ilocOffsetSize: 8,
      splitIpma: true,
      basePrimaries: 12,
    })
    const result = extractAVIFGainMap(toArrayBuffer(source))!
    expectMatrix(result.toDisplayP3, [1, 0, 0, 0, 1, 0, 0, 0, 1])
    const gain = new Uint8Array(await result.gain.arrayBuffer())
    expect(Array.from(gain.subarray(gain.length - 8))).toEqual([0x12, 0x00, 21, 22, 23, 24, 25, 26])
  })

  it('rejects unsupported tmap versions instead of guessing', () => {
    expect(() => extractAVIFGainMap(toArrayBuffer(makeAvif({ tmapVersion: 2 })))).toThrow(/tmap version/)
  })
})
