import path from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import { backoffDelay, sleep } from '../../../../utils/src/backoff.js'
import { Semaphore } from '../../../../utils/src/semaphore.js'
import { SUPPORTED_FORMATS } from '../../constants/index.js'
import { logger } from '../../logger/index.js'
import type {
  ProgressCallback,
  S3CompatibleConfig,
  StorageObject,
  StorageProvider,
  StorageUploadOptions,
} from '../interfaces'
import { S3ProviderClient } from './s3-client.js'
import { sanitizeS3Etag } from './s3-utils.js'

// 将 AWS S3 对象转换为通用存储对象
const xmlParser = new XMLParser({ ignoreAttributes: false })

const MAX_ERROR_SNIPPET_LENGTH = 300

const pickStringField = (source: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function formatS3ErrorBody(body?: string | null): string {
  if (!body) {
    return '响应为空'
  }

  const trimmed = body.trim()
  if (!trimmed) {
    return '响应为空'
  }

  const pickCodeAndMessage = (payload: Record<string, unknown>): string | null => {
    if (!payload || typeof payload !== 'object') { return null }

    const code = pickStringField(payload, ['Code', 'code', 'ErrorCode'])
    const message = pickStringField(payload, ['Message', 'message', 'ErrorMessage'])
    const requestId = pickStringField(payload, ['RequestId', 'requestId'])
    const hostId = pickStringField(payload, ['HostId', 'hostId'])

    if (code || message) {
      const parts: string[] = []
      if (code) { parts.push(`[${code}]`) }
      if (message) { parts.push(message) }

      const extraDetails: string[] = []
      if (requestId) { extraDetails.push(`RequestId=${requestId}`) }
      if (hostId) { extraDetails.push(`HostId=${hostId}`) }
      if (extraDetails.length > 0) {
        parts.push(`(${extraDetails.join(', ')})`)
      }

      return parts.join(' ')
    }

    return null
  }

  const tryJson = () => {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        const direct = pickCodeAndMessage(parsed as Record<string, unknown>)
        if (direct) { return direct }
        if ('error' in parsed && typeof parsed.error === 'object' && parsed.error) {
          const nested = pickCodeAndMessage(parsed.error as Record<string, unknown>)
          if (nested) { return nested }
        }
      }
    }
    catch {
      // ignore JSON parse errors
    }
    return null
  }

  const tryXml = () => {
    try {
      const parsed = xmlParser.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        const errorNode
          = (parsed.Error as Record<string, unknown> | undefined)
            ?? (parsed.ErrorResponse as Record<string, unknown> | undefined)
            ?? (parsed as Record<string, unknown>)

        const formatted = pickCodeAndMessage(errorNode)
        if (formatted) { return formatted }
      }
    }
    catch {
      // ignore XML parse errors
    }
    return null
  }

  const formatted = tryJson() ?? tryXml()
  if (formatted) {
    return formatted
  }

  if (trimmed.length > MAX_ERROR_SNIPPET_LENGTH) {
    return `${trimmed.slice(0, MAX_ERROR_SNIPPET_LENGTH)}…`
  }

  return trimmed
}

export class S3StorageProvider implements StorageProvider {
  private config: S3CompatibleConfig
  private client: S3ProviderClient
  private limiter: Semaphore
  private uploadLimiter: Semaphore

  constructor(config: S3CompatibleConfig) {
    this.config = config
    this.client = new S3ProviderClient(config)
    const downloadConcurrency = Math.max(1, this.config.downloadConcurrency ?? 16)
    const uploadConcurrency = Math.max(1, this.config.uploadConcurrency ?? downloadConcurrency)
    this.limiter = new Semaphore(downloadConcurrency)
    this.uploadLimiter = new Semaphore(uploadConcurrency)
  }

