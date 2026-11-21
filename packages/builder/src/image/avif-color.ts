/**
 * AVIF（ISO-BMFF）容器在构建期的只读解析器。
 *
 * 为什么需要自己读容器：
 *
 * 1. **HDR 判定**。sharp / libvips 的 `metadata().gainMap` 与 exiftool 的 `ContainerDirectory`
 *    都只认 JPEG 的 gain map；Lightroom 导出的 AVIF Ultra HDR 在 EXIF/XMP 层面就是普通 AVIF，
 *    真正的增益图是容器里 `meta` 下的 `tmap` 派生项（ISO 21496-1）。
 * 2. **nclx 色域识别**。libvips 读 AVIF 时不解释 `colr` 里的 `nclx` CICP（`metadata().hasProfile`
 *    为 `false`），解出来的像素保留原色域数值但输出会丢掉色彩标记，导致 Display P3 缩略图在
 *    浏览器里被按 sRGB 显示而发灰。这里识别出 SDR 传递函数的 nclx Display P3 源，配合
 *    `color-profile.ts` 用 `sharp.pipelineColourspace('rgb16').withIccProfile('p3')` 补回 P3 ICC。
 *
 * 这里的解析是**防御式**的：越界、未知版本或截断都会抛 `Error`，调用方负责降级处理。
 */

/** CICP（ITU-T H.273）色彩描述，`colr` 盒里 `nclx` 的四个字段。 */
export interface CicpColorSpace {
  primaries: number
  transfer: number
  matrix: number
  fullRange: boolean
}

export interface AvifInfo {
  /** 主图（`pitm`）的 item type，正常是 `av01`（网格图是 `grid`）。 */
  primaryType: string | null
  /** 容器里是否存在 `tmap` 派生项（AVIF Ultra HDR gain map）。 */
  hasGainMap: boolean
  /** 主图的 CICP；`colr` 是 ICC（`prof` / `rICC`）或没有 `colr` 时为 `null`。 */
  color: CicpColorSpace | null
}

interface Box {
  type: string
  start: number
  data: number
  end: number
}

interface AvifItem {
  id: number
  type: string
}

const MAX_BOXES = 4096

function fail(reason: string): never {
  throw new Error(`Unsupported AVIF container: ${reason}`)
}

function u16(bytes: Uint8Array, offset: number, end: number): number {
  if (offset < 0 || offset + 2 > end) {
    fail('truncated uint16')
  }
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function u32(bytes: Uint8Array, offset: number, end: number): number {
  if (offset < 0 || offset + 4 > end) {
    fail('truncated uint32')
  }
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
}

function fourcc(bytes: Uint8Array, offset: number, end: number): string {
  if (offset < 0 || offset + 4 > end) {
    fail('truncated fourcc')
  }
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readBoxAt(bytes: Uint8Array, cursor: number, end: number): Box {
  const declared = u32(bytes, cursor, end)
  const header = declared === 1 ? 16 : 8
  let size = declared
  if (declared === 1) {
    if (u32(bytes, cursor + 8, end) !== 0) {
      fail('box too large')
    }
    size = u32(bytes, cursor + 12, end)
  }
  else if (declared === 0) {
    size = end - cursor
  }
  if (size < header || cursor + size > end) {
    fail('box out of bounds')
  }
  return {
    type: fourcc(bytes, cursor + 4, cursor + 8),
    start: cursor,
    data: cursor + header,
    end: cursor + size,
  }
}

function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = []
  for (let cursor = start; cursor < end;) {
    if (boxes.length >= MAX_BOXES) {
      fail('too many boxes')
    }
    const box = readBoxAt(bytes, cursor, end)
    boxes.push(box)
    cursor = box.end
  }
  return boxes
}

/** 顺序扫描顶层盒直到找到目标盒，避免读文件头时被后方未读入的 `mdat` 越界阻塞。 */
function findTopLevelBox(bytes: Uint8Array, targetType: string): Box | null {
  let count = 0
  for (let cursor = 0; cursor < bytes.length;) {
    if (count++ >= MAX_BOXES) {
      fail('too many boxes')
    }
    const box = readBoxAt(bytes, cursor, bytes.length)
    if (box.type === targetType) {
      return box
    }
    cursor = box.end
  }
  return null
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find(box => box.type === type)
}

function parseIinf(bytes: Uint8Array, iinf: Box): AvifItem[] {
  if (iinf.data + 4 > iinf.end) {
    fail('truncated iinf')
  }
  const version = bytes[iinf.data]
  if (version !== 0 && version !== 1) {
    fail('unsupported iinf version')
  }
  const countSize = version === 0 ? 2 : 4
  const cursor = iinf.data + 4 + countSize
  if (cursor > iinf.end) {
    fail('truncated iinf count')
  }
  const items: AvifItem[] = []
  for (const box of readBoxes(bytes, cursor, iinf.end)) {
    if (box.type !== 'infe') {
      continue
    }
    if (box.data >= box.end) {
      fail('truncated infe')
    }
    const infeVersion = bytes[box.data]
    if (infeVersion !== 2 && infeVersion !== 3) {
      fail('unsupported infe version')
    }
    const idSize = infeVersion === 3 ? 4 : 2
    const id = idSize === 4 ? u32(bytes, box.data + 4, box.end) : u16(bytes, box.data + 4, box.end)
    const typeOffset = box.data + 4 + idSize + 2
    items.push({ id, type: fourcc(bytes, typeOffset, box.end) })
  }
  return items
}

function parseIpma(bytes: Uint8Array, ipma: Box, properties: Box[]): Map<number, Box[]> {
  if (ipma.data + 8 > ipma.end) {
    fail('truncated ipma')
  }
  const version = bytes[ipma.data]
  if (version > 1) {
    fail('unsupported ipma version')
  }
  const flags = bytes[ipma.data + 1] * 0x10000 + (bytes[ipma.data + 2] << 8) + bytes[ipma.data + 3]
  const indexSize = flags & 1 ? 2 : 1
  let cursor = ipma.data + 4
  // ipma 的 entry_count 恒为 32 位；version 只影响 item_ID 宽度
  const count = u32(bytes, cursor, ipma.end)
  cursor += 4
  const associations = new Map<number, Box[]>()
  for (let i = 0; i < count; i++) {
    const id = version === 0 ? u16(bytes, cursor, ipma.end) : u32(bytes, cursor, ipma.end)
    cursor += version === 0 ? 2 : 4
    if (cursor + 1 > ipma.end) {
      fail('truncated ipma entry')
    }
    const associationCount = bytes[cursor]
    cursor += 1
    const list = associations.get(id) ?? []
    for (let j = 0; j < associationCount; j++) {
      const raw = indexSize === 2 ? u16(bytes, cursor, ipma.end) : bytes[cursor]
      cursor += indexSize
      const index = indexSize === 2 ? raw & 0x7FFF : raw & 0x7F
      if (index > 0 && index <= properties.length) {
        list.push(properties[index - 1])
      }
    }
    associations.set(id, list)
  }
  return associations
}

function readCicp(bytes: Uint8Array, colr: Box): CicpColorSpace | null {
  if (fourcc(bytes, colr.data, colr.end) !== 'nclx') {
    return null
  }
  if (colr.data + 11 > colr.end) {
    fail('truncated nclx colr box')
  }
  return {
    primaries: u16(bytes, colr.data + 4, colr.end),
    transfer: u16(bytes, colr.data + 6, colr.end),
    matrix: u16(bytes, colr.data + 8, colr.end),
    fullRange: (bytes[colr.data + 10] & 0x80) !== 0,
  }
}

/** `ftyp` 主品牌是 AVIF 系列（`avif` / `avis`），或兼容品牌里列了 `avif`。 */
export function isAvif(bytes: Uint8Array): boolean {
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
      if (fourcc(bytes, cursor, ftyp.end) === 'avif') {
        return true
      }
    }
    return false
  }
  catch {
    return false
  }
}

