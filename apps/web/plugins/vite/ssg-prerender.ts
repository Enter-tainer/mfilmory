import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import type { PhotoManifestItem } from '@afilmory/typing'
import type { Plugin } from 'vite'
import { build as viteBuild } from 'vite'

import { buildPhotoOgText } from '../../../../packages/builder/src/plugins/og-image-storage/photo-text'
import type { SiteConfig } from '../../../../site.config'
import { MANIFEST_PATH } from './__internal__/constants'

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

interface RenderedManifest {
  data?: PhotoManifestItem[]
  cameras?: unknown[]
  lenses?: unknown[]
}

function readManifest(): RenderedManifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RenderedManifest
  }
  catch (error) {
    console.warn('[ssg-prerender] failed to read manifest, rendering with empty data:', error)
    return { data: [], cameras: [], lenses: [] }
  }
}

// 刻意不预渲染 `/map`（纯 WebGL MapLibre，零 JS 只渲染假加载骨架）与 `/manifest`（580 KB 内部调试大表，未入 sitemap）；
// 二者继续由静态主机回退到 `index.html` 在客户端渲染。新增加入 `generated-routes.ts` 的路由未在此列且未预渲染时会构建失败。
const SKIPPED_PRERENDER_ROUTES = new Set(['/map', '/manifest'])

function replaceMetaContent(
  html: string,
  attrName: string,
  attrValue: string,
  nextContent: string,
  contextLabel: string,
): { html: string, count: number } {
  const escaped = escapeAttr(nextContent)
  const re1 = new RegExp(`(<meta\\s[^>]*\\b${attrName}="${attrValue}"[^>]*\\bcontent=")[^"]*("[^>]*>)`, 'gi')
  const re2 = new RegExp(`(<meta\\s[^>]*\\bcontent=")[^"]*("[^>]*\\b${attrName}="${attrValue}"[^>]*>)`, 'gi')
  let count = 0
  let next = html.replace(re1, (_, prefix: string, suffix: string) => {
    count += 1
    return `${prefix}${escaped}${suffix}`
  })
  if (count === 0) {
    next = next.replace(re2, (_, prefix: string, suffix: string) => {
      count += 1
      return `${prefix}${escaped}${suffix}`
    })
  }
  if (count === 0) {
    throw new Error(`[ssg-prerender] expected <meta ${attrName}="${attrValue}"> not found for ${contextLabel}`)
  }
  return { html: next, count }
}

interface OutputChunkLike {
  type: 'chunk'
  fileName: string
  facadeModuleId?: string | null
  viteMetadata?: { importedCss?: Set<string> | string[] }
}

interface OutputAssetLike {
  type: 'asset'
  fileName: string
}

type BundleLike = Record<string, OutputChunkLike | OutputAssetLike>

const stripLeadingImagePreloads = (html: string) =>
  html.replace(/^(?:<link rel="preload" as="image" [^>]+>)+/i, '')

function findClosingTagEnd(html: string, fromIdx: number, tagName: string): number {
  const lower = html.toLowerCase()
  const closeIdx = lower.indexOf(`</${tagName}`, fromIdx)
  if (closeIdx === -1) {
    return html.length
  }
  const gt = html.indexOf('>', closeIdx)
  return gt === -1 ? html.length : gt + 1
}

function findRootDivSpan(html: string): { start: number, end: number } {
  const matches = Array.from(html.matchAll(/<div\s(?:[^>]*\s)?id="root"[^>]*>/gi))
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error(`[ssg-prerender] expected exactly 1 <div id="root"> in HTML, found ${matches.length}`)
  }
  const start = matches[0].index
  let pos = start + matches[0][0].length
  let depth = 1

  while (pos < html.length && depth > 0) {
    const lt = html.indexOf('<', pos)
    if (lt === -1) {
      break
    }
    const lowerSlice = html.slice(lt, lt + 10).toLowerCase()
    if (lowerSlice.startsWith('<!--')) {
      const endComment = html.indexOf('-->', lt + 4)
      pos = endComment === -1 ? html.length : endComment + 3
      continue
    }
    if (/^<script(?=[\s/>])/.test(lowerSlice)) {
      pos = findClosingTagEnd(html, lt + 7, 'script')
      continue
    }
    if (/^<style(?=[\s/>])/.test(lowerSlice)) {
      pos = findClosingTagEnd(html, lt + 6, 'style')
      continue
    }
    if (/^<div(?=[\s/>])/.test(lowerSlice)) {
      const gt = html.indexOf('>', lt + 4)
      if (gt === -1) {
        break
      }
      if (!html.slice(lt, gt + 1).endsWith('/>')) {
        depth += 1
      }
      pos = gt + 1
      continue
    }
    if (/^<\/div(?=[\s/>])/.test(lowerSlice)) {
      const gt = html.indexOf('>', lt + 5)
      if (gt === -1) {
        break
      }
      depth -= 1
      pos = gt + 1
      if (depth === 0) {
        return { start, end: pos }
      }
      continue
    }
    pos = lt + 1
  }

  throw new Error('[ssg-prerender] unbalanced <div id="root"> element in HTML')
}

