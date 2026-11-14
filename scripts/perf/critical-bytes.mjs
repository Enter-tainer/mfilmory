// 首屏关键路径字节统计（brotli-11），用于 A/B。
// 用法: node scripts/perf/critical-bytes.mjs <distDir> [label]
// 只读 dist 目录，不联网、不写仓库。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dist = process.argv[2]
const label = process.argv[3] ?? path.basename(path.dirname(dist))
if (!dist || !fs.existsSync(dist)) {
  console.error('usage: node scripts/perf/critical-bytes.mjs <distDir> [label]')
  process.exit(64)
}

const br = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const out = zlib.brotliCompressSync(b, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length,
    },
  })
  return out.length
}

const read = f => fs.readFileSync(path.join(dist, f))
const html = read('index.html').toString('utf8')

// --- HTML 里引用的入口资源 ---
const htmlBytes = read('index.html')
const stylesheetHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m => m[1])
const modulePreloadHrefs = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(m => m[1])
const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1])
const manifestUrl = (html.match(/__MANIFEST_URL__="([^"]+)"/) ?? [])[1]
  ?? (html.match(/__MANIFEST_URL__=("?)([^";]+)\1/) ?? [])[2]
const preloadImageCount = [...html.matchAll(/<link[^>]+rel="preload"[^>]+as="image"/g)].length
const preconnectCount = [...html.matchAll(/<link[^>]+rel="preconnect"/g)].length
const inlineStyleBytes = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)]
  .reduce((acc, m) => acc + Buffer.byteLength(m[0]), 0)

const short = href => href.replace(/^\//, '').replace(/^assets\//, 'assets/')
const rows = []
const add = (kind, file, extra) => {
  const p = path.join(dist, file)
  if (!fs.existsSync(p)) {
    rows.push({ kind, file, raw: null, br: null, extra })
    return
  }
  const buf = fs.readFileSync(p)
  rows.push({ kind, file, raw: buf.length, br: br(buf), extra })
}

add('html', 'index.html')
for (const h of stylesheetHrefs) add('css', short(h))
for (const h of modulePreloadHrefs) add('modulepreload', short(h))
for (const h of scriptSrcs) add('entry-js', short(h))
if (manifestUrl) add('manifest', short(manifestUrl))

// 字体：HTML 里 preload 的 woff2（属性顺序不固定，所以按 rel 集合匹配整个标签）
for (const m of html.matchAll(/<link\b[^>]*>/g)) {
  const tag = m[0]
  if (!/\brel="preload"/.test(tag) || !/\bas="font"/.test(tag)) continue
  const href = (tag.match(/\bhref="([^"]+)"/) ?? [])[1]
  if (href) add('font', short(href))
}

const total = rows.reduce((acc, r) => ({ raw: acc.raw + (r.raw ?? 0), br: acc.br + (r.br ?? 0) }), { raw: 0, br: 0 })

console.log(`\n=== ${label} ===`)
console.log(`dist: ${dist}`)
console.log(`inline <style> 总字节: ${inlineStyleBytes}`)
console.log(`preload as=image: ${preloadImageCount}   preconnect: ${preconnectCount}`)
console.log('')
console.log('kind'.padEnd(15), 'file'.padEnd(44), 'raw'.padStart(9), 'br11'.padStart(8))
for (const r of rows) {
  console.log(
    r.kind.padEnd(15),
    r.file.padEnd(44),
    String(r.raw ?? 'MISSING').padStart(9),
    String(r.br ?? '-').padStart(8),
  )
}
console.log(''.padEnd(60, '-'))
console.log('TOTAL'.padEnd(15), ''.padEnd(44), String(total.raw).padStart(9), String(total.br).padStart(8))
const pct = (v) => `${v >= 0 ? '+' : ''}${(v / total.br * 100).toFixed(2)}%`
console.log('')
console.log('JSON:', JSON.stringify({
  label,
  html: rows.find(r => r.kind === 'html')?.br,
  css: rows.filter(r => r.kind === 'css').reduce((a, r) => a + (r.br ?? 0), 0),
  js: rows.filter(r => r.kind === 'entry-js' || r.kind === 'modulepreload').reduce((a, r) => a + (r.br ?? 0), 0),
  manifest: rows.find(r => r.kind === 'manifest')?.br,
  font: rows.filter(r => r.kind === 'font').reduce((a, r) => a + (r.br ?? 0), 0),
  totalBr: total.br,
  totalRaw: total.raw,
  preloadImageCount,
  preconnectCount,
}, null, 2))
