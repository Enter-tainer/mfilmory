/**
 * 给**存量**媒体产物补写 `Cache-Control`（缩略图 / 占位图 / OG 卡）。
 *
 * 为什么需要单独一个脚本：上传时带 `Cache-Control` 是后来才加的（`thumbnail-storage` /
 * `og-image-storage` 用 `MEDIA_CACHE_CONTROL`），**只对之后上传的对象生效**。桶里的存量对象
 * 是没有这个头的，浏览器只能靠启发式缓存（约等于「文件年龄的 10%」），复访几乎每次都要
 * 重新下载 —— 实测线上缩略图覆盖请求约 726 KiB。
 *
 * 做法：**不动图像数据、不重新编码** —— 把对象读出来原样写回去，只带新的元数据。
 * 所以画质零变化、也不依赖 sharp；代价是每个对象一次读 + 一次写。
 *
 * 幂等：先用 HEAD 看对象的 `cache-control` 是否已经是期望值，已是则跳过。所以可以反复跑。
 *
 * 用法：
 *   pnpm refresh:cache                                  # 只统计，不写
 *   pnpm refresh:cache -- --apply                       # 真写
 *   pnpm refresh:cache -- --apply --only=thumbnails     # 只处理缩略图
 *   pnpm refresh:cache -- --apply --verify              # 写完后再 HEAD 复查一遍
 *   pnpm refresh:cache -- --apply --concurrency=16
 *
 * 注意：
 * - 写完后 Cloudflare 可能还在用它之前缓存的副本（没有 Cache-Control 时按默认策略），
 *   如果 HEAD 看到的仍是旧头，需要在该 zone 上对 `*​.afilmory/*` 做一次 purge。
 * - 非 S3 兼容provider（b2 / github / local / eagle）可能不支持写元数据，脚本会在
 *   上传后复查并报出来，不会假装成功。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { StorageManager } from '@afilmory/builder'

import { env } from '../env.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 packages/builder/src/plugins/thumbnail-storage/shared.ts 保持同一份事实 */
const EXPECTED_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800'

type Kind = 'thumbnails' | 'previews' | 'og-images'

/** manifest 字段 → 目录（kind） */
const FIELDS: Array<{ field: 'thumbnailUrl' | 'previewUrl' | 'ogImageUrl'; kind: Kind }> = [
  { field: 'thumbnailUrl', kind: 'thumbnails' },
  { field: 'previewUrl', kind: 'previews' },
  { field: 'ogImageUrl', kind: 'og-images' },
]

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
 * 所以这里可以严格按同一个规则反解，反解不出来就直接报错，不要猜。
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
 * 单个对象偶尔 `fetch failed`（1107 次里会碰上 1 次）是瞬时网络问题，重试几次即可，
 * 不该让整批 1100 个对象的前置检查作废。
 */
async function headCacheControl(url: string, attempts = 3): Promise<
  { state: 'has', value: string } | { state: 'missing' } | { state: 'error', message: string }
