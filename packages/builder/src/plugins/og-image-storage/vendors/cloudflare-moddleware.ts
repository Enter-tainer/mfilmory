import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PhotoManifestItem } from '@afilmory/typing'
import nunjucks from 'nunjucks'

import type { Logger } from '../../../logger/index.js'
import type { PhotoOgText } from '../photo-text.js'
import { buildPhotoOgTextMap } from '../photo-text.js'
import type { OgVendorBuildContext } from './types.js'
import { OgVendor } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = path.join(__dirname, 'templates')
const nunjucksEnv = nunjucks.configure(templatesDir, { autoescape: false })

const DEFAULT_SITE_ORIGIN = 'https://example.com'
const DEFAULT_SITE_NAME = 'Photo Gallery'
const DEFAULT_MANIFEST_PATH = 'apps/web/src/data/photos-manifest.json'

export interface CloudflareMiddlewareVendorConfig {
  type: 'cloudflare-middleware'
  storageURL: string
  siteConfigPath?: string
  /** 照片 manifest 路径（用于把每张照片的标题/描述注入中间件），相对路径按仓库根解析。 */
  manifestPath?: string
}

/** 模板里这两个值落在 JS 字符串字面量里，用 JSON 编码而不是 HTML 转义。 */
function toJsStringLiteral(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function escapeRegexLiteral(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeUrlToOrigin(value: string | undefined | null): string | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const parsed = new URL(withProtocol)
    return parsed.origin
  }
  catch {
    return null
  }
}

function normalizeUrlToBase(value: string | undefined | null): string | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null

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

function resolveFromRepoRoot(target: string | undefined, repoRoot: string, fallback: string): string {
  const value = target ?? fallback
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
}

interface SiteMeta {
  origin: string
  name: string
}

async function loadSiteMeta(configPath: string, logger: Logger): Promise<SiteMeta> {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<{ url?: string, name?: string, title?: string }>
    const origin = normalizeUrlToOrigin(parsed.url)

    if (!origin) {
      logger.main.info(`OG image plugin: missing or invalid site.url in ${configPath}, using fallback origin.`)
    }

    return {
      origin: origin ?? DEFAULT_SITE_ORIGIN,
      name: parsed.name?.trim() || parsed.title?.trim() || DEFAULT_SITE_NAME,
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.main.info(`OG image plugin: using fallback site meta (cannot read ${configPath}: ${message}).`)
    return { origin: DEFAULT_SITE_ORIGIN, name: DEFAULT_SITE_NAME }
  }
}

/**
 * 把整库的「卡片文字」编成一张 map，直接内嵌进边缘函数。
 *
 * 分享平台的爬虫只读服务端返回的 HTML，而 SPA 每张照片都是同一份 index.html，
 * 所以逐张照片的标题/描述只能在中间件里补。这张表在 `pnpm build` 时生成，
 * 单张照片约 150 字节，369 张 ≈ 55KB，远低于 Pages Functions 的体积上限。
 */
async function loadPhotoTextMap(
  manifestPath: string,
  siteName: string,
  logger: Logger,
): Promise<Record<string, PhotoOgText>> {
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as { data?: PhotoManifestItem[] }
    const photos = Array.isArray(parsed.data) ? parsed.data : []
    logger.main.info(`OG image plugin: embedded card copy for ${photos.length} photos from ${manifestPath}.`)
    return buildPhotoOgTextMap(photos, { siteName })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.main.warn(
      `OG image plugin: cannot read ${manifestPath} (${message}); middleware will fall back to the site-level title/description.`,
    )
    return {}
  }
}

interface TemplateData {
  siteOrigin: string
  siteName: string
  patternHost: string
  ogBase: string
  photoTextJson: string
}

function renderCloudflareMiddlewareTemplate(data: TemplateData): string {
  return nunjucksEnv.render('cloudflare-middleware.njk', {
    siteOriginJson: toJsStringLiteral(data.siteOrigin),
    siteNameJson: toJsStringLiteral(data.siteName),
    patternHost: data.patternHost,
    ogBase: data.ogBase,
    photoTextJson: data.photoTextJson,
  })
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

  private renderTemplate(data: TemplateData): string {
    return renderCloudflareMiddlewareTemplate(data)
  }

  async build(context: OgVendorBuildContext): Promise<void> {
    const siteConfigPath = resolveFromRepoRoot(this.options.siteConfigPath, context.repoRoot, 'config.json')
    const manifestPath = resolveFromRepoRoot(this.options.manifestPath, context.repoRoot, DEFAULT_MANIFEST_PATH)

    const site = await loadSiteMeta(siteConfigPath, context.logger)
    const storageOrigin = this.normalizeStorageOrigin()

    const patternHost = (() => {
      try {
        return escapeRegexLiteral(new URL(site.origin).host)
      }
      catch {
        return escapeRegexLiteral(new URL(DEFAULT_SITE_ORIGIN).host)
      }
    })()

    const photoText = await loadPhotoTextMap(manifestPath, site.name, context.logger)

    const content = this.renderTemplate({
      siteOrigin: site.origin,
      siteName: site.name,
      patternHost,
      ogBase: `${storageOrigin}/.afilmory/og-images`,
      // `</` 转义避免 JSON 里的字符串提前结束一个内联 script；这里是模块，仍然保留转义以防以后被内联
      photoTextJson: JSON.stringify(photoText).replaceAll('</', '<\\/'),
    })

    const functionsDir = path.join(context.repoRoot, 'functions')
    const target = path.join(functionsDir, '_middleware.ts')

    await mkdir(functionsDir, { recursive: true })
    await writeFile(target, content, 'utf8')

    context.logger.main.info(`OG image vendor (CloudflareMiddleware): wrote ${target}`)
  }
}
