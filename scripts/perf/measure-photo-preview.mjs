/**
 * End-to-end Chromium verification & latency benchmark for SSG `/photos/:photoId` preview paint & hydration.
 *
 * Usage:
 *   pnpm exec tsx scripts/perf/measure-photo-preview.mjs [baseDist] [optDist]
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const runId = Date.now().toString(36)
const baseDist = path.resolve(process.argv[2] ?? 'C:/Users/mgt/Desktop/proj/mfilmory/apps/web/dist')
const optDist = path.resolve(process.argv[3] ?? 'apps/web/dist')

const optAssetsDir = path.join(optDist, 'assets')
const exiftoolAssets = existsSync(optAssetsDir)
  ? readdirSync(optAssetsDir).filter(
      f => f.endsWith('.js') && (/exiftool/i.test(f) || readFileSync(path.join(optAssetsDir, f), 'utf8').includes('zeroperl')),
    )
  : []

const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

const AGENT_BROWSER_JS = (() => {
  if (process.platform !== 'win32' || !AGENT_BROWSER.toLowerCase().endsWith('.cmd') || !existsSync(AGENT_BROWSER)) {
    return null
  }
  const cmdText = readFileSync(AGENT_BROWSER, 'utf8')
  const m = /"%~dp0\\([^"]+\.js)"/.exec(cmdText)
  if (!m) {
    return null
  }
  const resolved = path.join(path.dirname(AGENT_BROWSER), m[1])
  return existsSync(resolved) ? resolved : null
})()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
}

function getPhotoNonEntryModulePreloads(distRoot, routePath) {
  const slug = decodeURIComponent(routePath.replace(/^\/photos\//, ''))
  const photoHtmlPath = path.join(distRoot, 'photos', `${slug}.html`)
  const indexHtmlPath = path.join(distRoot, 'index.html')
  if (!existsSync(photoHtmlPath) || !existsSync(indexHtmlPath)) {
    return []
  }
  const indexHead = readFileSync(indexHtmlPath, 'utf8').split('</head>')[0] ?? ''
  const photoHead = readFileSync(photoHtmlPath, 'utf8').split('</head>')[0] ?? ''
  const indexScripts = new Set(Array.from(indexHead.matchAll(/(?:href|src)="\/([^"]+\.js)"/g), m => m[1]))
  const photoPreloads = Array.from(photoHead.matchAll(/<link\b[^>]*?\srel="modulepreload"[^>]*?\shref="\/([^"]+\.js)"/g), m => m[1])
  return photoPreloads.filter(f => !indexScripts.has(f))
}

async function startServer({ root, jsDelayMs = 0, stripModuleScripts = false }) {
  const indexHtmlBuffer = readFileSync(path.join(root, 'index.html'))

  const serveStatic = (urlPath) => {
    let filePath = path.join(root, urlPath)
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
    let send = filePath
    if (!existsSync(send) || !statSync(send).isFile()) {
      const htmlCandidate = `${filePath}.html`
      send = existsSync(htmlCandidate) && statSync(htmlCandidate).isFile()
        ? htmlCandidate
        : path.join(root, 'index.html')
    }
    const ext = path.extname(send).toLowerCase()
    const isHtmlShell = path.basename(send) === 'index.html'
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control':
        isHtmlShell
          ? 'public, max-age=0, must-revalidate'
          : /^\/(?:assets|vendor|fonts)\//.test(urlPath) || /photos-manifest\./.test(urlPath)
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
    }
    return { send, headers, isHtmlShell, ext }
  }

  const server = createServer(async (req, res) => {
    const rawUrl = req.url ?? '/'
    const urlPath = decodeURIComponent(rawUrl.split('?')[0])

    if (jsDelayMs > 0 && /^\/(?:assets|vendor)\/.*\.(?:js|mjs)$/.test(urlPath)) {
      await new Promise(resolve => setTimeout(resolve, jsDelayMs))
    }

    const { send, headers, ext } = serveStatic(urlPath)
    if (stripModuleScripts && ext === '.html') {
      const stripped = readFileSync(send, 'utf8')
        .replaceAll(/<script\b[^>]*?\stype="module"[^>]*>[\s\S]*?<\/script>/gi, '')
        .replaceAll(/<link\b[^>]*?\srel="modulepreload"[^>]*>/gi, '')
      res.writeHead(200, headers)
      res.end(stripped)
      return
    }

    res.writeHead(200, headers)
    createReadStream(send).pipe(res)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const RENDERED_BOX_HELPER = `
function getRenderedImageBox(img) {
  if (!img) return null
  var rect = img.getBoundingClientRect()
  var nw = img.naturalWidth
  var nh = img.naturalHeight
  if (!nw || !nh || !rect.width || !rect.height) return null
  var imgRatio = nw / nh
  var boxRatio = rect.width / rect.height
  var w = rect.width
  var h = rect.height
  if (boxRatio > imgRatio) {
    h = rect.height
    w = h * imgRatio
  } else {
    w = rect.width
    h = w / imgRatio
  }
  return {
    left: rect.left + (rect.width - w) / 2,
    top: rect.top + (rect.height - h) / 2,
    width: w,
    height: h,
    nw: nw,
    nh: nh
  }
}
`

const initTmpDir = mkdtempSync(path.join(tmpdir(), 'afilmory-preview-probe-'))
const consoleCaptureSrc = readFileSync(path.resolve('scripts/perf/console-capture.js'), 'utf8')
const combinedInitSource = `${consoleCaptureSrc}
${RENDERED_BOX_HELPER}
;(function () {
  window.__abPreviewProbe = true
  window.__fcpMs = null
  window.__lcpEntries = []
  window.__firstPreviewPaintMs = null
  window.__fullPreviewPaintMs = null
  window.__firstPreviewSource = null
  window.__firstPreviewSrc = null
  window.__preJsSwiperExists = null
  window.__preJsSsrBox = null
  window.__handoffHydratedBox = null
  window.__previewDisappearedAfterVisible = false

  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries()
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'first-contentful-paint') {
          window.__fcpMs = Math.round(entries[i].startTime)
        }
      }
    }).observe({ type: 'paint', buffered: true })

    new PerformanceObserver(function (list) {
      var entries = list.getEntries()
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        window.__lcpEntries.push({
          t: Math.round(e.startTime),
          url: e.url || '',
          tag: e.element ? e.element.tagName : '',
          size: e.size || 0
        })
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (_) {}

  function isStagePreviewImg(img) {
    if (!img || !img.closest('[data-photo-viewer-stage]')) return false
    var src = img.currentSrc || img.src || ''
    if (!src || src.indexOf('data:') === 0) return false
    return src.indexOf('/.afilmory/previews/') !== -1
  }

  function findVisiblePreview(minOpacity) {
    var stage = document.querySelector('[data-photo-viewer-stage]')
    if (!stage) return null
    var imgs = Array.prototype.slice.call(stage.querySelectorAll('img'))
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      if (!isStagePreviewImg(img)) continue
      if (!img.complete || img.naturalWidth <= 0) continue
      var style = window.getComputedStyle(img)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      var op = Number.parseFloat(style.opacity || '1')
      if (op <= minOpacity) continue
      var r = img.getBoundingClientRect()
      if (r.width > 50 && r.height > 50) {
        return { img: img, op: op }
      }
    }
    return null
  }

  var hasSeenVisible = false
  function tick() {
    var stage = document.querySelector('[data-photo-viewer-stage]')
    var swiper = stage ? stage.querySelector('.swiper') : null
    var canvas = stage ? stage.querySelector('canvas') : null
    var visible = findVisiblePreview(0.05)

    if (visible && window.__firstPreviewPaintMs === null) {
      window.__firstPreviewPaintMs = Math.round(performance.now())
      window.__firstPreviewSource = swiper ? 'hydrated' : 'ssr'
      window.__firstPreviewSrc = visible.img.currentSrc || visible.img.src || ''
      window.__preJsSwiperExists = Boolean(swiper)
      if (!swiper) {
        window.__preJsSsrBox = getRenderedImageBox(visible.img)
      }
      hasSeenVisible = true
    } else if (hasSeenVisible && !visible && !canvas) {
      window.__previewDisappearedAfterVisible = true
    }

    if (window.__fullPreviewPaintMs === null) {
      var fullVisible = findVisiblePreview(0.98)
      if (fullVisible) {
        window.__fullPreviewPaintMs = Math.round(performance.now())
      }
    }

    if (!window.__preJsSsrBox && !swiper && visible) {
      window.__preJsSsrBox = getRenderedImageBox(visible.img)
    }
    if (window.__handoffHydratedBox === null && swiper && visible) {
      window.__handoffHydratedBox = getRenderedImageBox(visible.img)
    }

    if (performance.now() < 20000) {
      requestAnimationFrame(tick)
    }
  }

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tick)
  }
})()
`
const combinedInitPath = path.join(initTmpDir, 'preview-init.js')
writeFileSync(combinedInitPath, combinedInitSource, 'utf8')
// Dedicated init script pinning effectiveType='4g' for the warm-hover prewarm test,
// so Chromium's adaptive NQE (~270ms local proxy RTT -> '3g') doesn't suppress mouse hover prewarm.
const fastNetInitPath = path.join(initTmpDir, 'preview-init-4g.js')
writeFileSync(
  fastNetInitPath,
  `${combinedInitSource}
;(function () {
  try {
    Object.defineProperty(Navigator.prototype, 'connection', {
      configurable: true,
      get: function () { return { effectiveType: '4g', saveData: false } }
    })
  } catch (_) {}
  try {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      get: function () { return { effectiveType: '4g', saveData: false } }
    })
  } catch (_) {}
})()
`,
  'utf8',
)

function createSession(name) {
  const ab = (args, { stdin, allowFail = false } = {}) => new Promise((resolve, reject) => {
    const cmd = AGENT_BROWSER_JS ? process.execPath : AGENT_BROWSER
    const cmdArgs = AGENT_BROWSER_JS
      ? [AGENT_BROWSER_JS, '--session', name, ...args]
      : ['--session', name, ...args]
    const child = spawn(cmd, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      if (allowFail) {
        resolve('')
      }
      else {
        reject(err)
      }
    })
    child.on('close', (status) => {
      if (status !== 0 && !allowFail) {
        reject(new Error(`agent-browser ${args.join(' ')} failed (${status}): ${stderr || stdout}`))
        return
      }
      resolve(stdout)
    })
    if (stdin !== undefined) {
      child.stdin.write(stdin)
    }
    child.stdin.end()
  })
  const evalJs = async (code) => {
    const out = (await ab(['eval', '--stdin'], { stdin: code })).trim()
    if (!out) {
      return null
    }
    let v = out
    for (let i = 0; i < 3; i++) {
      if (typeof v !== 'string') {
        break
      }
      try {
        v = JSON.parse(v)
      }
      catch {
        break
      }
    }
    return v
  }
  return { ab, evalJs }
}

const median = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const assertions = []
function assertCheck(label, ok, detail = '') {
  assertions.push({ label, ok, detail })
  console.log(`  ${ok ? '✓' : '❌'} ${label}${detail ? `  → ${detail}` : ''}`)
}

let servers = []
try {
  const baseSrv = await startServer({ root: baseDist })
  const optSrv = await startServer({ root: optDist })
  const optDelaySrv = await startServer({ root: optDist, jsDelayMs: 3500 })
  const optNoJsSrv = await startServer({ root: optDist, stripModuleScripts: true })
  servers = [baseSrv, optSrv, optDelaySrv, optNoJsSrv]

  const routeTargets = [
    { slug: 'ascii', path: '/photos/20261104-LKXG5370' },
    { slug: 'cjk-gps', path: '/photos/C0152_stabilized%E5%8D%97%E7%BA%AA%E9%97%A8_10s-motion' },
  ]
  const viewports = [
    { name: 'desktop', w: 1440, h: 900 },
    { name: 'mobile', w: 390, h: 844 },
  ]

  // ── 1) Unthrottled cold /photos/:id A/B (base main SSG vs opt rebased SSG, 3 runs median) ──
  console.log('\n=== 1) Cold /photos/:id preview paint latency & contention A/B (3 runs median) ===')
  const latencyRows = []
  const targets = [
    { label: 'base', srv: baseSrv, dist: baseDist },
    { label: 'opt', srv: optSrv, dist: optDist },
  ]
  for (const vp of viewports) {
    for (const route of routeTargets) {
      const expectedPreloads = new Set(getPhotoNonEntryModulePreloads(optDist, route.path))
      for (const target of targets) {
        const previewEndRuns = []
        const firstPaintRuns = []
        const fullPaintRuns = []
        const lcpRuns = []
        let lastSnap = null

        for (let runIdx = 0; runIdx < 3; runIdx++) {
          const sess = createSession(`${runId}-lat-${vp.name}-${route.slug}-${target.label}-${runIdx}`)
          try {
            await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
            await sess.ab(['set', 'viewport', String(vp.w), String(vp.h)])
            await sess.ab(['open', `${target.srv.origin}${route.path}`])
            await sess.ab([
              'wait',
              '--fn',
              'window.__fullPreviewPaintMs !== null && Boolean(document.querySelector("[data-photo-viewer-stage] .swiper"))',
              '--timeout',
              '25000',
            ])
            await sess.ab(['wait', '1200'])

            const snap = await sess.evalJs(`
              (() => {
                var slug = decodeURIComponent(location.pathname.split('/').pop())
                var res = performance.getEntriesByType('resource').map(function (r) {
                  return {
                    name: r.name,
                    start: Math.round(r.startTime),
                    end: Math.round(r.responseEnd)
                  }
                })
                var preview = res.find(function (r) {
                  return r.name.indexOf('/.afilmory/previews/') !== -1 && decodeURIComponent(r.name).indexOf(slug) !== -1
                })
                var pEnd = preview ? preview.end : Infinity
                var before = res.filter(function (r) { return r.start < pEnd })
                var exifAssetList = ${JSON.stringify(exiftoolAssets)}
                var cats = { thumbs: 0, otherPreviews: 0, originals: 0, maplibre: 0, exiftool: 0 }
                for (var i = 0; i < before.length; i++) {
                  var n = before[i].name
                  if (n.indexOf('/.afilmory/thumbnails/') !== -1) {
                    cats.thumbs++
                  } else if (n.indexOf('/.afilmory/previews/') !== -1 && (!preview || n !== preview.name)) {
                    cats.otherPreviews++
                  } else if (/\\.(?:jpe?g|png|webp|heic|dng)(?:[?#]|$)/i.test(n) && n.indexOf('127.0.0.1') === -1 && n.indexOf('/.afilmory/') === -1) {
                    cats.originals++
                  } else if (/maplibre|openfreemap|tiles/i.test(n)) {
                    cats.maplibre++
                  } else if (/zeroperl/i.test(n) || exifAssetList.some(function (f) { return n.indexOf(f) !== -1 })) {
                    cats.exiftool++
                  }
                }
                var previewLcp = window.__lcpEntries.filter(function (e) {
                  return e.url && e.url.indexOf('/.afilmory/previews/') !== -1
                })
                var lastLcp = window.__lcpEntries.length > 0 ? window.__lcpEntries[window.__lcpEntries.length - 1] : null
                var lcpMs = previewLcp.length > 0 ? previewLcp[previewLcp.length - 1].t : (lastLcp ? lastLcp.t : window.__fullPreviewPaintMs)
                var errs = (window.__abLogs || []).filter(function (l) {
                  return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
                })
                return JSON.stringify({
                  fcpMs: window.__fcpMs,
                  firstMs: window.__firstPreviewPaintMs,
                  fullMs: window.__fullPreviewPaintMs,
                  lcpMs: lcpMs,
                  previewEnd: preview ? preview.end : null,
                  previewStart: preview ? preview.start : null,
                  source: window.__firstPreviewSource,
                  beforeCats: cats,
                  hasBackgroundGalleryGrid: Boolean(document.querySelector('[role="grid"]')),
                  totalImgs: document.querySelectorAll('img').length,
                  resNames: res.map(function (r) { return r.name }),
                  errs: errs
                })
              })()
            `)
            previewEndRuns.push(snap.previewEnd ?? snap.fullMs)
            firstPaintRuns.push(snap.firstMs)
            fullPaintRuns.push(snap.fullMs)
            lcpRuns.push(snap.lcpMs)
            lastSnap = snap
          }
          finally {
            await sess.ab(['close'], { allowFail: true })
          }
        }

        const medPreviewEnd = median(previewEndRuns)
        const medFirst = median(firstPaintRuns)
        const medFull = median(fullPaintRuns)
        const medLcp = median(lcpRuns)
        latencyRows.push({
          viewport: vp.name,
          route: route.slug,
          build: target.label,
          previewEndMs: medPreviewEnd,
          firstMs: medFirst,
          fullMs: medFull,
          lcpMs: medLcp,
          runs: fullPaintRuns,
          source: lastSnap?.source,
        })
        console.log(
          `  ${vp.name.padEnd(7)} ${route.slug.padEnd(7)} ${target.label.padEnd(4)} `
          + `previewEnd=${medPreviewEnd}ms first=${medFirst}ms full=${medFull}ms lcp=${medLcp}ms `
          + `imgs=${lastSnap?.totalImgs} bgGrid=${lastSnap?.hasBackgroundGalleryGrid} `
          + `before=${JSON.stringify(lastSnap?.beforeCats)} src=${lastSnap?.source}`,
        )

        if (target.label === 'opt') {
          const loadedFiles = new Set(
            (lastSnap?.resNames ?? [])
              .filter(n => n.includes('/assets/'))
              .map(n => n.split('/assets/').pop().split('?')[0])
              .map(f => `assets/${f}`),
          )
          const missingPreloads = [...expectedPreloads].filter(f => !loadedFiles.has(f))
          const bc = lastSnap?.beforeCats ?? {}
          assertCheck(
            `[${vp.name} ${route.slug}] opt 0 hydration/console errors & 0 bgGallery & all modulepreloads present`,
            (lastSnap?.errs?.length ?? 1) === 0
            && lastSnap?.hasBackgroundGalleryGrid === false
            && missingPreloads.length === 0,
            `errs=${lastSnap?.errs?.length} bgGrid=${lastSnap?.hasBackgroundGalleryGrid} missing=${JSON.stringify(missingPreloads)}`,
          )
          assertCheck(
            `[${vp.name} ${route.slug}] opt 0 contention before preview finishes`,
            bc.thumbs === 0 && bc.otherPreviews === 0 && bc.originals === 0 && bc.maplibre === 0 && bc.exiftool === 0,
            JSON.stringify(bc),
          )
        }
      }
    }
  }

  // ── 2) 3500ms JS-delay SSR paint & 0px seamless hydration handoff ──
  console.log('\n=== 2) 3500ms JS-delay SSR paint & 0px seamless hydration handoff ===')
  for (const vp of viewports) {
    for (const route of routeTargets) {
      const sess = createSession(`${runId}-handoff-${vp.name}-${route.slug}`)
      try {
        await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
        await sess.ab(['set', 'viewport', String(vp.w), String(vp.h)])
        await sess.ab(['open', `${optDelaySrv.origin}${route.path}`])

        await sess.ab([
          'wait',
          '--fn',
          'window.__firstPreviewPaintMs !== null && Boolean(document.querySelector("[data-photo-viewer-stage] .swiper")) && window.__handoffHydratedBox !== null',
          '--timeout',
          '25000',
        ])

        const snap = await sess.evalJs(`
          (() => {
            var errs = (window.__abLogs || []).filter(function (l) {
              return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
            })
            return JSON.stringify({
              firstPaintMs: window.__firstPreviewPaintMs,
              firstSource: window.__firstPreviewSource,
              preJsSwiperExists: window.__preJsSwiperExists,
              disappeared: window.__previewDisappearedAfterVisible,
              ssrBox: window.__preJsSsrBox,
              hydratedBox: window.__handoffHydratedBox,
              errs: errs
            })
          })()
        `)

        assertCheck(
          `[${vp.name} ${route.slug}] SSR paints preview BEFORE JS hydrates (preJsSwiper=${snap.preJsSwiperExists})`,
          snap.firstSource === 'ssr' && snap.preJsSwiperExists === false && snap.firstPaintMs < 3500 && Boolean(snap.ssrBox),
          `firstPaint=${snap.firstPaintMs}ms box=${JSON.stringify(snap.ssrBox)}`,
        )

        const dx = Math.abs(snap.ssrBox.left - snap.hydratedBox.left)
        const dy = Math.abs(snap.ssrBox.top - snap.hydratedBox.top)
        const dw = Math.abs(snap.ssrBox.width - snap.hydratedBox.width)
        const dh = Math.abs(snap.ssrBox.height - snap.hydratedBox.height)
        const maxDelta = Math.max(dx, dy, dw, dh)

        assertCheck(
          `[${vp.name} ${route.slug}] zero disappear & handoff delta <= 1px & 0 errs`,
          !snap.disappeared && maxDelta <= 1 && snap.errs.length === 0,
          `disappeared=${snap.disappeared} maxDelta=${maxDelta.toFixed(2)}px (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}, dw=${dw.toFixed(2)}, dh=${dh.toFixed(2)}) errs=${snap.errs.length}`,
        )
      }
      finally {
        await sess.ab(['close'], { allowFail: true })
      }
    }
  }

  // ── 3) Warm gallery -> hover/click prewarm + ArrowRight adjacent switch ──
  console.log('\n=== 3) Warm gallery prewarm + ArrowRight adjacent switch ===')
  {
    const sess = createSession(`${runId}-warm-nav`)
    try {
      await sess.ab(['--init-script', fastNetInitPath, 'open', 'about:blank'])
      await sess.ab(['set', 'viewport', '1440', '900'])
      await sess.ab(['open', `${optSrv.origin}/`])
      await sess.ab([
        'wait',
        '--fn',
        'document.querySelectorAll("[data-viewer-transition-id]").length >= 10 && Array.from(document.querySelectorAll("[data-viewer-transition-id] img")).slice(0, 6).every(function (i) { return i.complete && i.naturalWidth > 0 })',
        '--timeout',
        '20000',
      ])

      const hoveredId = await sess.evalJs(`
        (() => {
          var cards = Array.prototype.slice.call(document.querySelectorAll('[data-viewer-transition-id]'))
            .map(function (el) { return { id: el.getAttribute('data-viewer-transition-id'), r: el.getBoundingClientRect() } })
            .filter(function (c) { return c.id && c.r.width > 50 && c.r.top >= 0 && c.r.bottom <= window.innerHeight })
            .sort(function (a, b) { return (a.r.top - b.r.top) || (a.r.left - b.r.left) })
          return cards[0] ? cards[0].id : null
        })()
      `)
      await sess.ab(['hover', `[data-viewer-transition-id="${hoveredId}"]`])
      await sess.ab([
        'wait',
        '--fn',
        `performance.getEntriesByType('resource').some(function (e) { return decodeURIComponent(e.name).indexOf(${JSON.stringify(`/.afilmory/previews/${hoveredId}.avif`)}) !== -1 })`,
        '--timeout',
        '20000',
      ])

      const prewarmCount = await sess.evalJs(`
        performance.getEntriesByType('resource').filter(function (e) {
          return decodeURIComponent(e.name).indexOf('/.afilmory/previews/' + ${JSON.stringify(hoveredId)} + '.avif') !== -1
        }).length
      `)
      assertCheck('Hover on gallery card prewarms previewUrl', prewarmCount >= 1, `id=${hoveredId} requests=${prewarmCount}`)

      await sess.evalJs(`document.querySelector('[data-viewer-transition-id="' + ${JSON.stringify(hoveredId)} + '"]').click()`)
      await sess.ab(['wait', '--fn', `location.pathname.indexOf('/photos/') === 0 && Boolean(document.querySelector('[data-photo-viewer-stage] img'))`, '--timeout', '15000'])
      await sess.ab(['wait', '800'])

      const urlBefore = await sess.evalJs('location.pathname')
      await sess.ab(['press', 'ArrowRight'])
      await sess.ab(['wait', '--fn', `location.pathname !== ${JSON.stringify(urlBefore)}`, '--timeout', '10000'])
      await sess.ab([
        'wait',
        '--fn',
        '(() => { var id = decodeURIComponent(location.pathname.replace(/^\\/photos\\//, "")); var imgs = Array.prototype.slice.call(document.querySelectorAll("[data-photo-viewer-stage] img")); return imgs.some(function (i) { return i.complete && i.naturalWidth > 0 && decodeURIComponent(i.currentSrc || i.src || "").indexOf(id) !== -1 }) || Boolean(document.querySelector("[data-photo-viewer-stage] .swiper-slide-active canvas")); })()',
        '--timeout',
        '15000',
      ])
      const afterArrow = await sess.evalJs(`
        (function () {
          var id = decodeURIComponent(location.pathname.replace(/^\\/photos\\//, ''))
          var imgs = Array.prototype.slice.call(document.querySelectorAll('[data-photo-viewer-stage] img'))
          var nextImgReady = imgs.some(function (i) {
            return i.complete && i.naturalWidth > 0 && decodeURIComponent(i.currentSrc || i.src || '').indexOf(id) !== -1
          })
          var nextCanvasReady = Boolean(document.querySelector('[data-photo-viewer-stage] .swiper-slide-active canvas'))
          var errs = (window.__abLogs || []).filter(function (l) {
            return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
          })
          return JSON.stringify({
            path: location.pathname,
            nextReady: nextImgReady || nextCanvasReady,
            errs: errs
          })
        })()
      `)
      assertCheck(
        'Warm open + ArrowRight switches cleanly with 0 errors',
        afterArrow.path !== urlBefore && afterArrow.nextReady && afterArrow.errs.length === 0,
        `${urlBefore} -> ${afterArrow.path} nextReady=${afterArrow.nextReady} errs=${afterArrow.errs.length}`,
      )
    }
    finally {
      await sess.ab(['close'], { allowFail: true })
    }
  }

  // ── 4) Interactive regression suite & Zero-JS check on opt ──
  console.log('\n=== 4) Interactive regressions (close->gallery, MiniMap scroll, RawEXIF, Share, ContextMenu, Mobile sheet, Zero-JS) ===')
  // 4a. Close direct-landed viewer -> gallery mounts cleanly
  {
    const sess = createSession(`${runId}-reg-close`)
    try {
      await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
      await sess.ab(['set', 'viewport', '1440', '900'])
      await sess.ab(['open', `${optSrv.origin}/photos/20261104-LKXG5370`])
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[data-photo-viewer-stage] .swiper"))', '--timeout', '20000'])
      await sess.ab(['wait', '400'])

      const hiddenBeforeClose = await sess.evalJs('document.querySelectorAll("[data-viewer-transition-id]").length')
      await sess.ab(['press', 'Escape'])
      await sess.ab(['wait', '--fn', 'location.pathname === "/" && document.querySelectorAll("[data-viewer-transition-id]").length >= 15', '--timeout', '15000'])
      const afterClose = await sess.evalJs(`
        JSON.stringify({
          path: location.pathname,
          cards: document.querySelectorAll('[data-viewer-transition-id]').length,
          errs: (window.__abLogs || []).filter(function (l) {
            return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
          }).length
        })
      `)
      assertCheck(
        'Direct /photos/:id defers hidden gallery, Esc closes and mounts gallery cleanly',
        hiddenBeforeClose === 0 && afterClose.path === '/' && afterClose.cards >= 15 && afterClose.errs === 0,
        `before=${hiddenBeforeClose} after=${afterClose.cards} errs=${afterClose.errs}`,
      )
    }
    finally {
      await sess.ab(['close'], { allowFail: true })
    }
  }

  // 4b. GPS MiniMap scroll lazy-load + Raw EXIF + Share modal（previewUrl）+ ContextMenu
  {
    const sess = createSession(`${runId}-reg-features`)
    try {
      await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
      await sess.ab(['set', 'viewport', '1440', '900'])
      await sess.ab(['open', `${optSrv.origin}/photos/C0152_stabilized%E5%8D%97%E7%BA%AA%E9%97%A8_10s-motion`])
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[data-photo-viewer-stage] canvas"))', '--timeout', '25000'])
      await sess.ab(['wait', '400'])

      const mapBeforeScroll = await sess.evalJs(`
        JSON.stringify({
          hasCanvas: Boolean(document.querySelector('.maplibregl-canvas')),
          resourceNames: performance.getEntriesByType('resource').map(function (e) { return e.name })
        })
      `)
      const maplibreBefore = mapBeforeScroll.resourceNames.filter(n => n.includes('maplibre')).length
      const exiftoolBefore = mapBeforeScroll.resourceNames.filter(
        n => n.includes('zeroperl') || exiftoolAssets.some(f => n.includes(f)),
      ).length
      assertCheck(
        'Before scroll/click: neither maplibre nor exiftool was eagerly downloaded',
        !mapBeforeScroll.hasCanvas && maplibreBefore === 0 && exiftoolBefore === 0,
        JSON.stringify({ hasCanvas: mapBeforeScroll.hasCanvas, maplibreRes: maplibreBefore, exiftoolRes: exiftoolBefore }),
      )

      await sess.evalJs(`
        (function () {
          var vps = Array.prototype.slice.call(document.querySelectorAll('[data-radix-scroll-area-viewport], .w-80 *'))
          vps.forEach(function (el) {
            if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight
          })
        })()
      `)
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector(".maplibregl-canvas"))', '--timeout', '20000'])
      assertCheck('Scrolling EXIF sidebar mounts MiniMap (.maplibregl-canvas)', true)

      await sess.evalJs(`
        (function () {
          var icon = document.querySelector('i.i-mingcute-share-2-line')
          icon.closest('button').click()
        })()
      `)
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[role=dialog]"))', '--timeout', '10000'])
      const sharePreviewSrc = await sess.evalJs(`
        (function () {
          var dialog = document.querySelector('[role=dialog]')
          var img = dialog && dialog.querySelector('img')
          return img ? (img.getAttribute('src') || '') : ''
        })()
      `)
      const sharePreviewOk
        = typeof sharePreviewSrc === 'string'
          && /\/(?:previews|thumbnails)\//.test(sharePreviewSrc)
          && !sharePreviewSrc.includes('/og/')
      assertCheck('Share modal opens & preview img uses manifest previewUrl (no /og redirect)', sharePreviewOk, `src=${String(sharePreviewSrc).slice(0, 90)}`)

      await sess.evalJs(`
        (function () {
          var dialog = document.querySelector('[role=dialog]')
          var btns = Array.prototype.slice.call(dialog.querySelectorAll('button'))
          var copyBtn = btns.find(function (b) { return b.querySelector('.i-mingcute-copy-2-line, .i-mingcute-copy-line') || /copy/i.test(b.getAttribute('aria-label') || b.title || '') })
          if (copyBtn) copyBtn.click()
        })()
      `)
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[data-sonner-toast]"))', '--timeout', '10000'])
      assertCheck('Share Copy button triggers DeferredToaster ([data-sonner-toast])', true)
      await sess.ab(['press', 'Escape'])
      await sess.ab(['wait', '--fn', '!document.querySelector("[role=dialog]")', '--timeout', '10000'])

      await sess.evalJs(`
        (function () {
          var icon = document.querySelector('i.i-mingcute-braces-line')
          icon.closest('button').click()
        })()
      `)
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[role=dialog]"))', '--timeout', '25000'])
      const rawCheck = await sess.evalJs(`
        JSON.stringify({
          dialogTextLen: (document.querySelector('[role=dialog]')?.textContent || '').length,
          errs: (window.__abLogs || []).filter(function (l) {
            return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
          })
        })
      `)
      assertCheck(
        'Raw EXIF button lazy-loads exiftool + RawExifSheet cleanly',
        rawCheck.dialogTextLen > 50 && rawCheck.errs.length === 0,
        `dialogLen=${rawCheck.dialogTextLen} errs=${rawCheck.errs.length}`,
      )
      await sess.ab(['press', 'Escape'])
      await sess.ab(['wait', '--fn', '!document.querySelector("[role=dialog]")', '--timeout', '10000'])

      await sess.evalJs(`
        (function () {
          var canvas = document.querySelector('[data-photo-viewer-stage] canvas')
          var r = canvas.getBoundingClientRect()
          canvas.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
          }))
        })()
      `)
      await sess.ab(['wait', '--fn', '/复制图像|Copy Image/i.test(document.body.innerText)', '--timeout', '10000'])
      assertCheck('Right-click on high-res WebGL stage opens ContextMenu', true)
    }
    finally {
      await sess.ab(['close'], { allowFail: true })
    }
  }

  // 4c. Mobile 390x844 inspector sheet
  {
    const sess = createSession(`${runId}-reg-mobile`)
    try {
      await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
      await sess.ab(['set', 'viewport', '390', '844'])
      await sess.ab(['open', `${optSrv.origin}/photos/20261104-LKXG5370`])
      await sess.ab(['wait', '--fn', 'Boolean(document.querySelector("[data-photo-viewer-stage] .swiper")) && Boolean(document.querySelector("i.i-mingcute-information-line"))', '--timeout', '20000'])
      await sess.ab(['wait', '300'])
      await sess.evalJs(`document.querySelector('i.i-mingcute-information-line').closest('button').click()`)
      await sess.ab([
        'wait',
        '--fn',
        '(() => { var closeBtn = document.querySelector("button[aria-label=\\"Close details\\"]"); var sheet = closeBtn && closeBtn.closest("[aria-hidden=\\"false\\"]"); return Boolean(sheet && !sheet.hasAttribute("inert") && /20261104[- ]LKXG5370/.test(sheet.textContent || "")); })()',
        '--timeout',
        '20000',
      ])
      const mobileErrs = await sess.evalJs(`(window.__abLogs || []).filter(function (l) { return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error' }).length`)
      assertCheck('Mobile 390x844 info button opens MobilePhotoInspectorSheet', mobileErrs === 0, `errs=${mobileErrs}`)
    }
    finally {
      await sess.ab(['close'], { allowFail: true })
    }
  }

  // 4d. Zero-JS SSR check
  {
    const sess = createSession(`${runId}-reg-nojs`)
    try {
      await sess.ab(['--init-script', combinedInitPath, 'open', 'about:blank'])
      await sess.ab(['set', 'viewport', '1440', '900'])
      await sess.ab(['open', `${optNoJsSrv.origin}/photos/20261104-LKXG5370`])
      await sess.ab([
        'wait',
        '--fn',
        '(() => { var img = document.querySelector("[data-photo-viewer-stage] img"); return Boolean(img && img.complete && img.naturalWidth > 0); })()',
        '--timeout',
        '15000',
      ])
      const noJsSnap = await sess.evalJs(`
        JSON.stringify({
          previewNatW: document.querySelector('[data-photo-viewer-stage] img')?.naturalWidth ?? 0,
          hasCloseLink: Boolean(document.querySelector('a[href="/"]')),
          hasExifText: /Apple iPhone 18 Pro/.test(document.body.textContent || ''),
          errs: (window.__abLogs || []).filter(function (l) {
            return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
          }).length
        })
      `)
      assertCheck(
        'Zero-JS renders preview image, EXIF metadata, and close <a href="/"> link',
        noJsSnap.previewNatW > 0 && noJsSnap.hasCloseLink && noJsSnap.hasExifText && noJsSnap.errs === 0,
        JSON.stringify(noJsSnap),
      )
    }
    finally {
      await sess.ab(['close'], { allowFail: true })
    }
  }

  console.log('\n=== SUMMARY TABLE (median previewEnd / firstPaint / fullPaint / LCP ms) ===')
  for (const r of latencyRows) {
    console.log(
      `${r.viewport.padEnd(8)} ${r.route.padEnd(8)} ${r.build.padEnd(5)} `
      + `end=${String(r.previewEndMs).padStart(5)}ms first=${String(r.firstMs).padStart(5)}ms `
      + `full=${String(r.fullMs).padStart(5)}ms lcp=${String(r.lcpMs).padStart(5)}ms `
      + `(full runs: ${r.runs.join(', ')}) [${r.source}]`,
    )
  }
  const failed = assertions.filter(a => !a.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failed.length}/${assertions.length} CHECKS FAILED`}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}
finally {
  await Promise.all(servers.map(s => s.close().catch(() => {})))
  rmSync(initTmpDir, { recursive: true, force: true })
}
