/**
 * 清理远端存储里被新格式取代的资产对象。
 *
 * 换格式后（例如缩略图 JPEG → AVIF、OG 卡 PNG → WebP），`build:manifest --force-*`
 * 只会写入新扩展名的对象，旧对象会一直留着：`thumbnail-storage` / `og-image-storage`
 * 插件把自己的远端前缀注册成 excludePrefix，builder 的「已删除照片」扫描看不到它们。
 *
 * 仍然被 manifest 引用的旧格式对象会被跳过——所以先部署、确认线上用的是新格式，
 * 再跑 --delete 才是安全的。
 *
 * 用法：
 *   pnpm cleanup:assets                                        # 默认看缩略图，只统计
 *   pnpm cleanup:assets -- --delete                            # 删缩略图里的非 avif
 *   pnpm cleanup:assets -- --directory=.afilmory/og-images --keep=webp --delete
 *   pnpm cleanup:assets -- --directory=.afilmory/previews  --keep=avif --delete
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { StorageManager } from '@afilmory/builder'

import { env } from '../env.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIRECTORY = '.afilmory/thumbnails'
const DEFAULT_KEEP_EXTENSION = 'avif'
const KNOWN_EXTENSIONS = new Set(['avif', 'webp', 'jpg', 'jpeg', 'png'])

/** 目录 → manifest 里对应的字段，用来判断「还有没有人在引用」 */
const REFERENCE_FIELD_BY_DIRECTORY: Record<string, 'thumbnailUrl' | 'previewUrl' | 'ogImageUrl'> = {
  '.afilmory/thumbnails': 'thumbnailUrl',
  '.afilmory/previews': 'previewUrl',
  '.afilmory/og-images': 'ogImageUrl',
}

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function joinSegments(...segments: Array<string | undefined>): string {
  return segments
    .filter(Boolean)
    .map(segment => segment!.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
    .filter(segment => segment.length > 0)
    .join('/')
}

async function main() {
  const keepExtension = (parseFlag('keep') ?? DEFAULT_KEEP_EXTENSION).toLowerCase()
  const directory = (parseFlag('directory') ?? DEFAULT_DIRECTORY).replace(/^\/+|\/+$/g, '')
  const shouldDelete = process.argv.includes('--delete')
  const field = REFERENCE_FIELD_BY_DIRECTORY[directory] ?? 'thumbnailUrl'

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

  const prefix = `${joinSegments(env.S3_PREFIX, directory)}/`

  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/web/src/data/photos-manifest.json'), 'utf8'),
  ) as { data: Array<Record<string, unknown> & { id: string }> }
  const stillReferenced = new Set(
    manifest.data
      .filter((item) => {
        const url = item[field]
        return typeof url === 'string' && !url.endsWith(`.${keepExtension}`)
      })
      .map(item => item.id),
  )

  const allFiles = await storageManager.listAllFiles()
  const staleKeys = allFiles
    .map(object => object.key)
    .filter((key) => {
      if (!key.startsWith(prefix)) return false
      const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
      return extension !== keepExtension && KNOWN_EXTENSIONS.has(extension)
    })
  const deletableKeys = staleKeys.filter(key => !stillReferenced.has(path.basename(key, path.extname(key))))

  console.log(`目录     : ${prefix}`)
  console.log(`保留格式 : .${keepExtension}`)
  console.log(`引用字段 : ${field}`)
  console.log(
    `→ ${staleKeys.length} 个旧格式对象，${stillReferenced.size} 个仍被引用，${deletableKeys.length} 个可删`,
  )
  for (const key of deletableKeys.slice(0, 5)) console.log(`  e.g. ${key}`)

  if (!shouldDelete) {
    console.log('\n（只统计。确认线上已切到新格式后，加 `-- --delete` 真删）')
    return
  }

  let deleted = 0
  const failed: string[] = []
  for (const key of deletableKeys) {
    let done = false
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      try {
        await storageManager.deleteFile(key)
        done = true
      }
      catch (error) {
        if (attempt === 4) {
          failed.push(`${key}: ${(error as Error)?.message ?? String(error)}`)
        }
        else {
          await new Promise(resolve => setTimeout(resolve, 300 * attempt))
        }
      }
    }
    if (done) deleted++
    if ((deleted + failed.length) % 50 === 0) {
      console.log(`  进度 ${deleted + failed.length}/${deletableKeys.length}（失败 ${failed.length}）`)
    }
  }

  console.log(`\n删除 ${deleted}，失败 ${failed.length}`)
  for (const line of failed) console.log(`  FAILED ${line}`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
