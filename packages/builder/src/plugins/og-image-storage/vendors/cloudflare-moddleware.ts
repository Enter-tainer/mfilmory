import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import nunjucks from 'nunjucks'

import type { OgVendorBuildContext } from './types.js'
import { OgVendor } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = path.join(__dirname, 'templates')
const nunjucksEnv = nunjucks.configure(templatesDir, { autoescape: false })

export interface CloudflareMiddlewareVendorConfig {
  type: 'cloudflare-middleware'
  storageURL: string
  siteConfigPath?: string
  /** 保留配置字段以兼容已有 builder.config.ts；/photos/:id 元信息已在构建期静态 SSG 时直接写入 HTML。 */
  manifestPath?: string
}

function normalizeUrlToBase(value: string | undefined | null): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const parsed = new URL(withProtocol)
    const pathname = parsed.pathname.replace(/\/+$|^\/+/, '')
    const suffix = pathname ? `/${pathname}` : ''
    return `${parsed.origin}${suffix}`
  }
  catch {
    return null
  }
}

export class CloudflareMiddlewareVendor extends OgVendor {
  readonly type = 'cloudflare-middleware' as const

  constructor(private readonly options: CloudflareMiddlewareVendorConfig) {
    super()
  }

  private normalizeStorageOrigin(): string {
    const normalized = normalizeUrlToBase(this.options.storageURL)
    if (!normalized) {
      throw new Error('CloudflareMiddleware vendor requires a valid storageURL (e.g., https://cdn.example.com)')
    }
    return normalized
  }

  async build(context: OgVendorBuildContext): Promise<void> {
    const storageOrigin = this.normalizeStorageOrigin()
    const content = nunjucksEnv.render('cloudflare-middleware.njk', {
      ogBase: `${storageOrigin}/.afilmory/og-images`,
    })

    const functionsDir = path.join(context.repoRoot, 'functions')
    const target = path.join(functionsDir, '_middleware.ts')

    await mkdir(functionsDir, { recursive: true })
    await writeFile(target, content, 'utf8')

    context.logger.main.info(`OG image vendor (CloudflareMiddleware): wrote ${target}`)
  }
}