/**
 * 读取 AVIF 容器元信息；非 AVIF 返回 `null`。
 * `truncateOk = true` 时，容器截断也会返回 `null` 而非抛错。
 */
export function readAvifInfo(bytes: Uint8Array, truncateOk = false): AvifInfo | null {
  if (!isAvif(bytes)) {
    return null
  }
  try {
    const meta = findTopLevelBox(bytes, 'meta')
    if (!meta) {
      fail('missing meta box')
    }
    if (meta.data + 4 > meta.end) {
      fail('truncated meta box')
    }
    if (bytes[meta.data] !== 0) {
      fail('unsupported meta version')
    }
    const children = readBoxes(bytes, meta.data + 4, meta.end)
    const iinf = findBox(children, 'iinf')
    const items = iinf ? parseIinf(bytes, iinf) : []

    let primaryId: number | null = null
    const pitm = findBox(children, 'pitm')
    if (pitm) {
      if (pitm.data + 4 > pitm.end) {
        fail('truncated pitm')
      }
      primaryId = bytes[pitm.data] === 0 ? u16(bytes, pitm.data + 4, pitm.end) : u32(bytes, pitm.data + 4, pitm.end)
    }

    let primaryProperties: Box[] = []
    const iprp = findBox(children, 'iprp')
    if (iprp) {
      const iprpChildren = readBoxes(bytes, iprp.data, iprp.end)
      const ipco = findBox(iprpChildren, 'ipco')
      const properties = ipco ? readBoxes(bytes, ipco.data, ipco.end) : []
      if (primaryId !== null) {
        const associations = new Map<number, Box[]>()
        for (const ipma of iprpChildren.filter(box => box.type === 'ipma')) {
          for (const [id, list] of parseIpma(bytes, ipma, properties)) {
            const existing = associations.get(id)
            associations.set(id, existing ? existing.concat(list) : list)
          }
        }
        primaryProperties = associations.get(primaryId) ?? []
      }
    }

    const primary = items.find(item => item.id === primaryId) ?? null
    const colr = primaryProperties.find(box => box.type === 'colr')
    return {
      primaryType: primary?.type ?? null,
      hasGainMap: items.some(item => item.type === 'tmap'),
      color: colr ? readCicp(bytes, colr) : null,
    }
  }
  catch (error) {
    if (!truncateOk) {
      throw error
    }
    return null
  }
}

/** AVIF Ultra HDR：容器里有 `tmap` 派生项。非 AVIF / 解析失败一律 `false`。 */
export function hasAvifGainMap(bytes: Uint8Array): boolean {
  return readAvifInfo(bytes, true)?.hasGainMap ?? false
}

/**
 * 仅处理 SDR 传递函数（1 = BT.709，6 = BT.601，13 = sRGB，14/15 = BT.2020 SDR）。
 * PQ（16）/ HLG（18）的像素是 HDR 编码值，贴 SDR ICC 只会让颜色更糟。
 */
export function isSdrTransfer(color: CicpColorSpace): boolean {
  return [1, 6, 13, 14, 15].includes(color.transfer)
}

/**
 * 源图是否是仅靠 `colr/nclx` 声明为 Display P3（且为 SDR 传递函数）的 AVIF。
 */
export function isAvifDisplayP3(bytes: Uint8Array): boolean {
  const info = readAvifInfo(bytes, true)
  return Boolean(info?.color && info.color.primaries === 12 && isSdrTransfer(info.color))
}
