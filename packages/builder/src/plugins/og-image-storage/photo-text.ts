import type { PhotoManifestItem } from '@afilmory/typing'

/**
 * 分享卡上的「文字」。
 *
 * 图里不再画字之后，卡片上的字完全由分享平台从页面 meta 里读：标题
 * （og:title）+ 描述（og:description）。所以这里负责把 manifest 里的字段
 * 翻成能看的文案：
 *
 *   标题：拍摄地点（或照片本来的名字）
 *   描述：EXIF 明细，一行一个 emoji 字段
 *
 *    📸: SONY ILCE-7RM5 / Viltrox 55mm F1.8 FE
 *    📝: 55mm, f/3.5, 1/3200s, ISO 100
 *    📅: 2026-10-02 15:08:41
 *    🗺: 丹东镇, 丹巴县, 甘孜藏族自治州, 四川省, 626300, 中国
 *    📍: 31.047980° N, 101.349466° E
 *
 * 标题只有「像人写的」时候才用 manifest.title —— 这个库里 369 张照片只有
 * 1 张真的有标题，其余都是 `20260103 MGT07818` / `DSC09104 已增强 降噪`
 * 这类相机/软件产出的串。
 */

export interface PhotoOgText {
  title: string
  /** 卡片描述：多行 EXIF 明细（WhatsApp / Telegram 会按行显示，X 会截断到 2 行） */
  description: string
  /** 单行版，给 `<meta name="description">` 用：搜索结果摘要不放 emoji */
  summary: string
}

type PhotoTextSource = Pick<PhotoManifestItem, 'title' | 'exif' | 'location' | 'dateTaken'> & {
  tags?: string[]
}

/** 后期软件/拍摄模式留下的标记，出现就说明这不是人起的名字。 */
const TECHNICAL_TITLE_PATTERN = /已增强|降噪|去噪|修复|HDR|全景|motion|stabilized|stabilised|merge|pano\b|panorama/i

/** 超过两个连续拉丁字母基本就是机型/文件编号（MGT、DSC、MVIMG、SR…）。 */
const LATIN_WORD_PATTERN = /[A-Z]{2,}/i

/** 光看地址第一段分不出是马路还是地标时，用这套规则判断。 */
const ROAD_PATTERN
  = /通り|道路|国道|街道|大路|大道|高架路|公路|[路街线線号]|Street|Road|Avenue|Highway|Route|\bSt\.|\bRd\./i

/** 地址里以行政单位结尾的一段，例如「青森市」「浦东新区」。 */
const REGION_PATTERN = /[市区县縣町村都府省州]$/

const POSTAL_CODE_PATTERN = /^\d{4,}$/

