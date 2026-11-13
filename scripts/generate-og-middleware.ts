/**
 * Regenerate the Cloudflare Pages OG middleware (`functions/_middleware.ts`)
 * without running the whole photo pipeline.
 *
 * The file is normally produced as a side effect of `pnpm build` (builder's
 * og-image-storage plugin with the `cloudflare-middleware` vendor). This script
 * is the fast path for template/config tweaks and for CI checks:
 *
 *   pnpm og:middleware                 # regenerate with the storage URL from .env (S3_CUSTOM_DOMAIN)
 *   pnpm og:middleware -- --check      # fail if the committed file is stale
 *   pnpm og:middleware -- --storage-url=https://cdn.example.com/gallery
 *
 * Env: OG_STORAGE_URL > --storage-url=… > S3_CUSTOM_DOMAIN from .env/process.env.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CloudflareMiddlewareVendor } from '../packages/builder/src/plugins/og-image-storage/vendors/cloudflare-moddleware.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'functions', '_middleware.ts')
const argv = process.argv.slice(2)
const argValue = (name: string) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(`--${name}=`.length) : undefined
}

const checkOnly = argv.includes('--check')

function readEnvFileValue(key: string): string | undefined {
  const envPath = path.join(root, '.env')
  if (!existsSync(envPath)) return undefined
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (match && match[1] === key) return match[2].trim().replace(/^['"]|['"]$/g, '')
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
  })
  await vendor.build({ repoRoot, logger })
  return readFileSync(path.join(repoRoot, 'functions', '_middleware.ts'), 'utf8')
}

if (checkOnly) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mfilmory-og-'))
  try {
    copyFileSync(path.join(root, 'config.json'), path.join(tmp, 'config.json'))
    const generated = await generateInto(tmp)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    rmSync(tmp, { recursive: true, force: true })
    if (generated === current) {
      console.info('✓ functions/_middleware.ts is up to date')
      process.exit(0)
    }
    console.error('✗ functions/_middleware.ts is stale — run "pnpm og:middleware" and commit the result')
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

console.info(
  after === before
    ? `✓ ${path.relative(root, target)} unchanged (storageURL=${storageURL})`
    : `✓ ${path.relative(root, target)} updated (storageURL=${storageURL}) — commit the result`,
)
writeFileSync(target, after, 'utf8')
