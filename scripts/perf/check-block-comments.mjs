// 扫 TS/TSX/JS 文件里**块注释内部**出现 `*/` 的序列 —— 那会提前闭合注释，
// 让后面的中文说明被当成代码解析，报一堆莫名其妙的 TS1005/TS1109/TS1443。
//
// 典型踩法：在 /** ... */ 里写 glob 如 `plugins/**/*` 或 `apps/web/**/*`，
// 里面的 `*/` 就是注释结束符。本仓库就踩过一次（inline-main-css.ts），
// 而且**只有当 plugins/ 目录参与 type-check 时才会暴露**。
//
// 用法: node scripts/perf/check-block-comments.mjs [dir...]
import fs from 'node:fs'
import path from 'node:path'

const roots = process.argv.slice(2)
const defaultRoots = ['apps/web/plugins', 'apps/web/src', 'packages']
const dirs = roots.length > 0 ? roots : defaultRoots

const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const problems = []
const scanned = []

const walk = (p) => {
  if (!fs.existsSync(p)) return
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue
      walk(path.join(p, e))
    }
    return
  }
  if (!exts.has(path.extname(p))) return
  scanned.push(p)

  const lines = fs.readFileSync(p, 'utf8').split('\n')
  let inBlock = false
  lines.forEach((line, i) => {
    let from = 0
    while (from <= line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', from)
        if (close === -1) return
        // 注释在 close 处结束；如果 close 之后还有内容，继续按代码看（这里不追踪新注释，
        // 只关心「注释里被误闭合」这一种）
        inBlock = false
        const after = line.slice(close + 2)
        const reopen = after.indexOf('/*')
        if (reopen !== -1) { inBlock = true; from = close + 2 + reopen + 2; continue }
        return
      }
      const open = line.indexOf('/*', from)
      if (open === -1) return
      inBlock = true
      from = open + 2
    }
  })

  // 更直接的判据：逐行找 `/*` 起始，然后看同一「注释段」里是否出现 `*/` 之后紧跟非空白字符
  // 且该行不是以 `*/` 结尾的收尾行 —— 太绕。这里换成朴素但有效的方法：
  // 对每个 `/*` 起点，用正则懒惰匹配到最近的 `*/`，检查中间是否还含有 `*/`（说明被提前闭合）。
  const text = fs.readFileSync(p, 'utf8')
  const openerRe = /\/\*/g
  let m
  while ((m = openerRe.exec(text)) !== null) {
    const start = m.index
    // 跳过 `/**/` 这种空注释
    const end = text.indexOf('*/', start + 2)
    if (end === -1) continue
    const body = text.slice(start + 2, end)
    // 空注释或紧邻的合法注释
    if (body.trim() === '' || body.trim() === '*') continue
    // 注释体里若含有 `*` 紧跟 `/` 之外的可疑 glob，就是踩了 `*/`
    if (/\*\*\/\*/.test(body) || /[A-Za-z0-9_./-]\*\//.test(body)) {
      const line = text.slice(0, start).split('\n').length
      problems.push({ file: p, line, snippet: body.slice(-60).replaceAll('\n', ' ') })
    }
  }
}

for (const d of dirs) walk(d)

console.log(`扫描 ${scanned.length} 个文件`)
if (problems.length === 0) {
  console.log('✅ 没有发现「块注释里出现 */ 被提前闭合」的情况')
  process.exit(0)
}
console.log(`\n⚠️ ${problems.length} 处可疑：`)
for (const p of problems) console.log(`  ${p.file}:${p.line}  …${JSON.stringify(p.snippet)}`)
process.exit(1)
