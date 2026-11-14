// 对比同一份代码在三个 overscanBy 值下的「首屏挂载了多少张缩略图 / 发了多少个图片请求」。
//
// 这是 PR #10 的核心数字。之前 PR 里写的是「2 屏 → 1 屏（−44%，省 ~330 KB）」，
// 但代码最终值是 1.5 —— 标题和数字都过期了。这里直接量出来。
//
// 用法: node scripts/perf/compare-overscan.mjs <port:label> [<port:label> ...]
//   例: node scripts/perf/compare-overscan.mjs 4811:k2 4841:k1.5 4842:k1
import { spawnSync } from 'node:child_process'

const targets = process.argv.slice(2).map((arg) => {
  const [port, label] = arg.split(':')
  return { port, label: label ?? `port${port}` }
})
if (targets.length === 0) {
  console.error('usage: node scripts/perf/compare-overscan.mjs <port:label> [...]')
  process.exit(64)
}

const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

const VIEWPORTS = [
  { name: '1440x900', w: 1440, h: 900 },
  { name: '390x844', w: 390, h: 844 },
]

const PROBE = `
(function () {
  var imgs = Array.prototype.slice.call(document.images)
  var thumbs = imgs.filter(function (i) {
    var s = i.currentSrc || i.src || ''
    return s.indexOf('data:') !== 0 && /\\.afilmory\\/(thumbnails|previews)\\//.test(s)
  })
  var unique = {}
  thumbs.forEach(function (i) { unique[(i.currentSrc || i.src)] = 1 })
  return JSON.stringify({
    mountedThumbs: thumbs.length,
    uniqueThumbUrls: Object.keys(unique).length,
    totalImgs: imgs.length,
    docHeight: document.documentElement.scrollHeight,
    innerW: innerWidth,
    innerH: innerHeight,
  })
})()
`

const results = []

for (const target of targets) {
  for (const vp of VIEWPORTS) {
    const session = `ovs-${target.port}-${vp.name}`
    const ab = (args, { stdin } = {}) => {
      const res = spawnSync(AGENT_BROWSER, ['--session', session, ...args], {
        encoding: 'utf8', input: stdin, maxBuffer: 32 * 1024 * 1024,
        shell: process.platform === 'win32',
      })
      return res.stdout ?? ''
    }

    ab(['close'])
    ab(['open', `http://127.0.0.1:${target.port}/`])
    // viewport 必须在 open 之后设（open 会重启浏览器把 viewport 重置）
    ab(['set', 'viewport', String(vp.w), String(vp.h)])
    ab(['wait', '--load', 'load', '--timeout', '20000'])
    ab(['wait', '4000'])

    const out = ab(['eval', '--stdin'], { stdin: PROBE }).trim()
    let probe = out
    for (let i = 0; i < 3; i++) { if (typeof probe !== 'string') break; try { probe = JSON.parse(probe) } catch { break } }

    // 网络层：实际发出的缩略图请求数
    ab(['network', 'requests', '--clear'])
    ab(['open', `http://127.0.0.1:${target.port}/`])
    ab(['set', 'viewport', String(vp.w), String(vp.h)])
    ab(['wait', '--load', 'load', '--timeout', '20000'])
    ab(['wait', '5000'])
    const reqJson = ab(['network', 'requests', '--json'])
    let requests = []
    try { requests = JSON.parse(reqJson)?.data?.requests ?? [] } catch { /* ignore */ }
    const thumbRequests = requests.filter(r => /\.afilmory\/(thumbnails|previews)\//.test(r.url))
    const uniqueThumbRequests = new Set(thumbRequests.map(r => r.url)).size

    ab(['close'])

    results.push({
      label: target.label,
      port: target.port,
      viewport: vp.name,
      mountedThumbs: probe?.mountedThumbs ?? null,
      uniqueThumbUrls: probe?.uniqueThumbUrls ?? null,
      thumbRequests: thumbRequests.length,
      uniqueThumbRequests,
      totalRequests: requests.length,
      docHeight: probe?.docHeight ?? null,
      innerW: probe?.innerW ?? null,
      innerH: probe?.innerH ?? null,
    })
    console.log(`${target.label.padEnd(6)} ${vp.name.padEnd(9)} 挂载 ${String(probe?.mountedThumbs ?? '?').padStart(3)} 张 · 唯一URL ${String(probe?.uniqueThumbUrls ?? '?').padStart(3)} · 缩略图请求 ${String(thumbRequests.length).padStart(3)} · 总请求 ${String(requests.length).padStart(3)}`)
  }
}

console.log('\n=== 汇总（相对第一个 target 的变化）===')
const baseline = results.filter(r => r.label === targets[0].label)
for (const vp of VIEWPORTS) {
  const base = baseline.find(r => r.viewport === vp.name)
  const group = results.filter(r => r.viewport === vp.name)
  console.log(`\n${vp.name}：`)
  for (const r of group) {
    const dThumb = base && base.thumbRequests ? ((r.thumbRequests - base.thumbRequests) / base.thumbRequests * 100) : null
    console.log(
      `  ${r.label.padEnd(6)} 缩略图请求 ${String(r.thumbRequests).padStart(3)}`
      + (dThumb === null ? '' : `  (${dThumb >= 0 ? '+' : ''}${dThumb.toFixed(1)}%)`)
      + `   挂载 ${r.mountedThumbs} 张   文档高 ${r.docHeight}px`,
    )
  }
}

console.log('\n注意：缩略图请求数受「5 秒内浏览器懒加载阈值是否触发」影响，比挂载数不稳定；')
console.log('挂载数（mountedThumbs）是确定性的，更适合作为这个 PR 的指标。')
