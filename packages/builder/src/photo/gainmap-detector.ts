import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'

import type { ConsolaInstance } from 'consola'
import type { ContainerDirectoryItem } from 'exiftool-vendored'

import { isAvif, readAvifInfo } from '../image/avif-color.js'
import type { PhotoLogger } from './logger-adapter.js'

interface GainMapDetectParams {
  exifData?: Record<string, unknown> | null
  logger?: ConsolaInstance
}

/**
 * Detects HDR GainMap from ContainerDirectory metadata.
 * Works for both static Ultra HDR images and Motion Photo + HDR combinations.
 */
export const detectGainMap = ({ exifData, logger }: GainMapDetectParams): boolean => {
  try {
    const containerDirectory = exifData?.ContainerDirectory as ContainerDirectoryItem[] | undefined
    if (!containerDirectory || !Array.isArray(containerDirectory)) {
      return false
    }

    // Find GainMap item
    for (const entry of containerDirectory) {
      const item = entry.Item
      if (!item) {
        continue
      }

      if (item.Semantic === 'GainMap' && item.Length) {
        logger?.info('[gainmap] Found HDR GainMap in ContainerDirectory')
        return true
      }
    }

    return false
  }
  catch (error) {
    logger?.error('[gainmap] Unexpected error while detecting', error)
    return false
  }
}

/**
 * `meta` 盒总在文件开头；1MB 足够覆盖 iinf / pitm / iref / iprp（tmap 项名都在这里）。
 * 只有 `idat` 里塞了大块 XMP 的极端容器才会超，超了就当「读不出来」处理。
 */
const AVIF_PROBE_BYTES = 64
const AVIF_HEADER_BYTES = 1024 * 1024

async function readRange(handle: fs.FileHandle, buffer: Buffer, offset: number, length: number, filePos: number): Promise<number> {
  let totalRead = 0
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buffer, offset + totalRead, length - totalRead, filePos + totalRead)
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }
  return totalRead
}

async function readHeader(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const probeLength = Math.min(AVIF_PROBE_BYTES, size)
    const probe = Buffer.allocUnsafe(probeLength)
    const probeRead = await readRange(handle, probe, 0, probeLength, 0)
    const actualProbe = probeRead === probeLength ? probe : probe.subarray(0, probeRead)
    if (!isAvif(actualProbe) || size <= probeRead || maxBytes <= probeRead) {
      return actualProbe
    }

    const length = Math.min(maxBytes, size)
    const buffer = Buffer.allocUnsafe(length)
    actualProbe.copy(buffer, 0)
    const restRead = await readRange(handle, buffer, probeRead, length - probeRead, probeRead)
    return buffer.subarray(0, probeRead + restRead)
  }
  finally {
    await handle.close()
  }
}

/**
 * AVIF Ultra HDR 判定：容器里有没有 `tmap` 派生项。
 *
 * JPEG 的 gain map 靠 exiftool 的 `ContainerDirectory` / `MPImageType` 就能看出来，
 * AVIF 在元数据层面是隐形的（`sharp.metadata().gainMap` 只认 JPEG），只能读容器。
 *
 * @returns `null` 表示「这次拿不到原图字节，判不了」——调用方应保留上一次构建的结论，
 *          而不是把 `isHDR` 覆写成 false。
 */
export async function detectAvifGainMap(
  imageBuffer?: Buffer,
  imagePath?: string,
  logger?: Pick<PhotoLogger, 'info' | 'warn'>,
): Promise<boolean | null> {
  let header: Uint8Array
  try {
    if (imageBuffer) {
      header = imageBuffer.subarray(0, Math.min(AVIF_HEADER_BYTES, imageBuffer.length))
    }
    else if (imagePath) {
      header = await readHeader(imagePath, AVIF_HEADER_BYTES)
    }
    else {
      return null
    }
  }
  catch (error) {
    logger?.warn('[gainmap] 读原图文件头失败，跳过 AVIF HDR 判定', error)
    return null
  }

  if (!isAvif(header)) {
    // 非 AVIF：JPEG / HEIC 的 HDR 判定走 exif 那几条路径。
    return false
  }
  try {
    const info = readAvifInfo(header, true)
    if (!info) {
      return null
    }
    if (info.hasGainMap) {
      logger?.info(`[gainmap] Found AVIF tone-map item (tmap), primary=${info.primaryType ?? 'unknown'}`)
    }
    return info.hasGainMap
  }
  catch (error) {
    // 容器结构不认识：不因为一张怪图把构建打挂，保留上次结论。
    logger?.warn('[gainmap] AVIF 容器解析失败，跳过 HDR 判定', error)
    return null
  }
}
