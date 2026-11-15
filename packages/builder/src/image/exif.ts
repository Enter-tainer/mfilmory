import type { Buffer } from 'node:buffer'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type {
  ExiftoolXmpArea,
  ExiftoolXmpDimensions,
  ExiftoolXmpRegionInfo,
  PhotoRegion,
  PhotoXmpMetadata,
  PickedExif,
} from '@afilmory/typing'
import { isNil, noop } from 'es-toolkit'
import type { ExifDateTime, Tags } from 'exiftool-vendored'
import { ExifTool } from 'exiftool-vendored'

import { getGlobalLoggers } from '../photo/logger-adapter.js'

const EXIF_TEMP_DIR = path.join(os.tmpdir(), 'afilmory-exif')

let exiftoolInstance: ExifTool | null = null

function getExiftool(): ExifTool {
  if (!exiftoolInstance) {
    exiftoolInstance = new ExifTool({
      ...(process.env.EXIFTOOL_PATH ? { exiftoolPath: process.env.EXIFTOOL_PATH } : {}),
      taskTimeoutMillis: 30000,
    })
  }
  return exiftoolInstance
}

const EMPTY_XMP_METADATA: PhotoXmpMetadata = {
  keywords: [],
  regions: [],
}

export async function shutdownExiftool(): Promise<void> {
  const current = exiftoolInstance
  if (!current) {
    return
  }
  exiftoolInstance = null
  await current.end().catch(noop)
}

// 提取 EXIF 数据；若原图已落盘（如 original-cache），直接读文件省去一次临时写入
export async function extractExifData(
  imageBuffer: Buffer | undefined,
  originalBuffer?: Buffer,
  sourcePath?: string,
): Promise<PickedExif | null> {
  const log = getGlobalLoggers().exif

  let tempImagePath: string | null = null
  let readTarget = sourcePath

  try {
    if (!readTarget) {
      const targetBuffer = originalBuffer || imageBuffer
      if (!targetBuffer) {
        log.warn('EXIF 提取缺少输入文件或缓冲区')
        return null
      }
      await mkdir(EXIF_TEMP_DIR, { recursive: true })
      tempImagePath = path.join(EXIF_TEMP_DIR, `${crypto.randomUUID()}.jpg`)
      await writeFile(tempImagePath, targetBuffer)
      readTarget = tempImagePath
    }

    log.info(`开始提取 EXIF 数据, 文件路径: ${readTarget}`)
    const exifData = await getExiftool().read(readTarget)

    const result = handleExifData(exifData)

    if (!exifData) {
      log.warn('EXIF 数据解析失败')
      return null
    }

    // 清理 EXIF 数据中的空字符和无用数据

    delete exifData.warnings
    delete exifData.errors

    log.success('EXIF 数据提取完成')
    return result
  }
  catch (error) {
    log.error('提取 EXIF 数据失败:', error)
    return null
  }
  finally {
    if (tempImagePath) {
      await unlink(tempImagePath).catch(noop)
    }
  }
}

const pickKeys: Array<keyof Tags | (string & {})> = [
  'tz',
  'tzSource',
  'Orientation',
  'Make',
  'Model',
  'Software',
  'Artist',
  'Copyright',
  'ExposureTime',

  'FNumber',
  'ExposureProgram',
  'ISO',
  'OffsetTime',
  'OffsetTimeOriginal',
  'OffsetTimeDigitized',
  'ShutterSpeedValue',
  'ApertureValue',
  'BrightnessValue',
  'ExposureCompensationSet',
  'ExposureCompensationMode',
  'ExposureCompensationSetting',

  'ExposureCompensation',
  'MaxApertureValue',
  'LightSource',
  'Flash',
  'FocalLength',

  'ColorSpace',
  'ExposureMode',
  'FocalLengthIn35mmFormat',
  'SceneCaptureType',
  'LensMake',
  'LensModel',
  'MeteringMode',
  'WhiteBalance',
  'WBShiftAB',
  'WBShiftGM',
  'WhiteBalanceBias',

  'FlashMeteringMode',
  'SensingMethod',
  'FocalPlaneXResolution',
  'FocalPlaneYResolution',

  'Aperture',
  'ScaleFactor35efl',
  'ShutterSpeed',
  'LightValue',
  'Rating',
  // GPS
  'GPSAltitude',
  'GPSCoordinates',
  'GPSAltitudeRef',
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  // HDR相关字段
  'MPImageType',
  'UniformResourceName',
  // Motion Photo 相关字段
  'MotionPhoto',
  'MotionPhotoVersion',
  'MotionPhotoPresentationTimestampUs',
  'ContainerDirectory',
  'MicroVideo',
  'MicroVideoVersion',
  'MicroVideoOffset',
  'MicroVideoPresentationTimestampUs',
  // XMP keyword / region fields
  'Subject',
  'Keywords',
  'WeightedFlatSubject',
  'HierarchicalSubject',
  'RegionInfo',
]

