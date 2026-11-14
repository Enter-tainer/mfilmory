/**
 * 给**存量**媒体对象补写 `Cache-Control`（缩略图 / 占位图 / OG 卡 / 原图）。
 *
 * 为什么需要单独一个脚本：上传时带 `Cache-Control` 是后来才加的（`thumbnail-storage` /
 * `og-image-storage` 用 `MEDIA_CACHE_CONTROL`），**只对之后上传的对象生效**。桶里的存量对象
 * 是没有这个头的，浏览器只能靠启发式缓存（约等于「文件年龄的 10%」），复访几乎每次都要
 * 重新下载 —— 实测线上缩略图覆盖请求约 726 KiB。
 *
 * 做法：**不动图像数据**，用 S3 的 `CopyObject` + `x-amz-metadata-directive: REPLACE`
 * 原地复制、只换元数据。这是纯服务端操作，**零出网流量**；369 张原图合计几个 GB，
 * 用「下载再上传」的做法会白烧双倍流量。
 *
 * 所有种类用同一套策略：`public, max-age=86400, stale-while-revalidate=604800`。
 *
 * **为什么原图也不能用 `immutable`**（曾经写错过一次）：`immutable` 的语义是在 `max-age`
 * 有效期内「连条件请求都不要发」。它只对**文件名里带内容哈希**的资源成立。这里的文件名是
 * 「日期+相机编号」（`20261104-LKXG5370.jpg`、`P1201842.jpg`）——重新导出同一张照片时文件名
 * 不变、内容变了。用 `immutable` + 一年有效期会让回访用户最长一年看不到新图，且永远不会
 * 去验证。所以原图和产物一样，1 天后开始后台验证。
 *
 * 幂等：先 HEAD 看对象的 `cache-control` 是否已是期望值，已是则跳过，可反复跑。
 *
 * 用法：
 *   pnpm refresh:cache                                  # 只统计，不写
 *   pnpm refresh:cache -- --apply                       # 真写（产物 + 原图）
 *   pnpm refresh:cache -- --apply --only=thumbnails       # 只处理某一类
 *   pnpm refresh:cache -- --apply --only=originals        # 只给原图加 immutable
 *   pnpm refresh:cache -- --apply --verify                # 写完再 HEAD 复查
 *   pnpm refresh:cache -- --apply --reupload              # 退回「下载再上传」（CopyObject 不可用时）
 *
 * 注意：
 * - **CDN 层缓存不会因此失效**。若 `S3_CUSTOM_DOMAIN` 前面有 CDN（本站是腾讯 EdgeOne），
 *   它的缓存键忽略 query、且若配置了「强制缓存 N 天」就不会因对象覆盖而回源 —— 那种情况下
 *   必须去 CDN 控制台刷新缓存，并把缓存策略改成「遵循源站 Cache-Control」。
 *   实测现象：源站 S3 直连 HEAD 已是新头，公开域名却还在发旧头、甚至旧内容（512px 老缩略图）。
 * - 非 S3 兼容 provider（b2 / github / local / eagle）不支持写元数据，脚本不做保证。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { StorageManager } from '@afilmory/builder'

import { S3ProviderClient } from '../packages/builder/src/storage/providers/s3-client.js'
import { env } from '../env.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 产物与原图共用同一套策略 —— 见文件头「为什么原图也不能用 immutable」 */
const MEDIA_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800'

type Kind = 'thumbnails' | 'previews' | 'og-images' | 'originals'

/** manifest 字段 → 种类 */
const FIELDS: Array<{ field: 'thumbnailUrl' | 'previewUrl' | 'ogImageUrl' | 'originalUrl', kind: Kind }> = [
  { field: 'thumbnailUrl', kind: 'thumbnails' },
  { field: 'previewUrl', kind: 'previews' },
  { field: 'ogImageUrl', kind: 'og-images' },
  { field: 'originalUrl', kind: 'originals' },
]

/** 每种对象的期望值与轻量判定串（策略统一，见文件头说明） */
const POLICY: Record<Kind, { cacheControl: string, marker: string }> = {
  thumbnails: { cacheControl: MEDIA_CACHE_CONTROL, marker: 'max-age=86400' },
  previews: { cacheControl: MEDIA_CACHE_CONTROL, marker: 'max-age=86400' },
  'og-images': { cacheControl: MEDIA_CACHE_CONTROL, marker: 'max-age=86400' },
  originals: { cacheControl: MEDIA_CACHE_CONTROL, marker: 'max-age=86400' },
}

