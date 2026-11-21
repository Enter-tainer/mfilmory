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

function replaceMetaContent(html: string, attrName: string, attrValue: string, nextContent: string): string {
  const escaped = escapeAttr(nextContent)
  const re1 = new RegExp(`(<meta\\b[^>]*\\b${attrName}="${attrValue}"[^>]*\\bcontent=")[^"]*("[^>]*>)`, 'gi')
  const re2 = new RegExp(`(<meta\\b[^>]*\\bcontent=")[^"]*("[^>]*\\b${attrName}="${attrValue}"[^>]*>)`, 'gi')
  if (re1.test(html)) {
    return html.replace(re1, (_, prefix: string, suffix: string) => `${prefix}${escaped}${suffix}`)
  }
  return html.replace(re2, (_, prefix: string, suffix: string) => `${prefix}${escaped}${suffix}`)
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

function injectRootHtml(html: string, routePath: string, appHtml: string): string {
  const next = html.replace(/<html\b[^>]*>/i, tag =>
    tag.replace(/\blang="[^"]*"/i, 'lang="zh-CN" data-ssr-lng="zh-CN"'))

  const bodyStart = next.indexOf('<body>')
  const bodyEnd = next.lastIndexOf('</body>')
  if (bodyStart === -1 || bodyEnd === -1 || bodyEnd < bodyStart) {
    throw new Error('[ssg-prerender] cannot locate <body>...</body> in index.html')
  }

  // React 19 renderToString 会把非 lazy <img> 的 floatable preload 吐在 appHtml 开头；
  // 首页与照片页已在 <head> 精确注入对应 preload，map/manifest 不该预加载图片，统一剥离。
  const cleanedAppHtml = stripLeadingImagePreloads(appHtml)
  return `${next.slice(0, bodyStart)}<body><div id="root" data-ssg-route="${escapeAttr(routePath)}">${cleanedAppHtml}</div>${next.slice(bodyEnd)}`
}

function replaceMainInlinedCssWithLink(html: string, mainCssFile: string | undefined, base: string): string {
  if (!mainCssFile) {
    return html
  }
  // 匹配 <head> 里最大的 <style>（主 Tailwind CSS），保留 Geist @font-face 的短 <style>
  let largestMatch: { start: number, end: number } | null = null
  let largestLen = 0
  for (const match of html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)) {
    const full = match[0]
    const index = match.index ?? -1
    if (index !== -1 && full.length > 10000 && full.length > largestLen) {
      largestLen = full.length
      largestMatch = { start: index, end: index + full.length }
    }
  }
  if (!largestMatch) {
    return html
  }
  return `${html.slice(0, largestMatch.start)}<link rel="stylesheet" href="${escapeAttr(`${base}${mainCssFile}`)}">${html.slice(largestMatch.end)}`
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
  let mapJs: string | undefined
  let manifestJs: string | undefined

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
      mapJs = undefined
      manifestJs = undefined

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
        else if (facade.endsWith('/pages/map/index.tsx')) {
          mapJs = item.fileName
        }
        else if (facade.endsWith('/pages/(data)/manifest.tsx')) {
          manifestJs = item.fileName
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
          renderRoute: (urlPath: string) => Promise<string>
        }

        const manifest = readManifest()
        const photos = Array.isArray(manifest.data) ? manifest.data : []
        await serverMod.initSsrContext(manifest)

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

        // 2) `/map` -> dist/map.html
        const mapAppHtml = await serverMod.renderRoute('/map')
        let mapHtml = injectRootHtml(subPageTemplate, '/map', mapAppHtml)
        if (mapJs) {
          mapHtml = injectHeadTags(
            mapHtml,
            `<link rel="modulepreload" crossorigin href="${escapeAttr(`${base}${mapJs}`)}">`,
          )
        }
        writeFileSync(path.join(outDir, 'map.html'), mapHtml, 'utf8')

        // 3) `/manifest` -> dist/manifest.html
        const manifestAppHtml = await serverMod.renderRoute('/manifest')
        let manifestHtml = injectRootHtml(subPageTemplate, '/manifest', manifestAppHtml)
        if (manifestJs) {
          manifestHtml = injectHeadTags(
            manifestHtml,
            `<link rel="modulepreload" crossorigin href="${escapeAttr(`${base}${manifestJs}`)}">`,
          )
        }
        writeFileSync(path.join(outDir, 'manifest.html'), manifestHtml, 'utf8')

        // 4) 所有单张照片 `/photos/<id>` -> dist/photos/<id>.html
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
          photoHtml = photoHtml.replace(/<title>[\s\S]*?<\/title>/i, () =>
            `<title>${escapeHtml(`${ogText.title} | ${siteConfig.name}`)}</title>`)
          photoHtml = replaceMetaContent(photoHtml, 'name', 'description', ogText.summary)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'og:title', ogText.title)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'og:description', ogText.description)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'og:url', pageUrl)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'twitter:title', ogText.title)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'twitter:description', ogText.description)
          photoHtml = replaceMetaContent(photoHtml, 'property', 'twitter:url', pageUrl)
          if (ogImageUrl) {
            photoHtml = replaceMetaContent(photoHtml, 'property', 'og:image', ogImageUrl)
            photoHtml = replaceMetaContent(photoHtml, 'property', 'twitter:image', ogImageUrl)
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

        const totalPages = 3 + photos.length
        process.stdout.write(
          `[ssg-prerender] rendered ${totalPages} routes (/, /map, /manifest, ${photos.length} /photos/*.html, ${(totalPhotoBytes / 1024 / 1024).toFixed(2)} MB raw) in ${Date.now() - startAt}ms\n`,
        )
      }
      finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  }
}
