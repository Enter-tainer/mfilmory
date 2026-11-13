/**
 * 清理远端存储里旧格式的缩略图对象。
 *
 * 换缩略图格式后（例如 JPEG → AVIF），`build:manifest -- --force-thumbnails` 只会
 * 上传新扩展名的对象，旧对象会一直留着：`thumbnail-storage` 插件把自己的远端前缀
 * 注册成 excludePrefix，builder 的「已删除照片」扫描根本看不到这些文件。
 *
 * 仍然被 manifest 引用的旧格式对象会被跳过（例如上次因为下载失败没有重生成的照片）。
 *
 * 用法：
 *   pnpm cleanup:thumbnails                       # 只统计，不删
 *   pnpm cleanup:thumbnails -- --delete          # 真的删
 *   pnpm cleanup:thumbnails -- --keep=avif --delete
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { StorageManager } from '@afilmory/builder'

import { env } from '../env.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIRECTORY = '.afilmory/thumbnails'
const DEFAULT_KEEP_EXTENSION = 'avif'
const THUMBNAIL_EXTENSIONS = new Set(['avif', 'webp', 'jpg', 'jpeg', 'png'])

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function joinSegments(...segments: Array<string | undefined>): string {
  return segments
    .filter(Boolean)
    .map((segment) => segment!.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/')
}

async function main() {
  const keepExtension = (parseFlag('keep') ?? DEFAULT_KEEP_EXTENSION).toLowerCase()
  const directory = parseFlag('directory') ?? DEFAULT_DIRECTORY
  const shouldDelete = process.argv.includes('--delete')

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
  ) as { data: Array<{ id: string, thumbnailUrl?: string | null }> }
  const stillReferenced = new Set(
    manifest.data
      .filter((item) => typeof item.thumbnailUrl === 'string' && !item.thumbnailUrl.endsWith(`.${keepExtension}`))
      .map((item) => item.id),
  )

  const allFiles = await storageManager.listAllFiles()
  const staleKeys = allFiles
    .map((object) => object.key)
    .filter((key) => {
      if (!key.startsWith(prefix)) return false
      const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
      return extension !== keepExtension && THUMBNAIL_EXTENSIONS.has(extension)
    })
  const deletableKeys = staleKeys.filter((key) => !stillReferenced.has(path.basename(key, path.extname(key))))

  console.log(
    `${prefix} → ${staleKeys.length} stale object(s), ${stillReferenced.size} still referenced, ${deletableKeys.length} deletable`,
  )
  for (const key of deletableKeys.slice(0, 5)) console.log(`  e.g. ${key}`)

  if (!shouldDelete) {
    console.log('dry run — pass `-- --delete` to remove them')
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
      } catch (error) {
        if (attempt === 4) {
          failed.push(`${key}: ${(error as Error)?.message ?? String(error)}`)
        } else {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
        }
      }
    }
    if (done) deleted++
    if ((deleted + failed.length) % 50 === 0) {
      console.log(`  progress ${deleted + failed.length}/${deletableKeys.length} (failed ${failed.length})`)
    }
  }

  console.log(`deleted ${deleted}, failed ${failed.length}`)
  for (const line of failed) console.log(`  FAILED ${line}`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