export function isHumanTitle(title: string | null | undefined): boolean {
  const value = title?.trim()
  if (!value) return false
  if (TECHNICAL_TITLE_PATTERN.test(value)) return false
  if (LATIN_WORD_PATTERN.test(value)) return false

  const cjk = value.replaceAll(/[^\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g, '')
  return cjk.length >= 2
}

/**
 * 从反向地理编码结果里挑一个最像「地点」的短名字。
 * `locationName` 是完整地址（从最具体到国家），取第一段；第一段是马路/国道时
 * 退一级用行政区，避免卡片标题出现「国道103号」。
 */
export function shortPlaceName(item: Pick<PhotoTextSource, 'location'>): string | null {
  const location = item.location
  const name = location?.locationName?.trim()
  const country = location?.country?.trim()

  if (name) {
    const parts = name
      .split(',')
      // 反向地理编码偶尔给双语名（`东京都/東京都`），卡片上只留前半截
      .flatMap(part => part.split('/'))
      .map(part => part.trim())
      .filter(part => part.length > 0 && part !== country && !POSTAL_CODE_PATTERN.test(part))

    const first = parts[0]
    if (first) {
      if (!ROAD_PATTERN.test(first)) return first
      return parts.find(part => REGION_PATTERN.test(part)) ?? parts[1] ?? first
    }
  }

  const city = location?.city?.split(',')[0]?.trim()
  return city || country || null
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/

interface LocalDateParts {
  year: string
  month: number
  day: number
  time?: string
}

/** 用 EXIF 里的本地时间（带拍摄时区）拆日期，避免 UTC 归一化把日期挪一天。 */
function localDateParts(item: Pick<PhotoTextSource, 'exif' | 'dateTaken'>): LocalDateParts | null {
  const raw = item.exif?.DateTimeOriginal || item.dateTaken
  const match = DATE_PATTERN.exec(raw ?? '')
  if (!match) return null

  return {
    year: match[1],
    month: Number(match[2]),
    day: Number(match[3]),
    time: match[4] ? `${match[4]}:${match[5]}:${match[6]}` : undefined,
  }
}

/** 标题兜底用的短日期：2026年10月2日 */
export function localDateLabel(item: Pick<PhotoTextSource, 'exif' | 'dateTaken'>): string | null {
  const parts = localDateParts(item)
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : null
}

/** 📅 那一行：2026-10-02 15:08:41 */
export function localDateTimeLabel(item: Pick<PhotoTextSource, 'exif' | 'dateTaken'>): string | null {
  const parts = localDateParts(item)
  if (!parts) return null

  const date = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  return parts.time ? `${date} ${parts.time}` : date
}

export function formatShutterSpeed(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null

  const text = String(value).trim().replace(/\s+/g, '')
  if (!text) return null

  if (text.includes('/')) return `${text}s`

  const numeric = Number(text.replace(/s$/i, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return null

  // 三位以上的整数是快门分母（exiftool 偶尔把 1/3552 折成 3552），
  // 其余都按「多少秒」处理：3.2 → 3.2s，2 → 2s，30 → 30s
  if (numeric >= 100) return `1/${Math.round(numeric)}s`
  return `${numeric}s`
}

/** 「📸」那一行的机身：SONY ILCE-7RM5 / Apple iPhone 18 Pro */
export function cameraLabel(exif: PhotoTextSource['exif']): string | null {
  const model = exif?.Model?.trim()
  if (!model) return null

  const make = exif?.Make?.trim()
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model
  return `${make} ${model}`
}

/** 「📸」那一行的镜头；手机 exiftool 的镜头名是机内实现细节，读起来没意义，直接跳过。 */
export function lensLabel(exif: PhotoTextSource['exif']): string | null {
  const lens = exif?.LensModel?.trim()
  if (!lens || lens === '----') return null
  if (/(?:back|front|wide|telephoto|ultra wide) camera/i.test(lens)) return null
  return lens
}

function focalLabel(exif: PhotoTextSource['exif']): string | null {
  const text = exif?.FocalLengthIn35mmFormat?.trim() || exif?.FocalLength?.trim()
  if (!text) return null
  return /mm$/i.test(text) ? text.replace(/\s+/g, '') : `${text}mm`
}

/** 「📝」那一行：55mm, f/3.5, 1/3200s, ISO 100 */
export function settingsLine(exif: PhotoTextSource['exif']): string | null {
  if (!exif) return null

  const parts = [
    focalLabel(exif),
    typeof exif.FNumber === 'number' && Number.isFinite(exif.FNumber) ? `f/${exif.FNumber}` : null,
    formatShutterSpeed(exif.ExposureTime),
    typeof exif.ISO === 'number' && Number.isFinite(exif.ISO) ? `ISO ${exif.ISO}` : null,
  ].filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(', ') : null
}

/** 「📍」那一行：31.047980° N, 101.349466° E */
export function coordinatesLabel(location: PhotoTextSource['location']): string | null {
  const latitude = location?.latitude
  const longitude = location?.longitude
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude === 0 && longitude === 0) return null

  return `${Math.abs(latitude).toFixed(6)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(6)}° ${
    longitude >= 0 ? 'E' : 'W'
  }`
}

/** 一行一个 emoji 字段；没有的字段整行省略。 */
export function exifDetailLines(item: Pick<PhotoTextSource, 'exif' | 'location' | 'dateTaken'>): string[] {
  const lines: string[] = []

  const camera = [cameraLabel(item.exif), lensLabel(item.exif)].filter(Boolean).join(' / ')
  if (camera) { lines.push(`📸: ${camera}`) }

  const settings = settingsLine(item.exif)
  if (settings) { lines.push(`📝: ${settings}`) }

  const dateTime = localDateTimeLabel(item)
  if (dateTime) { lines.push(`📅: ${dateTime}`) }

  const address = item.location?.locationName?.trim()
  if (address) { lines.push(`🗺: ${address}`) }

  const coordinates = coordinatesLabel(item.location)
  if (coordinates) { lines.push(`📍: ${coordinates}`) }

  return lines
}

export interface BuildPhotoOgTextOptions {
  /** 实在没有可用字段时的兜底（站名）。 */
  siteName?: string
}

export function buildPhotoOgText(item: PhotoTextSource, options: BuildPhotoOgTextOptions = {}): PhotoOgText {
  const { siteName } = options

  const humanTitle = isHumanTitle(item.title) ? item.title.trim() : null
  const place = shortPlaceName(item)
  const date = localDateLabel(item)

  const title = humanTitle ?? place ?? date ?? siteName ?? item.title?.trim() ?? 'Photo'

  const description = exifDetailLines(item).join('\n')

  // 搜索摘要用单行：{地点} · {日期} · {机身 / 镜头} · {参数}
  const summary = [
    title === place ? null : place,
    date,
    [cameraLabel(item.exif), lensLabel(item.exif)].filter(Boolean).join(' / ') || null,
    settingsLine(item.exif),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return {
    title,
    description: description || siteName || title,
    summary: summary || description || title,
  }
}

/** 生成给 middleware 内嵌的整库文字表：photoId → { title, description, summary }。 */
export function buildPhotoOgTextMap(
  photos: ReadonlyArray<PhotoTextSource & { id: string }>,
  options: BuildPhotoOgTextOptions = {},
): Record<string, PhotoOgText> {
  const map: Record<string, PhotoOgText> = {}
  for (const photo of photos) {
    map[photo.id] = buildPhotoOgText(photo, options)
  }
  return map
}
