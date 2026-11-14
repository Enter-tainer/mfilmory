// 关键路径字节账，**兼容 CSS 内联与外链两种形态**。
//
// critical-bytes.mjs 只统计 `rel=stylesheet` 的外链 CSS；一旦某个 PR 把 CSS 内联进 HTML，
// 那份字节就被算进 html 里、而且不再有 stylesheet link —— 于是「合并 5 个 PR 之后到底
// 省了多少」用那个脚本会算错（内联的 232 KB 会看起来凭空出现）。
//
// 这个脚本把两种形态都算对：
//   - 外链 CSS：读 dist 里那份文件
//   - 内联 CSS：从 HTML 的所有 `<style>` 块里取出来单独统计（同时 html 的 br 也含它）
//
// 用法: node scripts/perf/bytes-accounting.mjs <distDir> [label]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const br = (buf) => zlib.brotliCompressSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).length,
  },
}).length

function measure(distDir, label) {
  const htmlPath = path.join(distDir, 'index.html')
  const html = fs.readFileSync(htmlPath)
  const h = html.toString('utf8')

  const tags = [...h.matchAll(/<link\b[^>]*>/g)].map(m => m[0])
  const cssHrefs = tags
    .filter(t => /\brel\s*=\s*"stylesheet"/.test(t))
    .map(t => (t.match(/\bhref\s*=\s*"([^"]+)"/) ?? [])[1])
    .filter(Boolean)
  const modulepreloadHrefs = tags
    .filter(t => /\brel\s*=\s*"modulepreload"/.test(t))
    .map(t => (t.match(/\bhref\s*=\s*"([^"]+)"/) ?? [])[1])
    .filter(Boolean)
  const scriptSrcs = [...h.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).filter(Boolean)

  const styles = [...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])
  const inlineCssBytes = styles.reduce((a, s) => a + Buffer.byteLength(s), 0)

  const manifestMatch = h.match(/__MANIFEST_URL__\s*=\s*\\?"([^"\\;]+)/)
  const manifestHref = manifestMatch?.[1]

  const text = h.match(/__MANIFEST_URL__\s*=\s*"([^"]+)"/)?.[1]

  const resolve = (href) => path.join(distDir, href.replace(/^\//, ''))
  const sizeOf = (href) => {
    const p = resolve(href)
    return fs.existsSync(p) ? br(fs.readFileSync(p)) : 0
  }

  const parts = {
    html: br(html),
    inlineCss: br(Buffer.from(styles.join(''))),
    externalCss: cssHrefs.reduce((a, c) => a + sizeOf(c), 0),
    js: [...modulepreloadHrefs, ...scriptSrcs].reduce((a, c) => a + sizeOf(c), 0),
    manifest: (manifestHref ?? text) ? sizeOf(manifestHref ?? text) : 0,
  }
  // 首屏关键路径总字节 = html(含内联 CSS) + 外链 CSS + 入口 JS + manifest
  const total = parts.html + parts.externalCss + parts.js + parts.manifest

  // 校验：内联与外链不应该同时存在主 CSS
  const warnings = []
  if (cssHrefs.length > 0 && inlineCssBytes > 30000) {
    warnings.push(`同时存在外链 CSS（${cssHrefs.length} 条）与大量内联 CSS（${inlineCssBytes} B）—— 检查是否重复`)
  }

  return { label, parts, total, inlineSegments: styles.length, cssHrefs, warnings, htmlBytes: html.length }
}

const distDir = process.argv[2]
const label = process.argv[3] ?? path.basename(distDir ?? '')
if (!distDir || !fs.existsSync(distDir)) {
  console.error('usage: node scripts/perf/bytes-accounting.mjs <distDir> [label]')
  process.exit(64)
}

const r = measure(distDir, label)
console.log(`\n=== ${label} ===`)
console.log(`dist: ${distDir}`)
console.log(`HTML ${r.htmlBytes} B，其中 <style> ${r.inlineSegments} 段、共 ${r.parts.inlineCss} B br`)
console.log(`外链 CSS: ${r.cssHrefs.length} 条 ${JSON.stringify(r.cssHrefs)}`)
console.log('')
console.log('component'.padEnd(16), 'br11'.padStart(10))
for (const [k, v] of Object.entries(r.parts)) console.log(k.padEnd(16), String(v).padStart(10))
console.log(''.padEnd(27, '-'))
console.log('TOTAL'.padEnd(16), String(r.total).padStart(10))
console.log('')
console.log(JSON.stringify({ label, ...r.parts, total: r.total, inlineSegments: r.inlineSegments }, null, 2))
for (const w of r.warnings) console.log('⚠️  ' + w)

// 支持一次比两个
if (process.argv[4]) {
  const other = measure(process.argv[4], process.argv[5] ?? path.basename(process.argv[4]))
  console.log(`\n=== ${other.label} ===`)
  console.log(JSON.stringify({ label: other.label, ...other.parts, total: other.total }, null, 2))
  console.log('')
  console.log('对比：')
  for (const k of Object.keys(r.parts)) {
    const d = other.parts[k] - r.parts[k]
    console.log(`  ${k.padEnd(14)} ${String(r.parts[k]).padStart(9)} → ${String(other.parts[k]).padStart(9)}  ${d >= 0 ? '+' : ''}${d}`)
  }
  const dt = other.total - r.total
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(r.total).padStart(9)} → ${String(other.total).padStart(9)}  ${dt >= 0 ? '+' : ''}${dt} (${((dt / r.total) * 100).toFixed(2)}%)`)
}