export function extractXmpMetadataFromExif(exifData: PickedExif | null | undefined): PhotoXmpMetadata {
  if (!exifData) {
    return EMPTY_XMP_METADATA
  }

  return {
    keywords: mergeUniqueStrings(
      normalizeStringArray(exifData.Subject),
      normalizeStringArray(exifData.Keywords),
      normalizeStringArray(exifData.WeightedFlatSubject),
      normalizeStringArray(exifData.HierarchicalSubject),
    ),
    regions: parseRegionInfo(exifData.RegionInfo),
  }
}

function handleExifData(exifData: Tags): PickedExif {
  const date = {
    DateTimeOriginal: formatExifDate(exifData.DateTimeOriginal),
    DateTimeDigitized: formatExifDate(exifData.DateTimeDigitized),
    OffsetTime: exifData.OffsetTime,
    OffsetTimeOriginal: exifData.OffsetTimeOriginal,
    OffsetTimeDigitized: exifData.OffsetTimeDigitized,
  }

  let FujiRecipe: any = null
  if (exifData.FilmMode) {
    FujiRecipe = {
      FilmMode: exifData.FilmMode,
      GrainEffectRoughness: exifData.GrainEffectRoughness,
      GrainEffectSize: exifData.GrainEffectSize,
      ColorChromeEffect: exifData.ColorChromeEffect,
      ColorChromeFxBlue: exifData.ColorChromeFXBlue,
      WhiteBalance: exifData.WhiteBalance,

      DynamicRange: exifData.DynamicRange,
      HighlightTone: exifData.HighlightTone,
      ShadowTone: exifData.ShadowTone,
      Saturation: exifData.Saturation,
      // Sharpness: exifData.Sharpness,
      NoiseReduction: exifData.NoiseReduction,
      Clarity: exifData.Clarity,
      ColorTemperature: exifData.ColorTemperature,
      DevelopmentDynamicRange: (exifData as any).DevelopmentDynamicRange,
      DynamicRangeSetting: exifData.DynamicRangeSetting,
    }
  }

  let SonyRecipe: any = null
  if (!isNil(exifData.CreativeStyle)) {
    SonyRecipe = {
      CreativeStyle: exifData.CreativeStyle,
      PictureEffect: exifData.PictureEffect,
      Hdr: exifData.Hdr,
      SoftSkinEffect: exifData.SoftSkinEffect,
    }
  }
  const size = {
    ImageWidth: exifData.ExifImageWidth,
    ImageHeight: exifData.ExifImageHeight,
  }
  const result: any = structuredClone(exifData)
  for (const key in result) {
    Reflect.deleteProperty(result, key)
  }
  for (const key of pickKeys) {
    result[key] = exifData[key]
  }

  return {
    ...date,
    ...size,
    ...result,

    ...(FujiRecipe ? { FujiRecipe } : {}),
    ...(SonyRecipe ? { SonyRecipe } : {}),
  }
}

const formatExifDate = (date: string | ExifDateTime | undefined) => {
  if (!date) {
    return
  }

  if (typeof date === 'string') {
    return new Date(date).toISOString()
  }

  return date.toISOString()
}

function parseRegionInfo(regionInfo: ExiftoolXmpRegionInfo | undefined): PhotoRegion[] {
  if (!regionInfo?.RegionList || regionInfo.RegionList.length === 0) {
    return []
  }

  const appliedToDimensions = parseAppliedToDimensions(regionInfo.AppliedToDimensions)

  return regionInfo.RegionList.map((region) => {
    const name = typeof region.Name === 'string' ? region.Name.trim() : ''
    const type = normalizeRegionType(region.Type)
    const area = parseRegionArea(region.Area)

    if (!name && !type && !area) {
      return null
    }

    return {
      name,
      ...(type ? { type } : {}),
      area,
      appliedToDimensions,
    } satisfies PhotoRegion
  }).filter((region): region is PhotoRegion => region !== null)
}

function parseAppliedToDimensions(dimensions: ExiftoolXmpDimensions | undefined) {
  if (!dimensions?.W || !dimensions?.H || !dimensions.Unit) {
    return null
  }

  return {
    width: dimensions.W,
    height: dimensions.H,
    unit: dimensions.Unit,
  }
}

function parseRegionArea(area: ExiftoolXmpArea | undefined) {
  if (
    typeof area?.X !== 'number'
    || typeof area.Y !== 'number'
    || typeof area.W !== 'number'
    || typeof area.H !== 'number'
  ) {
    return null
  }

  return {
    x: area.X,
    y: area.Y,
    width: area.W,
    height: area.H,
    unit: area.Unit ?? 'normalized',
  }
}

function normalizeRegionType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined
  }

  const normalized = type.trim()
  const groupedType = normalized.match(/\(([^)]+)\)\s*$/)?.[1]?.trim()
  return groupedType || normalized || undefined
}

function normalizeStringArray(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  return input.map(value => value.trim()).filter(Boolean)
}

function mergeUniqueStrings(...groups: string[][]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const group of groups) {
    for (const value of group) {
      if (!value || seen.has(value)) {
        continue
      }

      seen.add(value)
      merged.push(value)
    }
  }

  return merged
}
