import type { GainMapMetadata, Matrix3 } from './jpeg-gainmap'
import {
  inverseMatrix,
  multiplyMatrices,
  P3_TO_XYZ,
  parseIccColorants,
  parseISOGainMap,
  SRGB_TO_XYZ,
} from './jpeg-gainmap'

/**
 * AVIF Ultra HDR（ISO 21496-1 gain map）解包。
 *
 * Lightroom Classic 导出的 AVIF HDR 结构（实测 P1120094.RW2 → aviftest.avif）：
 *
 *   ftyp(avif, 兼容品牌含 tmap)
 *   meta
 *     pitm    → 1（主图）
 *     iinf    1 Color(av01) / 2 Exif / 3 mime(XMP) / 4 GMap(av01) / 5 GMap(tmap)
 *     iref    dimg: 5 → [1, 4]     tmap 派生项指向 [主图, 增益图]
 *     iloc    1/4 在 mdat，5（tmap）在 idat
 *     iprp    colr(nclx 12/13/6) 挂在主图；colr(nclx 2/2/6) 挂在增益图；colr(nclx 9/16/9) 挂在 tmap 上
 *
 * tmap 项载荷 = 1 字节 version + 141 字节 ISO 21496-1 二进制元数据，去掉首字节后
 * 现有的 `parseISOGainMap()` 能直接解析。增益图是普通 av01 辅助图，浏览器可原生硬解，
 * 所以这里把它连同 ispe/pixi/av1C/colr 重新包成一个**独立的迷你 AVIF**，交给
 * `createImageBitmap()` —— WebGPU 渲染器与 WGSL 一行都不用改。
 *
 * 任何一步不符合预期都抛错：调用方（纹理 worker）会把这一张图降级成 SDR，而不是整页失败。
 */

interface Box {
  type: string
  start: number
  data: number
  end: number
}

interface Item {
  id: number
  type: string
}

const text = new TextDecoder()
const encoder = new TextEncoder()
const MAX_BOXES = 4096
const ESSENTIAL_PROPERTIES = new Set(['av1C', 'irot', 'imir', 'clap'])

/**
 * BT.2020 原色 → XYZ（PCS D50，Bradford 适配），与 `SRGB_TO_XYZ` / `P3_TO_XYZ` 同一坐标系，
 * 列主序。只用于 gain space → Display P3 的换算。
 */
const BT2020_TO_XYZ: Matrix3 = [
  0.60123,
  0.119361,
  0.172748,
  0.250637,
  0.680832,
  0.034269,
  0.045753,
  0.060709,
  1.422928,
]