function injectRootHtml(html: string, routePath: string, appHtml: string): string {
  const htmlTagMatch = html.match(/<html\b[^>]*>/i)
  if (!htmlTagMatch || htmlTagMatch.index === undefined) {
    throw new Error('[ssg-prerender] missing <html> element in index.html')
  }
  const next = html.replace(/<html\b[^>]*>/i, tag =>
    (/\blang="[^"]*"/i.test(tag)
      ? tag.replace(/\blang="[^"]*"/i, 'lang="zh-CN" data-ssr-lng="zh-CN"')
      : tag.replace(/>$/, ' lang="zh-CN" data-ssr-lng="zh-CN">')))

  const rootSpan = findRootDivSpan(next)

  // React 19 renderToString 会把非 lazy <img> 的 floatable preload 吐在 appHtml 开头；
  // 首页与照片页已在 <head> 精确注入对应 preload，统一剥离避免重复预加载。
  const cleanedAppHtml = stripLeadingImagePreloads(appHtml)
  return `${next.slice(0, rootSpan.start)}<div id="root" data-ssg-route="${escapeAttr(routePath)}">${cleanedAppHtml}</div>${next.slice(rootSpan.end)}`
}

function replaceMainInlinedCssWithLink(html: string, mainCssFile: string | undefined, base: string): string {
  if (!mainCssFile) {
    throw new Error('[ssg-prerender] missing main index CSS asset in bundle for SSG subpages')
  }
  const matches = Array.from(html.matchAll(/<style\s[^>]*data-inline-main-css[^>]*>[\s\S]*?<\/style>/gi))
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error(`[ssg-prerender] expected exactly 1 <style data-inline-main-css> tag, found ${matches.length}`)
  }
  const match = matches[0]
  return `${html.slice(0, match.index)}<link rel="stylesheet" href="${escapeAttr(`${base}${mainCssFile}`)}">${html.slice(match.index + match[0].length)}`
}

function injectHeadTags(html: string, tags: string): string {
  if (!tags) {
    return html
  }
  const headCloseIdx = html.indexOf('</head>')
  if (headCloseIdx === -1) {
    return html
  }
  return `${html.slice(0, headCloseIdx)}${tags}${html.slice(headCloseIdx)}`
}

