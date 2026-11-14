/**
 * Regenerate the Cloudflare Pages OG middleware (`functions/_middleware.ts`)
 * without running the whole photo pipeline.
 *
 * The file is normally produced as a side effect of `pnpm build` (builder's
 * og-image-storage plugin with the `cloudflare-middleware` vendor). It is a
 * git-ignored build artifact — never commit it. This script is the fast path
 * for template/config tweaks and for verifying the on-disk file:
 *
 *   pnpm og:middleware                 # regenerate with the storage URL from .env (S3_CUSTOM_DOMAIN)
 *   pnpm og:middleware -- --check      # fail if the on-disk file is stale (local check, not CI)
 *   pnpm og:middleware -- --storage-url=https://cdn.example.com/gallery
 *
 * Env: OG_STORAGE_URL > --storage-url=… > S3_CUSTOM_DOMAIN from .env/process.env.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CloudflareMiddlewareVendor } from '../packages/builder/src/plugins/og-image-storage/vendors/cloudflare-moddleware.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'functions', '_middleware.ts')
// 照片文案表来自 manifest；--check 会把仓库根换成临时目录，所以这里用绝对路径
const manifestPath = path.join(root, 'apps/web/src/data/photos-manifest.json')
// drop the bare `--` pnpm inserts when invoked as `pnpm og:middleware -- --check`
const argv = process.argv.slice(2).filter(arg => arg !== '--')
const argValue = (name: string) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(`--${name}=`.length) : undefined
}

const checkOnly = argv.includes('--check')

function readEnvFileValue(key: string): string | undefined {
  const envPath = path.join(root, '.env')
  if (!existsSync(envPath)) { return undefined }
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (match && match[1] === key) { return match[2].trim().replace(/^['"]|['"]$/g, '') }
  }
  return undefined
}

const rawStorageUrl
  = argValue('storage-url')
    ?? process.env.OG_STORAGE_URL
    ?? process.env.S3_CUSTOM_DOMAIN
    ?? readEnvFileValue('S3_CUSTOM_DOMAIN')

if (!rawStorageUrl) {
  console.error(
    '✗ no storage URL — pass --storage-url=<url>, set OG_STORAGE_URL, or put S3_CUSTOM_DOMAIN in .env',
  )
  process.exit(1)
}

const storageURL = rawStorageUrl.replace(/\/+$/, '')
const logger = {
  main: {
    info: (...args: unknown[]) => console.info('[og-middleware]', ...args),
    warn: (...args: unknown[]) => console.warn('[og-middleware]', ...args),
  },
} as never

if (!existsSync(path.join(root, 'config.json'))) {
  console.error('✗ config.json is missing — run "node scripts/preinstall.mjs" (or copy config.example.json) first')
  process.exit(1)
}

async function generateInto(repoRoot: string): Promise<string> {
  const vendor = new CloudflareMiddlewareVendor({
    type: 'cloudflare-middleware',
    storageURL,
    siteConfigPath: 'config.json',
    manifestPath,
  })
  await vendor.build({ repoRoot, logger })
  return readFileSync(path.join(repoRoot, 'functions', '_middleware.ts'), 'utf8')
}

/**
 * 中间件里分支处理的每个路径前缀，都必须写进 `apps/web/public/_routes.json` 的
 * `include`，否则 Cloudflare Pages 不会把那个路径交给 Functions —— 请求会落到
 * 静态资源 / SPA 回退上。分享预览图 `/og/*` 就这么坏过一版：中间件分支写好了，
 * 但 `_routes.json` 只 include 了 `/photos/*`，于是 `<img>` 拿到 200 text/html，
 * 图片永远破图，而且没有任何构建/部署报错。
 */
function assertRoutesCoverage(source: string) {
  const routesPath = path.join(root, 'apps/web/public/_routes.json')
  const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as { include?: string[] }
  const include = routes.include ?? []
  const handled = ['/photos/', '/og/'].filter(prefix => source.includes(`startsWith('${prefix}')`))
  const missing = handled.filter(prefix => !include.includes(`${prefix}*`))
  if (missing.length > 0) {
    console.error(
      `✗ middleware handles ${missing.map(p => `"${p}*"`).join(', ')} but _routes.json include is ${JSON.stringify(include)}`
      + ` — add ${missing.map(p => `"${p}*"`).join(', ')} to apps/web/public/_routes.json`,
    )
    process.exit(1)
  }
}

if (checkOnly) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mfilmory-og-'))
  try {
    copyFileSync(path.join(root, 'config.json'), path.join(tmp, 'config.json'))
    const generated = await generateInto(tmp)
    assertRoutesCoverage(generated)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    rmSync(tmp, { recursive: true, force: true })
    if (generated === current) {
      console.info('✓ functions/_middleware.ts is up to date')
      process.exit(0)
    }
    console.error('✗ functions/_middleware.ts is stale — run "pnpm build" (or "pnpm og:middleware") to regenerate it')
    process.exit(1)
  }
  catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
mkdirSync(path.join(root, 'functions'), { recursive: true })
const after = await generateInto(root)
assertRoutesCoverage(after)

console.info(
  after === before
    ? `✓ ${path.relative(root, target)} unchanged (storageURL=${storageURL})`
    : `✓ ${path.relative(root, target)} updated (storageURL=${storageURL})`,
)
writeFileSync(target, after, 'utf8')
