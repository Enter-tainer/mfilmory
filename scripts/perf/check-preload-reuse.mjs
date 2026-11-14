// 核对「HTML 里 preload 的那几张缩略图，在每条路由上到底有没有被真正用到」。
//
// PR 声称「首屏请求数不变（preload 的 4 张被 <img> 复用）」。这句话只在 `/` 上成立：
// `/?cameras=…` 顶部是 12 张随机 hero 拼贴、`/map` 是地图，两处的首屏图片都不是
// 「默认排序前 4 张」，所以那 4 个 `fetchpriority=high` 的 preload 变成了纯浪费，
// 而且会和真正的首屏图抢带宽。这个脚本把每条路由的实际浪费量出来。
//
// 用法: node scripts/perf/check-preload-reuse.mjs <optPort> [extraRoute...]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const port = process.argv[2] ?? '4812'
const origin = `http://127.0.0.1:${port}`
const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

const routes = [
  { slug: 'gallery', path: '/' },
  { slug: 'filter-camera', path: '/?cameras=SONY%20ILCE-7RM5' },
  { slug: 'map', path: '/map' },
  { slug: 'deeplink', path: '/photos/20261104-LKXG5370' },
]

// 从 dist/index.html 里取出 preload 的图片 URL
const distDir = process.env.PERF_DIST_DIR ?? 'apps/web/dist'
const html = fs.readFileSync(`${distDir}/index.html`, 'utf8')
const preloadedUrls = [...html.matchAll(/<link\b[^>]*>/g)]
  .map(m => m[0])
  .filter(tag => /\brel="preload"/.test(tag) && /\bas="image"/.test(tag))
  .map(tag => (tag.match(/\bhref="([^"]+)"/) ?? [])[1])
  .filter(Boolean)

console.log(`dist: ${distDir}`)
console.log(`HTML 里 preload 的图片 ${preloadedUrls.length} 张：`)
for (const url of preloadedUrls) console.log(`  ${url}`)
console.log('')

const basename = (url) => {
  const s = url.split('?')[0].split('#')[0]
  const decoded = (() => { try { return decodeURIComponent(s) } catch { return s } })()
  const m = decoded.match(/\/([^/]+?)(\.[a-z0-9]+)?$/)
  return m ? m[1] : null
}
const preloadedNames = preloadedUrls.map(basename).filter(Boolean)

const summary = []

for (const route of routes) {
  const session = `preload-reuse-${port}-${route.slug}`
  const ab = (args, { stdin } = {}) => {
    const res = spawnSync(AGENT_BROWSER, ['--session', session, ...args], {
      encoding: 'utf8', input: stdin, maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
    return res.stdout ?? ''
  }
  const evalJs = (code) => {
    const out = ab(['eval', '--stdin'], { stdin: code }).trim()
    let v = out
    for (let i = 0; i < 3; i++) { if (typeof v !== 'string') break; try { v = JSON.parse(v) } catch { break } }
    return v
  }

  ab(['close'])
  ab(['open', `${origin}${route.path}`])
  ab(['wait', '--load', 'load', '--timeout', '20000'])
  ab(['wait', '3500'])

  // 页面上真实渲染出来的图片文件名
  const rendered = evalJs(`
    (function () {
      var names = []
      Array.prototype.slice.call(document.images).forEach(function (i) {
        var s = i.currentSrc || i.src || ''
        if (!s || s.indexOf('data:') === 0) return
        s = s.split('?')[0].split('#')[0]
        try { s = decodeURIComponent(s) } catch (e) {}
        var m = s.match(/\\/([^/]+?)(\\.[a-z0-9]+)?$/)
        if (m) names.push(m[1])
      })
      return JSON.stringify(names)
    })()
  `) ?? []
  const renderedSet = new Set(rendered)
  const usedPreloads = preloadedNames.filter(n => renderedSet.has(n))

  // 网络层：这 4 个 URL 各被请求几次、以及有多少 Stylesheet/图片请求
  ab(['network', 'requests', '--clear'])
  ab(['open', `${origin}${route.path}`])
  ab(['wait', '--load', 'load', '--timeout', '20000'])
  ab(['wait', '3500'])
  const reqJson = ab(['network', 'requests', '--json'])
  let requests = []
  try { requests = JSON.parse(reqJson)?.data?.requests ?? [] } catch { /* ignore */ }
  const countFor = (url) => requests.filter(r => r.url === url).length

  summary.push({
    slug: route.slug,
    path: route.path,
    preloaded: preloadedNames.length,
    usedPreloads: usedPreloads.length,
    wasted: preloadedNames.length - usedPreloads.length,
    requestsPerPreload: preloadedUrls.map(u => countFor(u)),
    totalRequests: requests.length,
  })

  ab(['close'])
}

console.log('=== 每条路由：preload 的 4 张里有几张真的被页面用上 ===')
for (const s of summary) {
  console.log(
    `${s.slug.padEnd(15)} 用到 ${s.usedPreloads}/${s.preloaded}   浪费 ${s.wasted} 张   `
    + `每个 preload URL 的请求次数 ${JSON.stringify(s.requestsPerPreload)}`,
  )
}
const wastedTotal = summary.filter(s => s.slug !== 'gallery').reduce((a, s) => a + s.wasted, 0)
console.log('')
console.log(`非 / 路由合计浪费 ${wastedTotal} 个高优先级图片请求（每条路由最多 ${summary[0].preloaded} 个）`)
console.log('结论：')
for (const s of summary) {
  console.log(`  ${s.slug === 'gallery' ? '✓' : '⚠️ '} ${s.slug}: ${s.wasted === 0 ? 'preload 全部复用' : `有 ${s.wasted} 张白下载`}`)
}