export function ssgPrerenderPlugin(siteConfig: SiteConfig): Plugin {
  let rootDir = ''
  let outDir = ''
  let base = '/'
  let mainCss: string | undefined
  let photoJs: string | undefined
  let photoCss: string | undefined

  return {
    name: 'afilmory:ssg-prerender',
    apply: 'build',

    configResolved(config) {
      rootDir = config.root
      outDir = path.resolve(config.root, config.build.outDir)
      base = config.base.endsWith('/') ? config.base : `${config.base}/`
    },

    generateBundle(_options, bundle) {
      if (process.env.AFILMORY_SSR_BUILD === '1') {
        return
      }
      mainCss = undefined
      photoJs = undefined
      photoCss = undefined

      for (const item of Object.values(bundle as unknown as BundleLike)) {
        if (item.type === 'asset') {
          if (/^assets\/index[.-].*\.css$/.test(item.fileName)) {
            mainCss = item.fileName
          }
          continue
        }
        const facade = item.facadeModuleId?.replaceAll('\\', '/') ?? ''
        if (facade.endsWith('/pages/(main)/photos/[photoId]/index.tsx')) {
          photoJs = item.fileName
          photoCss = Array.from(item.viteMetadata?.importedCss ?? []).find(f => f.endsWith('.css'))
        }
      }
    },

    async closeBundle() {
      if (
        process.env.AFILMORY_SSR_BUILD === '1'
        || process.env.SSG_PRERENDER === '0'
        || process.env.INLINE_MAIN_CSS === '0'
      ) {
        return
      }

      const startAt = Date.now()
      const tmpDir = path.resolve(rootDir, '.ssg-tmp')
      const prevEnv = process.env.AFILMORY_SSR_BUILD
      process.env.AFILMORY_SSR_BUILD = '1'

      try {
        await viteBuild({
          root: rootDir,
          mode: 'production',
          logLevel: 'warn',
          build: {
            ssr: path.resolve(rootDir, 'src/entry-server.tsx'),
            outDir: tmpDir,
            emptyOutDir: true,
            minify: false,
            write: true,
            rolldownOptions: {
              output: {
                entryFileNames: 'entry-server.mjs',
              },
            },
          },
        })
      }
      finally {
        if (prevEnv === undefined) {
          delete process.env.AFILMORY_SSR_BUILD
        }
        else {
          process.env.AFILMORY_SSR_BUILD = prevEnv
        }
      }

      try {
        const entryUrl = pathToFileURL(path.join(tmpDir, 'entry-server.mjs')).href
        const serverMod = (await import(entryUrl)) as {
          initSsrContext: (manifest: RenderedManifest) => Promise<void>
          getDiscoveredRoutePaths: () => string[]
          renderRoute: (urlPath: string) => Promise<string>
        }

        const manifest = readManifest()
        const photos = Array.isArray(manifest.data) ? manifest.data : []
        await serverMod.initSsrContext(manifest)

        const discoveredRoutes = serverMod.getDiscoveredRoutePaths()
        const renderedPatterns = new Set(['/', '/photos/:photoId'])
        for (const route of discoveredRoutes) {
          if (!renderedPatterns.has(route) && !SKIPPED_PRERENDER_ROUTES.has(route)) {
            throw new Error(
              `[ssg-prerender] route "${route}" from generated-routes.ts is neither pre-rendered nor listed in SKIPPED_PRERENDER_ROUTES`,
            )
          }
        }
        for (const skipped of SKIPPED_PRERENDER_ROUTES) {
          if (!discoveredRoutes.includes(skipped)) {
            throw new Error(
              `[ssg-prerender] stale entry "${skipped}" in SKIPPED_PRERENDER_ROUTES (not present in generated-routes.ts)`,
            )
          }
        }

        const indexHtmlPath = path.join(outDir, 'index.html')
        const baseIndexHtml = readFileSync(indexHtmlPath, 'utf8')

        const subPageTemplate = replaceMainInlinedCssWithLink(
          baseIndexHtml.replaceAll(/<link\s[^>]*rel="preload"[^>]*as="image"[^>]*>/gi, ''),
          mainCss,
          base,
        )

        // 1) 首页 `/` -> index.html（保留内联主 CSS + 4 张首屏图 preload）
        const homeHtml = injectRootHtml(baseIndexHtml, '/', await serverMod.renderRoute('/'))
        writeFileSync(indexHtmlPath, homeHtml, 'utf8')

        // 2) 所有单张照片 `/photos/<id>` -> dist/photos/<id>.html
        const photosOutDir = path.join(outDir, 'photos')
        mkdirSync(photosOutDir, { recursive: true })

        let totalPhotoBytes = 0
        for (const photo of photos) {
          const encodedSlug = encodeURIComponent(photo.id)
          const routePath = `/photos/${encodedSlug}`
          const photoAppHtml = await serverMod.renderRoute(routePath)
          const ogText = buildPhotoOgText(photo, { siteName: siteConfig.name })
          const ogImageUrl = photo.ogImageUrl || photo.previewUrl || photo.thumbnailUrl || ''
          const previewImageUrl = photo.previewUrl || photo.thumbnailUrl || photo.originalUrl || ''
          const pageUrl = siteConfig.url ? new URL(routePath, siteConfig.url).href : routePath

          let photoHtml = injectRootHtml(subPageTemplate, routePath, photoAppHtml)
          let metaReplacements = 0

          let titleReplaced = false
          photoHtml = photoHtml.replace(/<title>[\s\S]*?<\/title>/i, () => {
            titleReplaced = true
            metaReplacements += 1
            return `<title>${escapeHtml(`${ogText.title} | ${siteConfig.name}`)}</title>`
          })
          if (!titleReplaced) {
            throw new Error(`[ssg-prerender] expected <title> not found for ${photo.id}`)
          }

          const metaUpdates: Array<[string, string, string]> = [
            ['name', 'description', ogText.summary],
            ['property', 'og:title', ogText.title],
            ['property', 'og:description', ogText.description],
            ['property', 'og:url', pageUrl],
            ['property', 'twitter:title', ogText.title],
            ['property', 'twitter:description', ogText.description],
            ['property', 'twitter:url', pageUrl],
          ]
          if (ogImageUrl) {
            metaUpdates.push(['property', 'og:image', ogImageUrl], ['property', 'twitter:image', ogImageUrl])
          }

          for (const [attrName, attrValue, content] of metaUpdates) {
            const res = replaceMetaContent(photoHtml, attrName, attrValue, content, photo.id)
            photoHtml = res.html
            metaReplacements += res.count
          }

          const expectedReplacements = 1 + metaUpdates.length
          if (metaReplacements !== expectedReplacements) {
            throw new Error(
              `[ssg-prerender] expected ${expectedReplacements} head meta replacements for ${photo.id}, got ${metaReplacements}`,
            )
          }

          const headExtras = [
            previewImageUrl
              ? `<link rel="preload" as="image" fetchpriority="high" href="${escapeAttr(previewImageUrl)}">`
              : '',
            photoCss ? `<link rel="stylesheet" href="${escapeAttr(`${base}${photoCss}`)}">` : '',
            photoJs ? `<link rel="modulepreload" crossorigin href="${escapeAttr(`${base}${photoJs}`)}">` : '',
          ].join('')
          photoHtml = injectHeadTags(photoHtml, headExtras)

          const outFile = path.join(photosOutDir, `${photo.id}.html`)
          writeFileSync(outFile, photoHtml, 'utf8')
          totalPhotoBytes += Buffer.byteLength(photoHtml, 'utf8')
        }

        const totalPages = 1 + photos.length
        process.stdout.write(
          `[ssg-prerender] rendered ${totalPages} routes (/, ${photos.length} /photos/*.html; skipped SPA-only: ${Array.from(SKIPPED_PRERENDER_ROUTES).join(', ')}; ${(totalPhotoBytes / 1024 / 1024).toFixed(2)} MB raw) in ${Date.now() - startAt}ms\n`,
        )
      }
      finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  }
}