> {
  let lastMessage = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { method: 'HEAD' })
      if (!response.ok) {
        lastMessage = `HTTP ${response.status}`
        // 4xx 不重试（对象不存在/权限问题，重试也没用）
        if (response.status < 500) return { state: 'error', message: lastMessage }
      }
      else {
        const value = response.headers.get('cache-control')
        if (!value || !value.includes('max-age=86400')) return { state: 'missing' }
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
  const onlyFlag = (parseFlag('only') ?? '').split(',').map(item => item.trim()).filter(Boolean) as Kind[]
  const concurrency = Math.max(1, Math.min(32, Number(parseFlag('concurrency') ?? 8)))

  const customDomain = env.S3_CUSTOM_DOMAIN?.trim()
  if (!customDomain) {
    console.error('✗ 需要 .env 里的 S3_CUSTOM_DOMAIN —— manifest 里的公开 URL 要靠它反解成存储 key')
    process.exit(64)
  }
  const publicBase = `${customDomain.replace(/\/+$/, '')}/`

  const storageManager = new StorageManager({
    provider: 's3',
    bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
    customDomain: env.S3_CUSTOM_DOMAIN,
  })

  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/web/src/data/photos-manifest.json'), 'utf8'),
  ) as { data: Array<Record<string, unknown> & { id: string }> }

  // ── 收集目标（按 key 去重：同一天多张照片可能共用一张 OG 卡？目前不会，但去重更安全）
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
  console.log(`期望 Cache-Control: ${EXPECTED_CACHE_CONTROL}`)
  console.log(`种类筛选     : ${onlyFlag.length ? onlyFlag.join(', ') : '全部（缩略图 / 占位图 / OG 卡）'}`)
  console.log(`并发         : ${concurrency}`)
  console.log(`→ 共 ${targets.size} 个对象${unresolved.length ? `，${unresolved.length} 个 URL 无法反解` : ''}`)

  if (unresolved.length > 0) {
    console.error('✗ 这些 manifest URL 不是以 S3_CUSTOM_DOMAIN 开头，脚本不猜：')
    for (const line of unresolved.slice(0, 10)) console.error(`    ${line}`)
    process.exit(65)
  }

  // ── 1) 先 HEAD 一遍，找出缺 Cache-Control 的
  // 注意这里必须区分三种状态：已有 / 200 但没有头 / 请求本身失败。
  // 把「200 但没头」和「请求失败」混成一个 null 是之前踩过的坑 ——
  // 结果全部对象都显示「HEAD 失败」，然后因为 missing 为 0 而误报「全部已有」。
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
        const result = await headCacheControl(target.url)
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
    // 少数对象探测失败不阻断整批（1107 次里偶发 1 次是瞬时网络）；但不能当成「已有」而静默跳过。
    console.log(`  ⚠️  ${probeErrors.length} 个对象状态未知，本次会跳过它们；跑完再看是否需要单独重试。`)
    process.exitCode = 1
  }
  const byKind = (kind: Kind) => missing.filter(item => item.kind === kind).length
  for (const { kind } of FIELDS) {
    if (onlyFlag.length > 0 && !onlyFlag.includes(kind)) continue
    console.log(`  ${kind.padEnd(12)} 缺 ${byKind(kind)}`)
  }

  if (missing.length === 0) {
    console.log('\n✅ 全部已有 Cache-Control，不需要处理')
    return
  }
  if (!shouldApply) {
    console.log('\n（只统计，没写。加 `-- --apply` 才真写）')
    for (const item of missing.slice(0, 5)) console.log(`  e.g. ${item.key}`)
    return
  }

  // ── 2) 读出来原样写回去，只换元数据
  let written = 0
  const failed: string[] = []
  {
    let done = 0
    const queue = missing.slice()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const target = queue.shift()!
        try {
          const buffer = await storageManager.getFile(target.key)
          if (!buffer) throw new Error('getFile 返回空（对象不存在或读权限不足）')
          await storageManager.uploadFile(target.key, buffer, {
            contentType: contentTypeFor(target.key),
            cacheControl: EXPECTED_CACHE_CONTROL,
          })
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

  // ── 3) 复查（可选）
  if (shouldVerify) {
    console.log('\n=== 复查（HEAD 线上 URL）===')
    let ok = 0
    let bad = 0
    const badSamples: string[] = []
    {
      const queue = missing.slice()
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
          const target = queue.shift()!
          const result = await headCacheControl(target.url)
          if (result.state === 'has') ok++
          else {
            bad++
            if (badSamples.length < 5) {
              badSamples.push(`${target.key} → ${result.state === 'error' ? `探测失败(${result.message})` : '(无 Cache-Control)'}`)
            }
          }
        }
      }))
    }
    console.log(`  已生效 ${ok}，仍不对 ${bad}`)
    for (const line of badSamples) console.log(`    ${line}`)
    if (bad > 0) {
      console.log('  ⚠️  若刚写完立刻复查就还是旧头，通常是 Cloudflare 边缘还在用旧副本，')
      console.log('      对 `*.afilmory/*` purge 后再看。')
      process.exitCode = 1
    }
  }

  if (failed.length > 0) process.exitCode = 1
}

await main()