function u16(bytes: Uint8Array, offset: number, end: number): number {
  if (offset < 0 || offset + 2 > end) {
    throw new Error('Truncated AVIF box')
  }
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function u32(bytes: Uint8Array, offset: number, end: number): number {
  if (offset < 0 || offset + 4 > end) {
    throw new Error('Truncated AVIF box')
  }
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
}

function fourcc(bytes: Uint8Array, offset: number, end: number): string {
  if (offset < 0 || offset + 4 > end) {
    throw new Error('Truncated AVIF box')
  }
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readBoxAt(bytes: Uint8Array, cursor: number, end: number): Box {
  const declared = u32(bytes, cursor, end)
  const header = declared === 1 ? 16 : 8
  let size = declared
  if (declared === 1) {
    if (u32(bytes, cursor + 8, end) !== 0) {
      throw new Error('AVIF box too large')
    }
    size = u32(bytes, cursor + 12, end)
  }
  else if (declared === 0) {
    size = end - cursor
  }
  if (size < header || cursor + size > end) {
    throw new Error('AVIF box out of bounds')
  }
  return { type: fourcc(bytes, cursor + 4, cursor + 8), start: cursor, data: cursor + header, end: cursor + size }
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const list: Box[] = []
  for (let cursor = start; cursor < end;) {
    if (list.length >= MAX_BOXES) {
      throw new Error('Too many AVIF boxes')
    }
    const current = readBoxAt(bytes, cursor, end)
    list.push(current)
    cursor = current.end
  }
  return list
}

function findBox(list: Box[], type: string): Box | undefined {
  return list.find(box => box.type === type)
}

function requireBox(list: Box[], type: string): Box {
  const box = findBox(list, type)
  if (!box) {
    throw new Error(`Missing AVIF ${type} box`)
  }
  return box
}

/**
 * `ftyp` 主品牌或兼容品牌属于 AVIF（`avif` / `avis`）。
 * 只读第一个 box，允许在仅切出文件头的探测切片（如 64B）上安全调用。
 */
export function looksLikeAvif(bytes: Uint8Array): boolean {
  try {
    if (bytes.length < 16 || fourcc(bytes, 4, bytes.length) !== 'ftyp') {
      return false
    }
    const major = fourcc(bytes, 8, bytes.length)
    if (major === 'avif' || major === 'avis') {
      return true
    }
    const ftyp = readBoxAt(bytes, 0, bytes.length)
    if (ftyp.type !== 'ftyp') {
      return false
    }
    for (let cursor = ftyp.data + 8; cursor + 4 <= ftyp.end; cursor += 4) {
      const brand = fourcc(bytes, cursor, ftyp.end)
      if (brand === 'avif' || brand === 'avis') {
        return true
      }
    }
    return false
  }
  catch {
    return false
  }
}

function parseItems(bytes: Uint8Array, iinf: Box): Map<number, string> {
  if (iinf.data + 4 > iinf.end) {
    throw new Error('Truncated AVIF iinf')
  }
  const version = bytes[iinf.data]
  if (version > 1) {
    throw new Error('Unsupported AVIF iinf version')
  }
  const cursor = iinf.data + 4 + (version === 0 ? 2 : 4)
  if (cursor > iinf.end) {
    throw new Error('Truncated AVIF iinf')
  }
  const items = new Map<number, string>()
  for (const box of boxes(bytes, cursor, iinf.end)) {
    if (box.type !== 'infe') {
      continue
    }
    if (box.data >= box.end) {
      throw new Error('Truncated AVIF infe')
    }
    const infeVersion = bytes[box.data]
    if (infeVersion !== 2 && infeVersion !== 3) {
      throw new Error('Unsupported AVIF infe version')
    }
    const idSize = infeVersion === 3 ? 4 : 2
    const id = idSize === 4 ? u32(bytes, box.data + 4, box.end) : u16(bytes, box.data + 4, box.end)
    items.set(id, fourcc(bytes, box.data + 4 + idSize + 2, box.end))
  }
  return items
}

function parseProperties(bytes: Uint8Array, iprp: Box): Map<number, Box[]> {
  const children = boxes(bytes, iprp.data, iprp.end)
  const ipco = requireBox(children, 'ipco')
  const list = boxes(bytes, ipco.data, ipco.end)
  const byId = new Map<number, Box[]>()
  for (const ipma of children.filter(box => box.type === 'ipma')) {
    if (ipma.data + 8 > ipma.end) {
      throw new Error('Truncated AVIF ipma')
    }
    const version = bytes[ipma.data]
    if (version > 1) {
      throw new Error('Unsupported AVIF ipma version')
    }
    const flags = bytes[ipma.data + 1] * 0x10000 + (bytes[ipma.data + 2] << 8) + bytes[ipma.data + 3]
    const indexSize = flags & 1 ? 2 : 1
    let cursor = ipma.data + 4
    // entry_count 恒为 32 位；版本只决定 item_ID 的宽度
    const count = u32(bytes, cursor, ipma.end)
    cursor += 4
    for (let i = 0; i < count; i++) {
      const id = version === 0 ? u16(bytes, cursor, ipma.end) : u32(bytes, cursor, ipma.end)
      cursor += version === 0 ? 2 : 4
      if (cursor + 1 > ipma.end) {
        throw new Error('Truncated AVIF ipma')
      }
      const associated = bytes[cursor]
      cursor += 1
      const properties = byId.get(id) ?? []
      for (let j = 0; j < associated; j++) {
        const raw = indexSize === 2 ? u16(bytes, cursor, ipma.end) : bytes[cursor]
        cursor += indexSize
        const index = indexSize === 2 ? raw & 0x7FFF : raw & 0x7F
        if (index > 0 && index <= list.length) {
          properties.push(list[index - 1])
        }
      }
      byId.set(id, properties)
    }
  }
  return byId
}

function parseReferences(bytes: Uint8Array, iref: Box): Map<string, number[]> {
  if (iref.data + 4 > iref.end) {
    throw new Error('Truncated AVIF iref')
  }
  const version = bytes[iref.data]
  if (version > 1) {
    throw new Error('Unsupported AVIF iref version')
  }
  const idSize = version === 0 ? 2 : 4
  const refs = new Map<string, number[]>()
  for (const box of boxes(bytes, iref.data + 4, iref.end)) {
    let cursor = box.data
    const from = idSize === 2 ? u16(bytes, cursor, box.end) : u32(bytes, cursor, box.end)
    cursor += idSize
    const count = u16(bytes, cursor, box.end)
    cursor += 2
    const to: number[] = []
    for (let i = 0; i < count; i++) {
      to.push(idSize === 2 ? u16(bytes, cursor, box.end) : u32(bytes, cursor, box.end))
      cursor += idSize
    }
    refs.set(`${box.type}:${from}`, to)
  }
  return refs
}

/** `iloc` → 每个 item 的原始字节（支持 mdat 绝对偏移、idat 相对偏移及 0/1/2/4/8 字节字段）。 */
function parseLocations(bytes: Uint8Array, iloc: Box, idat: Box | undefined): Map<number, Uint8Array> {
  if (iloc.data + 8 > iloc.end) {
    throw new Error('Truncated AVIF iloc')
  }
  const version = bytes[iloc.data]
  if (version > 2) {
    throw new Error('Unsupported AVIF iloc version')
  }
  let cursor = iloc.data + 4
  const sizes = u16(bytes, cursor, iloc.end)
  cursor += 2
  const offsetSize = sizes >> 12
  const lengthSize = (sizes >> 8) & 0xF
  const baseSize = (sizes >> 4) & 0xF
  const indexSize = version === 0 ? 0 : sizes & 0xF
  const count = version < 2 ? u16(bytes, cursor, iloc.end) : u32(bytes, cursor, iloc.end)
  cursor += version < 2 ? 2 : 4
  const locations = new Map<number, Uint8Array>()
  const read = (size: number): number => {
    if (size === 0) {
      return 0
    }
    if (size !== 1 && size !== 2 && size !== 4 && size !== 8) {
      throw new Error(`Unsupported AVIF iloc field size: ${size}`)
    }
    if (cursor + size > iloc.end) {
      throw new Error('Truncated AVIF iloc entry')
    }
    let value = 0
    for (let k = 0; k < size; k++) {
      value = value * 256 + bytes[cursor + k]
    }
    cursor += size
    return value
  }
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? read(2) : read(4)
    const method = version === 0 ? 0 : u16(bytes, cursor, iloc.end) & 0xF
    if (version > 0) {
      cursor += 2
    }
    if (method !== 0 && method !== 1) {
      throw new Error(`Unsupported AVIF iloc construction method: ${method}`)
    }
    if (method === 1 && !idat) {
      throw new Error('Missing AVIF idat box')
    }
    u16(bytes, cursor, iloc.end) // data_reference_index
    cursor += 2
    const base = read(baseSize)
    const extentCount = u16(bytes, cursor, iloc.end)
    cursor += 2
    const parts: Uint8Array[] = []
    for (let j = 0; j < extentCount; j++) {
      if (indexSize) {
        read(indexSize)
      }
      const offset = read(offsetSize)
      const length = read(lengthSize)
      const start = (method === 1 ? idat!.data : 0) + base + offset
      if (start < 0 || start + length > bytes.length) {
        throw new Error('AVIF item data out of bounds')
      }
      parts.push(bytes.subarray(start, start + length))
    }
    locations.set(id, parts.length === 1 ? parts[0] : join(parts))
  }
  return locations
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

function u16Bytes(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xFF, value & 0xFF])
}