/** 明确禁止出现的值 —— 文件名不含内容哈希，`immutable` 会让改了图也永远不更新 */
const FORBIDDEN_MARKERS = ['immutable']

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function contentTypeFor(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

interface Target {
  key: string
  url: string
  kind: Kind
}

/**
 * 把 manifest 里的公开 URL 反解回存储 key。
 * 公开 URL 的构造方式是 `generatePublicUrl(key) = customDomain(去尾斜杠) + '/' + key`，
 * 所以这里严格按同一个规则反解，反解不出来直接报错，不猜。
 */
function toKey(url: string, publicBase: string): string | null {
  if (!url.startsWith(publicBase)) return null
  return decodeURIComponent(url.slice(publicBase.length)).split('?')[0]
}

/**
 * 探测对象的 `cache-control`。三种状态必须分开：
 * `has` / `missing`（200 但头不对）/ `error`（请求本身失败）。
 * 把「200 但没头」和「请求失败」混成一个 null 是踩过的坑 —— 1107 个对象全部被当成
 * 「HEAD 失败」，然后因为 missing 为 0 而误报「全部已有」。
 *
 * 单个对象偶发 `fetch failed`（上千次里会碰上）是瞬时网络问题，重试几次即可，
 * 不该让整批的前置检查作废。
 */
async function headCacheControl(url: string, marker: string, attempts = 3): Promise<
  { state: 'has', value: string } | { state: 'missing' } | { state: 'error', message: string }
> {
  let lastMessage = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (!response.ok) {
        lastMessage = `HTTP ${response.status}`
        if (response.status < 500) return { state: 'error', message: lastMessage }
      }
      else {
        const value = response.headers.get('cache-control')
        if (!value || !value.includes(marker)) return { state: 'missing' }
        // 值里出现 immutable 一律算不合格：本仓库的文件名不含内容哈希
        if (FORBIDDEN_MARKERS.some(bad => value.includes(bad))) return { state: 'missing' }
        return { state: 'has', value }
      }
    }
    catch (error) {
      lastMessage = (error as Error)?.message ?? String(error)
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * attempt))
  }
  return { state: 'error', message: lastMessage }
}

