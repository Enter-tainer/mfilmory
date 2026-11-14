// 快速滚动时的「空白」检查（PR #10 的主要风险）。
//
// `overscanBy` 变小最直接的风险是：滚动时渲染带还没追上，视口里出现空白条。
//
// 关键在**怎么量**。第一版写成「跳转后同步立刻采样视口覆盖率」，结果三个取值
// （2 / 1.5 / 1）全都测出 0% 覆盖 —— 因为那一刻 DOM 还是跳转前的渲染结果，
// 谁都是 0。这不是回归信号，是量法错了。
//
// 正确的指标是「跳转后要多久才重新盖住视口」（用户看到的就是这段空白时长）：
// 每次跳转后用 requestAnimationFrame 轮询，记录恢复到 ≥95% 覆盖所需的毫秒数与帧数。
//
// 浏览器侧逻辑在 `scroll-gap-probe.js`（单独文件，避免在模板字符串里处理多层正则转义 ——
// 踩过：多写一层反斜杠导致静默匹配 0 张图）。
//
// 用法:
//   node scripts/perf/check-scroll-gaps.mjs <port:label> [...] [--hops=9] [--step=1200] [--rounds=3] [--maxwait=1200]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const probeSource = fs.readFileSync(path.join(scriptDir, 'scroll-gap-probe.js'), 'utf8')

const args = process.argv.slice(2)
const targets = []
const opts = { hops: 9, step: 1200, rounds: 3, maxwait: 1200 }
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.replace(/^--/, '').split('=')
    if (k in opts) opts[k] = Number(v)
    continue
  }
  const [port, label] = a.split(':')
  targets.push({ port, label: label ?? `port${port}` })
}
if (targets.length === 0) {
  console.error('usage: node scripts/perf/check-scroll-gaps.mjs <port:label> [...]')
  process.exit(64)
}

const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

const median = (arr) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

const results = []
for (const target of targets) {
  for (let round = 1; round <= opts.rounds; round++) {
    const session = `gap-${target.port}-r${round}`
    const ab = (cmdArgs) => spawnSync(AGENT_BROWSER, ['--session', session, ...cmdArgs], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
    })
    const evalJs = (code) => {
      const res = spawnSync(AGENT_BROWSER, ['--session', session, 'eval', '--stdin'],
        { encoding: 'utf8', input: code, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' })
      let v = (res.stdout ?? '').trim()
      for (let i = 0; i < 3; i++) { if (typeof v !== 'string') break; try { v = JSON.parse(v) } catch { break } }
      return v
    }

    ab(['close'])
    ab(['open', `http://127.0.0.1:${target.port}/`])
    ab(['set', 'viewport', '1440', '900'])
    ab(['wait', '--load', 'load', '--timeout', '20000'])
    ab(['wait', '5000'])

    evalJs(`window.__GAP_OPTS__ = { hops: ${opts.hops}, step: ${opts.step}, maxWaitMs: ${opts.maxwait} }; 'ok'`)
    const parsed = evalJs(probeSource)

    ab(['close'])

    const samples = parsed?.samples ?? []
    const settled = samples.find(s => s.phase === 'settled')
    const jumps = samples.filter(s => s.phase === 'jump')
    const recoveries = jumps.map(s => s.recoverMs)
    const neverRecovered = jumps.filter(s => s.coverageAfter < 0.95)

    results.push({ label: target.label, round, settled, jumps, recoveries, neverRecovered })

    console.log(
      `${target.label.padEnd(7)} round${round}  静止覆盖 ${((settled?.coverage ?? 0) * 100).toFixed(1)}%  `
      + `恢复中位数 ${median(recoveries)} ms（最大 ${Math.max(0, ...recoveries)} ms）  `
      + `超时未恢复 ${neverRecovered.length}/${jumps.length}`,
    )
  }
}

console.log('\n=== 汇总 ===')
for (const target of targets) {
  const rs = results.filter(r => r.label === target.label)
  const allRecoveries = rs.flatMap(r => r.recoveries)
  const allJumps = rs.flatMap(r => r.jumps)
  const never = rs.reduce((a, r) => a + r.neverRecovered.length, 0)
  const p95 = (() => {
    const s = [...allRecoveries].sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length * 0.95) - (s.length % 20 === 0 ? 1 : 0)] ?? s.at(-1) : null
  })()
  console.log(
    `  ${target.label.padEnd(7)} 跳转 ${allJumps.length} 次：恢复中位数 ${median(allRecoveries)} ms`
    + ` · p95 ${p95} ms · 最大 ${Math.max(0, ...allRecoveries)} ms · 超时未恢复 ${never}`,
  )
}
console.log('\n判据：中位数恢复耗时应 << 一帧 16 ms 的若干倍；若某个取值明显更慢或出现超时未恢复，')
console.log('说明该 overscanBy 会让人看见空白。')
