// EdgeOne 缓存「自愈」金丝雀：不用 purge，就定期看这些 URL 有没有跟上源站。
//
// 对每个样本比对两侧：
//   - 源站（S3 API 直连，绕开 CDN）：大小 / etag / cache-control
//   - 公开域名（经 EdgeOne）：大小 / etag / cache-control
// 「已跟上」的判据是公开域名也带上了正确的 Cache-Control（且大小与源站一致）。
//
// 用法:
//   npx tsx scripts/perf/cdn-canary.ts            # 默认抽 12 个
//   npx tsx scripts/perf/cdn-canary.ts 40         # 抽 40 个
import { readFileSync } from 'node:fs'

import { S3ProviderClient } from '../../packages/builder/src/storage/providers/s3-client.js'
import { env } from '../../env.js'

const SAMPLE = Number(process.argv[2] ?? 12)
const EXPECT_MARKER = 'max-age=86400'

const client = new S3ProviderClient({
  provider: 's3',
  bucket: env.S3_BUCKET_NAME,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  prefix: env.S3_PREFIX,
} as never)

const manifest = JSON.parse(readFileSync('apps/web/src/data/photos-manifest.json', 'utf8')) as {
  data: Array<Record<string, string> & { id: string }>
}
const publicBase = `${(env.S3_CUSTOM_DOMAIN ?? '').replace(/\/+$/, '')}/`

interface Kind { field: 'thumbnailUrl' | 'previewUrl' | 'ogImageUrl' | 'originalUrl', label: string }
const KINDS: Kind[] = [
  { field: 'thumbnailUrl', label: 'thumbnail' },
  { field: 'previewUrl', label: 'preview' },
  { field: 'ogImageUrl', label: 'og' },
  { field: 'originalUrl', label: 'original' },
]

const step = Math.max(1, Math.floor(manifest.data.length / SAMPLE))

const rows: Array<{ kind: string, id: string, sizeMatch: boolean, headerOk: boolean, hasImmutable: boolean, originSize: number, cdnSize: number, cdnCC: string }> = []

for (const kind of KINDS) {
  for (let i = 0; i < manifest.data.length; i += step) {
    const item = manifest.data[i]
    const url = item[kind.field]
    if (!url) continue
    const key = decodeURIComponent(url.slice(publicBase.length)).split('?')[0]

    const head = await client.headObject(key)
    const originSize = Number(head.headers.get('content-length') ?? 0)
    await head.body?.cancel()

    const cdn = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    const cdnSize = Number(cdn.headers.get('content-length') ?? 0)
    const cdnCC = cdn.headers.get('cache-control') ?? '(无)'

    rows.push({
      kind: kind.label,
      id: item.id,
      sizeMatch: cdnSize === originSize,
      headerOk: cdnCC.includes(EXPECT_MARKER),
      hasImmutable: cdnCC.includes('immutable'),
      originSize,
      cdnSize,
      cdnCC,
    })
  }
}

const byKind = new Map<string, typeof rows>()
for (const row of rows) {
  if (!byKind.has(row.kind)) byKind.set(row.kind, [])
  byKind.get(row.kind)!.push(row)
}

console.log(`抽样 ${rows.length} 个（每类 ${step} 步长），判据：公开域名也带 ${EXPECT_MARKER} 且大小与源站一致\n`)
for (const [kind, list] of byKind) {
  const ok = list.filter(r => r.sizeMatch && r.headerOk).length
  console.log(
    `${kind.padEnd(10)} 已跟上 CDN ${String(ok).padStart(2)}/${String(list.length).padEnd(2)}`
    + ` | 内容一致 ${list.filter(r => r.sizeMatch).length}/${list.length}`
    + ` | 带头 ${list.filter(r => r.headerOk).length}/${list.length}`,
  )
}

const stale = rows.filter(r => !(r.sizeMatch && r.headerOk))
if (stale.length > 0) {
  console.log('\n还没跟上的样本（前 6 个）：')
  for (const row of stale.slice(0, 6)) {
    console.log(`  ${row.kind.padEnd(10)} ${row.id.padEnd(28)} 源站 ${row.originSize} B / CDN ${row.cdnSize} B | cc=${row.cdnCC}`)
  }
  console.log('\n（EdgeOne 缓存未过期就会一直是旧值；不 purge 的话按各自 TTL 逐条自愈）')
}
else {
  console.log('\n✅ 全部已跟上')
}

// 最危险的情况：CDN 里缓存了 `immutable` 的响应（曾短暂地把原图设成 immutable，
// 如果恰好在那几分钟被 CDN 抓到，回访用户会一年看不到新图）。出现就必须立刻处理。
const immutableRows = rows.filter(r => r.hasImmutable)
if (immutableRows.length > 0) {
  console.log(`\n🚨 有 ${immutableRows.length} 个样本的 CDN 响应里带 immutable —— 必须处理：`)
  for (const row of immutableRows.slice(0, 6)) {
    console.log(`  ${row.kind.padEnd(10)} ${row.id.padEnd(28)} cc=${row.cc ?? row.cdnCC}`)
  }
  process.exitCode = 2
}

process.exitCode = process.exitCode === 2 ? 2 : (stale.length === 0 ? 0 : 1)