async function main() {
  const shouldApply = process.argv.includes('--apply')
  const shouldVerify = process.argv.includes('--verify')
  const useReupload = process.argv.includes('--reupload')
  const onlyFlag = (parseFlag('only') ?? '').split(',').map(item => item.trim()).filter(Boolean) as Kind[]
  const concurrency = Math.max(1, Math.min(32, Number(parseFlag('concurrency') ?? 8)))

  const customDomain = env.S3_CUSTOM_DOMAIN?.trim()
  if (!customDomain) {
    console.error('✗ 需要 .env 里的 S3_CUSTOM_DOMAIN —— manifest 里的公开 URL 要靠它反解成存储 key')
    process.exit(64)
  }
  const publicBase = `${customDomain.replace(/\/+$/, '')}/`

  const storageConfig = {
    provider: 's3' as const,
    bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
    customDomain: env.S3_CUSTOM_DOMAIN,
  }
  const storageManager = new StorageManager(storageConfig)
  const client = new S3ProviderClient(storageConfig as never)

  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/web/src/data/photos-manifest.json'), 'utf8'),
  ) as { data: Array<Record<string, unknown> & { id: string }> }

  // ── 收集目标（按 key 去重）
  const targets = new Map<string, Target>()
  const unresolved: string[] = []
  for (const item of manifest.data) {
    for (const { field, kind } of FIELDS) {
      if (onlyFlag.length > 0 && !onlyFlag.includes(kind)) continue
      const url = item[field]
      if (typeof url !== 'string' || url.length === 0) continue
      const key = toKey(url, publicBase)
      if (!key) { unresolved.push(`${item.id}.${field} = ${url}`); continue }
      targets.set(key, { key, url, kind })
    }
  }

  console.log(`公开 URL 前缀 : ${publicBase}`)
  console.log(`写入方式     : ${useReupload ? '下载再上传（--reupload）' : 'CopyObject 原地复制 + REPLACE 元数据（零出网）'}`)
  console.log(`种类筛选     : ${onlyFlag.length ? onlyFlag.join(', ') : '全部（缩略图 / 占位图 / OG 卡 / 原图）'}`)
  console.log(`并发         : ${concurrency}`)
  console.log(`→ 共 ${targets.size} 个对象${unresolved.length ? `，${unresolved.length} 个 URL 无法反解` : ''}`)
  if (unresolved.length > 0) {
    console.error('✗ 这些 manifest URL 不是以 S3_CUSTOM_DOMAIN 开头，脚本不猜：')
    for (const line of unresolved.slice(0, 10)) console.error(`    ${line}`)
    process.exit(65)
  }

  // ── 1) 探测现状
  const list = [...targets.values()]
  const missing: Target[] = []
  const probeErrors: string[] = []
  let alreadyOk = 0
  {
    let done = 0
    const queue = list.slice()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const target = queue.shift()!
        const result = await headCacheControl(target.url, POLICY[target.kind].marker)
        if (result.state === 'has') alreadyOk++
        else if (result.state === 'error') {
          if (probeErrors.length < 10) probeErrors.push(`${target.key}: ${result.message}`)
        }
        else missing.push(target)
        done++
        if (done % 100 === 0) console.log(`  检查 ${done}/${list.length}（已有 ${alreadyOk}，缺 ${missing.length}，探测失败 ${probeErrors.length}）`)
      }
    }))
  }

  console.log(`\n检查结果：已有 Cache-Control ${alreadyOk} 个，缺失 ${missing.length} 个，探测失败 ${probeErrors.length} 个`)
  for (const line of probeErrors) console.log(`  PROBE-FAILED ${line}`)
  if (probeErrors.length > 0) {
    console.log(`  ⚠️  ${probeErrors.length} 个对象状态未知，本次会跳过；跑完再看是否需单独重试。`)
    process.exitCode = 1
  }
  for (const { kind } of FIELDS) {
    if (onlyFlag.length > 0 && !onlyFlag.includes(kind)) continue
    console.log(`  ${kind.padEnd(12)} 缺 ${missing.filter(item => item.kind === kind).length}`)
  }

  if (missing.length === 0) {
    console.log('\n✅ 全部已有正确的 Cache-Control，不需要处理')
    return
  }
  if (!shouldApply) {
    console.log('\n（只统计，没写。加 `-- --apply` 才真写）')
    for (const item of missing.slice(0, 5)) console.log(`  e.g. ${item.kind.padEnd(11)} ${item.key}`)
    return
  }

  // ── 2) 写入元数据
  let written = 0
  const failed: string[] = []
  {
    let done = 0
    const queue = missing.slice()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const target = queue.shift()!
        const cacheControl = POLICY[target.kind].cacheControl
        try {
          if (useReupload) {
            const buffer = await storageManager.getFile(target.key)
            if (!buffer) throw new Error('getFile 返回空（对象不存在或读权限不足）')
            await storageManager.uploadFile(target.key, buffer, {
              contentType: contentTypeFor(target.key),
              cacheControl,
            })
          }
          else {
            const response = await client.copyObject(target.key, target.key, {
              'x-amz-metadata-directive': 'REPLACE',
              'content-type': contentTypeFor(target.key),
              'cache-control': cacheControl,
            })
            const body = await response.text()
            if (!response.ok) {
              throw new Error(`CopyObject ${response.status} ${body.slice(0, 200)}`)
            }
          }
          written++
        }
        catch (error) {
          failed.push(`${target.key}: ${(error as Error)?.message ?? String(error)}`)
        }
        done++
        if (done % 50 === 0) console.log(`  写入 ${done}/${missing.length}（成功 ${written}，失败 ${failed.length}）`)
      }
    }))
  }

  console.log(`\n写入完成：成功 ${written}，失败 ${failed.length}`)
  for (const line of failed.slice(0, 10)) console.log(`  FAILED ${line}`)
  if (failed.length > 0) process.exitCode = 1

  // ── 3) 复查（可选）—— 走公开 URL，所以能顺带暴露「CDN 缓存没刷」的问题
  if (shouldVerify) {
    console.log('\n=== 复查（HEAD 公开 URL）===')
    let ok = 0
    let bad = 0
    const badSamples: string[] = []
    {
      const queue = missing.slice()
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
          const target = queue.shift()!
          const result = await headCacheControl(target.url, POLICY[target.kind].marker)
          if (result.state === 'has') ok++
          else {
            bad++
            if (badSamples.length < 5) {
              badSamples.push(`${target.kind} ${target.key} → ${result.state === 'error' ? `探测失败(${result.message})` : '(无正确 Cache-Control)'}`)
            }
          }
        }
      }))
    }
    console.log(`  已生效 ${ok}，仍不对 ${bad}`)
    for (const line of badSamples) console.log(`    ${line}`)
    if (bad > 0) {
      console.log('  ⚠️  刚写完立刻复查仍是旧头，通常是 CDN 边缘缓存还没失效。')
      console.log('      该 CDN 若「缓存键忽略 query」且「强制缓存 N 天」，加 query 也绕不过 ——')
      console.log('      去控制台刷新缓存，并把缓存策略改成「遵循源站 Cache-Control」。')
      process.exitCode = 1
    }
  }
}

await main()