  private async readStreamWithIdleTimeout(
    response: Response,
    controller: AbortController,
    idleTimeoutMs: number,
  ): Promise<{ buffer: Buffer, firstByteAt: number | null }> {
    if (!response.body) {
      return { buffer: Buffer.alloc(0), firstByteAt: null }
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let idleTimer: NodeJS.Timeout | null = null
    let firstByteAt: number | null = null

    const resetIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer) }
      idleTimer = setTimeout(() => {
        controller.abort()
      }, idleTimeoutMs)
    }

    resetIdle()

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        if (!firstByteAt) {
          firstByteAt = Date.now()
        }
        chunks.push(Buffer.from(value))
      }
      resetIdle()
    }

    if (idleTimer) {
      clearTimeout(idleTimer)
    }

    return {
      buffer: Buffer.concat(chunks),
      firstByteAt,
    }
  }

  async getFile(key: string): Promise<Buffer | null> {
    return await this.limiter.run(async () => {
      const maxAttempts = this.config.maxAttempts ?? 3
      const totalTimeoutMs = this.config.totalTimeoutMs ?? 60_000
      const idleTimeoutMs = this.config.idleTimeoutMs ?? 10_000

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startTime = Date.now()
        const controller = new AbortController()
        const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs)

        try {
          logger.s3.info(`下载开始：${key} (attempt ${attempt}/${maxAttempts})`)

          const response = await this.client.getObject(key, {
            signal: controller.signal,
          })

          if (!response.ok || !response.body) {
            const bodyText = await response.text().catch(() => '')
            logger.s3.error(`S3 响应异常：${key} (status ${response.status}) ${formatS3ErrorBody(bodyText)}`)
            logger.s3.error(bodyText)
            return null
          }

          const { buffer, firstByteAt } = await this.readStreamWithIdleTimeout(response, controller, idleTimeoutMs)
          clearTimeout(totalTimer)

          const duration = Date.now() - startTime
          const ttfb = firstByteAt ? firstByteAt - startTime : duration
          const sizeKB = Math.round(buffer.length / 1024)
          logger.s3.success(`下载完成：${key} (${sizeKB}KB, ${duration}ms, TTFB ${ttfb}ms, attempt ${attempt})`)
          return buffer
        }
        catch (error) {
          const elapsed = Date.now() - startTime
          logger.s3.warn(`下载失败：${key} (attempt ${attempt}/${maxAttempts}, ${elapsed}ms)`, error)
          clearTimeout(totalTimer)

          if (attempt < maxAttempts) {
            const delay = backoffDelay(attempt)
            logger.s3.info(`等待 ${delay}ms 后重试：${key}`)
            await sleep(delay)
            continue
          }
          logger.s3.error(`下载最终失败：${key}`)
          return null
        }
      }

      return null
    })
  }

  async listImages(): Promise<StorageObject[]> {
    const excludeRegex = this.config.excludeRegex ? new RegExp(this.config.excludeRegex) : null

    return await this.listObjects(undefined, (key) => {
      if (excludeRegex && excludeRegex.test(key)) {
        return false
      }
      return SUPPORTED_FORMATS.has(path.extname(key).toLowerCase())
    })
  }

  async listAllFiles(_progressCallback?: ProgressCallback): Promise<StorageObject[]> {
    // 同一个翻页逻辑，但不过滤格式：删除检测 / 上传去重 / Live Photo 配对需要看到全部对象
    return await this.listObjects()
  }

  generatePublicUrl(key: string): string {
    // 如果设置了自定义域名，直接使用自定义域名
    if (this.config.customDomain) {
      const customDomain = this.config.customDomain.replace(/\/$/, '') // 移除末尾的斜杠
      return `${customDomain}/${key}`
    }
    return this.client.buildObjectUrl(key)
  }

  detectLivePhotos(allObjects: StorageObject[]): Map<string, StorageObject> {
    const livePhotoMap = new Map<string, StorageObject>() // image key -> video object

    // 按目录和基础文件名分组所有文件
    const fileGroups = new Map<string, StorageObject[]>()

    for (const obj of allObjects) {
      if (!obj.key) { continue }

      const dir = path.dirname(obj.key)
      const basename = path.parse(obj.key).name
      const groupKey = `${dir}/${basename}`

      if (!fileGroups.has(groupKey)) {
        fileGroups.set(groupKey, [])
      }
      fileGroups.get(groupKey)!.push(obj)
    }

    // 在每个分组中寻找图片 + 视频配对
    for (const files of fileGroups.values()) {
      let imageFile: StorageObject | null = null
      let videoFile: StorageObject | null = null

      for (const file of files) {
        if (!file.key) { continue }

        const ext = path.extname(file.key).toLowerCase()

        // 检查是否为支持的图片格式
        if (SUPPORTED_FORMATS.has(ext)) {
          imageFile = file
        }
        // 检查是否为 .mov 或 .mp4 视频文件
        else if (ext === '.mov' || ext === '.mp4') {
          videoFile = file
        }
      }

      // 如果找到配对，记录为 live photo
      if (imageFile && videoFile && imageFile.key) {
        livePhotoMap.set(imageFile.key, videoFile)
      }
    }

    return livePhotoMap
  }

  /**
   * 翻页遍历所有对象；`accept` 只做逐条过滤，不影响翻页。
   *
   * 这里**没有**数量上限。决定「处理多少张照片」的只能是「排除产物之后」的结果，
   * 而产物前缀（`.afilmory/thumbnails|previews|og-images`）由插件注册在
   * `StorageManager.applyExcludes` 里。任何施加在这一层的配额都会被字典序最前的
   * `.afilmory/` 吃光——历史上 `maxFileLimit: 1000` 时因此拿到 0 张照片。
   */
  private async listObjects(
    prefix?: string,
    accept?: (key: string) => boolean,
  ): Promise<StorageObject[]> {
    const collected: StorageObject[] = []
    let continuationToken: string | null = null

    for (;;) {
      const { objects, nextContinuationToken, isTruncated } = await this.listPagedObjects(prefix, continuationToken)

      for (const obj of objects) {
        if (!obj.key) {
          continue
        }
        if (accept && !accept(obj.key)) {
          continue
        }
        collected.push(obj)
      }

      const hasMore = isTruncated || Boolean(nextContinuationToken)
      if (!hasMore || !nextContinuationToken) {
        break
      }

      continuationToken = nextContinuationToken
    }

    return collected
  }

  private async listPagedObjects(
    prefix?: string,
    continuationToken?: string | null,
  ): Promise<{ objects: StorageObject[], nextContinuationToken: string | null, isTruncated: boolean }> {
    // 每页固定 1000，一直翻到 `isTruncated` / `nextContinuationToken` 耗尽
    const maxKeysPerRequest = 1000
    const response = await this.client.listObjects({
      prefix: prefix ?? this.config.prefix,
      maxKeys: maxKeysPerRequest,
      continuationToken: continuationToken ?? undefined,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`列出 S3 对象失败 (status ${response.status}): ${formatS3ErrorBody(text)}`)
    }
    const parsed = xmlParser.parse(text)
    const result = parsed?.ListBucketResult ?? {}
    const contents = result?.Contents ?? []
    const items = Array.isArray(contents) ? contents : contents ? [contents] : []
    const nextContinuationToken
      = typeof result?.NextContinuationToken === 'string' && result.NextContinuationToken.trim().length > 0
        ? result.NextContinuationToken
        : null
    const isTruncatedRaw = result?.IsTruncated
    const isTruncated
      = typeof isTruncatedRaw === 'string' ? isTruncatedRaw.toLowerCase() === 'true' : Boolean(isTruncatedRaw)

    return {
      objects: items
        .map((item) => {
          const key = item?.Key ?? ''
          return {
            key,
            size: item?.Size !== undefined ? Number(item.Size) : undefined,
            lastModified: item?.LastModified ? new Date(item.LastModified) : undefined,
            etag: sanitizeS3Etag(typeof item?.ETag === 'string' ? item.ETag : undefined),
          } satisfies StorageObject
        })
        .filter(item => Boolean(item.key)),
      nextContinuationToken,
      isTruncated,
    }
  }

  async deleteFile(key: string): Promise<void> {
    const response = await this.client.deleteObject(key)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`删除 S3 对象失败：${key} (status ${response.status}) ${formatS3ErrorBody(text)}`)
    }
  }

  async deleteFolder(prefix: string): Promise<void> {
    const normalizedPrefix = this.normalizePrefix(prefix)
    const basePrefix = normalizedPrefix || this.config.prefix || ''
    const listPrefix = basePrefix || undefined
    const targetPrefix = basePrefix && !basePrefix.endsWith('/') ? `${basePrefix}/` : basePrefix

    const objects = await this.listObjects(listPrefix)

    const keysToDelete = objects
      .map(obj => obj.key)
      .filter((key): key is string => {
        if (!key) { return false }
        if (!targetPrefix) { return true }
        return key.startsWith(targetPrefix)
      })

    for (const key of keysToDelete) {
      await this.deleteFile(key)
    }
  }

  async uploadFile(key: string, data: Buffer, options?: StorageUploadOptions): Promise<StorageObject> {
    return await this.uploadLimiter.run(async () => {
      const headers: Record<string, string> = {
        'content-type': options?.contentType ?? 'application/octet-stream',
        'content-length': data.byteLength.toString(),
      }
      if (options?.cacheControl) {
        headers['cache-control'] = options.cacheControl
      }

      const maxAttempts = this.config.maxAttempts ?? 3
      const totalTimeoutMs = this.config.totalTimeoutMs ?? 60_000

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController()
        const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs)

        try {
          const response = await this.client.putObject(key, data as unknown as BodyInit, headers, {
            signal: controller.signal,
          })
          clearTimeout(totalTimer)

          if (!response.ok) {
            const text = await response.text().catch(() => '')
            const error = new Error(`上传 S3 对象失败：${key} (status ${response.status}) ${formatS3ErrorBody(text)}`)
            if (response.status >= 500 || response.status === 429) {
              throw error
            }
            throw error
          }

          return {
            key,
            size: data.byteLength,
            lastModified: new Date(),
            etag: sanitizeS3Etag(response.headers.get('etag')),
          }
        }
        catch (error) {
          clearTimeout(totalTimer)
          if (attempt < maxAttempts) {
            const delay = backoffDelay(attempt)
            logger.s3.warn(`上传重试：${key} (attempt ${attempt}/${maxAttempts}, ${delay}ms)`, error)
            await sleep(delay)
            continue
          }
          throw error
        }
      }

      throw new Error(`上传 S3 对象失败：${key}`)
    })
  }

  async moveFile(sourceKey: string, targetKey: string, options?: StorageUploadOptions): Promise<StorageObject> {
    if (sourceKey === targetKey) {
      const object = await this.getFile(sourceKey)
      if (!object) {
        throw new Error(`S3 move failed：源文件不存在 ${sourceKey}`)
      }
      return {
        key: targetKey,
        size: object.length,
        lastModified: new Date(),
      }
    }

    // CopyObject 默认沿用源对象的元数据（MetadataDirective: COPY），所以这里传的
    // content-type / cache-control 不显式 REPLACE 就是空操作。两个都没传时保持原行为。
    const moveHeaders: Record<string, string> = {}
    if (options?.contentType) {
      moveHeaders['content-type'] = options.contentType
    }
    if (options?.cacheControl) {
      moveHeaders['cache-control'] = options.cacheControl
    }
    if (Object.keys(moveHeaders).length > 0) {
      moveHeaders['x-amz-metadata-directive'] = 'REPLACE'
    }

    const { metadata } = await this.client.moveObject(sourceKey, targetKey, {
      headers: Object.keys(moveHeaders).length > 0 ? moveHeaders : undefined,
    })
    return {
      key: metadata.key,
      size: metadata.size,
      lastModified: metadata.lastModified,
      etag: sanitizeS3Etag(metadata.etag),
    }
  }

  private normalizePrefix(prefix: string): string {
    return prefix.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
  }
}