function u32Bytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF])
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const data = join(parts)
  return join([u32Bytes(data.length + 8), encoder.encode(type), data])
}

function fullBox(type: string, version: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u32Bytes(version << 24), ...parts)
}

/** Gain map 位图本身不该做色彩管理：把它的 colr 固定成「未指定」，避免浏览器把比值当颜色转换。 */
const GAIN_COLOR = new Uint8Array([0x6E, 0x63, 0x6C, 0x78, 0x00, 0x02, 0x00, 0x02, 0x00, 0x06, 0x80])

export interface AVIFGainMap {
  /** 原图本身：主图与 nclx 交给浏览器原生解码。 */
  base: Blob
  /** 独立的迷你 AVIF，只含增益图，可直接 `createImageBitmap()`。 */
  gain: Blob
  metadata: GainMapMetadata
  orientation: number
  toGainSpace: Matrix3
  toDisplayP3: Matrix3
  wideGamut: boolean
}

/**
 * @returns `null` 表示这不是一张带 gain map 的 AVIF（或结构不受支持），调用方按 SDR 处理。
 */
export function extractAVIFGainMap(buffer: ArrayBuffer): AVIFGainMap | null {
  const bytes = new Uint8Array(buffer)
  if (!looksLikeAvif(bytes)) {
    return null
  }

  const top = boxes(bytes, 0, bytes.length)
  const meta = findBox(top, 'meta')
  if (!meta || meta.data + 4 > meta.end || bytes[meta.data] !== 0) {
    return null
  }
  const metaChildren = boxes(bytes, meta.data + 4, meta.end)
  const iinf = findBox(metaChildren, 'iinf')
  const iref = findBox(metaChildren, 'iref')
  const iloc = findBox(metaChildren, 'iloc')
  const iprp = findBox(metaChildren, 'iprp')
  const pitm = findBox(metaChildren, 'pitm')
  if (!iinf || !iref || !iloc || !iprp || !pitm || pitm.data + 4 > pitm.end) {
    return null
  }

  const items: Item[] = Array.from(parseItems(bytes, iinf), ([id, type]) => ({ id, type }))
  const tmap = items.find(item => item.type === 'tmap')
  if (!tmap) {
    return null
  }
  const primary = bytes[pitm.data] === 0 ? u16(bytes, pitm.data + 4, pitm.end) : u32(bytes, pitm.data + 4, pitm.end)
  const references = parseReferences(bytes, iref)
  const dimg = references.get(`dimg:${tmap.id}`)
  if (!dimg || dimg.length < 2) {
    throw new Error('AVIF tmap has no derived image pair')
  }
  // dimg 语义：派生项的输入图，按规范是 [主图, 增益图]；不依赖顺序，挑出非主图那个。
  const gainId = dimg.find(id => id !== primary) ?? dimg[1]
  if (!items.some(item => item.id === gainId && item.type === 'av01')) {
    throw new Error('AVIF gain map is not an av01 image')
  }

  const locations = parseLocations(bytes, iloc, findBox(metaChildren, 'idat'))
  const tmapData = locations.get(tmap.id)
  const gainData = locations.get(gainId)
  if (!tmapData || !gainData || tmapData.length < 1) {
    throw new Error('AVIF gain map payload missing')
  }
  if (tmapData[0] !== 0) {
    throw new Error('Unsupported AVIF tmap version')
  }
  const metadata = parseISOGainMap(tmapData.subarray(1))

  const byId = parseProperties(bytes, iprp)
  const resolveItemColorants = (id: number): Matrix3 | null => {
    const colr = (byId.get(id) ?? []).find(box => box.type === 'colr')
    if (!colr || colr.data + 4 > colr.end) {
      return null
    }
    const kind = text.decode(bytes.subarray(colr.data, colr.data + 4))
    if (kind === 'nclx') {
      if (colr.data + 11 > colr.end) {
        return null
      }
      const primaries = u16(bytes, colr.data + 4, colr.end)
      if (primaries === 2) {
        return null
      }
      if (primaries === 12) {
        return P3_TO_XYZ
      }
      if (primaries === 9) {
        return BT2020_TO_XYZ
      }
      return SRGB_TO_XYZ
    }
    if (kind === 'rICC' || kind === 'prof') {
      return parseIccColorants(bytes.subarray(colr.data + 4, colr.end))
    }
    return null
  }
  const baseSpace = resolveItemColorants(primary) ?? SRGB_TO_XYZ
  // ISO 21496-1 / AVIF tmap 里 alternate 渲染空间挂在 tmap 派生项上（gainId 本身是无色域意义的 2/2/6）
  const gainSpace = metadata.useBaseColorSpace
    ? baseSpace
    : (resolveItemColorants(tmap.id) ?? resolveItemColorants(gainId) ?? baseSpace)
  const toDisplayP3 = multiplyMatrices(inverseMatrix(P3_TO_XYZ), gainSpace)
  const toGainSpace = inverseMatrix(toDisplayP3)
  const baseToP3 = multiplyMatrices(inverseMatrix(P3_TO_XYZ), baseSpace)

  const gainProperties = byId.get(gainId) ?? []
  const gainPropertyTypes = new Set(['ispe', 'pixi', 'av1C', 'irot', 'imir', 'clap'])
  const copied = gainProperties.filter(box => gainPropertyTypes.has(box.type))
  if (!copied.some(box => box.type === 'ispe') || !copied.some(box => box.type === 'av1C')) {
    throw new Error('AVIF gain map is missing ispe/av1C')
  }
  // 主图的旋转/镜像要带到增益图上，否则 createImageBitmap 解出来的两张图方向不一致。
  if (!copied.some(box => box.type === 'irot' || box.type === 'imir')) {
    const baseRotation = (byId.get(primary) ?? []).filter(box => box.type === 'irot' || box.type === 'imir')
    copied.push(...baseRotation)
  }
  const properties = [
    ...copied.map(box => bytes.slice(box.start, box.end)),
    box('colr', GAIN_COLOR),
  ]
  const associationIndices = [
    ...copied.map((prop, index) => new Uint8Array([(ESSENTIAL_PROPERTIES.has(prop.type) ? 0x80 : 0) | (index + 1)])),
    new Uint8Array([copied.length + 1]),
  ]

  const ftyp = box('ftyp', encoder.encode('avif'), u32Bytes(0), encoder.encode('avifmif1miaf'))
  const itemCount = 1
  const makeMeta = (offset: number) => fullBox(
    'meta',
    0,
    fullBox('hdlr', 0, u32Bytes(0), encoder.encode('pict'), new Uint8Array(13)),
    fullBox('pitm', 0, u16Bytes(itemCount)),
    fullBox(
      'iloc',
      0,
      // offset_size = 4, length_size = 4, base_offset_size = 4, index_size = 0
      new Uint8Array([0x44, 0x40]),
      u16Bytes(itemCount),
      // item_ID, data_reference_index, base_offset, extent_count, extent_offset, extent_length
      u16Bytes(1),
      u16Bytes(0),
      u32Bytes(offset),
      u16Bytes(1),
      u32Bytes(0),
      u32Bytes(gainData.length),
    ),
    fullBox(
      'iinf',
      0,
      u16Bytes(itemCount),
      box('infe', u32Bytes(2 << 24), u16Bytes(1), u16Bytes(0), encoder.encode('av01'), new Uint8Array(1)),
    ),
    box(
      'iprp',
      box('ipco', ...properties),
      box(
        'ipma',
        u32Bytes(0),
        u32Bytes(itemCount),
        u16Bytes(1),
        new Uint8Array([properties.length]),
        ...associationIndices,
      ),
    ),
  )
  const metaBox = makeMeta(ftyp.length + makeMeta(0).length + 8)
  const gain = new Blob([join([ftyp, metaBox, box('mdat', gainData)])], { type: 'image/avif' })

  return {
    base: new Blob([bytes], { type: 'image/avif' }),
    gain,
    metadata,
    // AVIF 的 irot/imir 由解码器直接应用（包括迷你 AVIF 里那一份），这里不要再转一次。
    orientation: 1,
    toGainSpace,
    toDisplayP3,
    wideGamut: baseToP3.some(value => value < -0.001 || value > 1.001),
  }
}
