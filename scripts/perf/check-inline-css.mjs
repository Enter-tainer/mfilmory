// PR #11（主 CSS 内联）的产物断言 —— **差分**版本。
//
// 之前的版本写死了「`@scope` 计数必须 ≥1」来证明 clean-css 没吃掉规则。这个判据脆弱：
// 另一个 PR 完全可能合法地把那段 CSS 从产物里去掉（例如把 DaisyUI 的 `join` utility 移出
// `include:` 白名单后 `@scope` 自然就没了），这时断言会误报成「clean-css 吃掉了规则」。
// 实测确实发生过：本 PR 与「daisyui 只保留白名单」的改动合并后 `@scope` = 0，而那不是回归。
//
// 正确做法是**差分**：用 `INLINE_MAIN_CSS=0` 再构建一份「不内联」的参照产物，然后断言
//   「内联进 HTML 的 CSS」 == 「参照产物里那份 CSS 文件的内容」
// 逐字节一致。这样无论上游 CSS 怎么变，判据都成立。
//
// 用法:
//   1) 正常构建（内联）：  pnpm --filter @afilmory/web exec vite build
//   2) 参照构建（不内联）：INLINE_MAIN_CSS=0 pnpm --filter @afilmory/web exec vite build --outDir <refDir>
//   3) node scripts/perf/check-inline-css.mjs <distDir> <refDir>
//
// 只给一个参数时退化成「结构性检查」（不含 CSS 内容比对），会明确说明这一点。
import fs from 'node:fs'
import path from 'node:path'

const distDir = process.argv[2]
const refDir = process.argv[3]
if (!distDir || !fs.existsSync(distDir)) {
  console.error('usage: node scripts/perf/check-inline-css.mjs <distDir> [refDir]')
  process.exit(64)
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')
const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])
const inlineCss = styleBlocks.join('\n')

const linkTags = [...html.matchAll(/<link\b[^>]*>/g)].map(m => m[0])
const stylesheetLinks = linkTags.filter(t => /\brel\s*=\s*"stylesheet"/.test(t))

const assetsDir = path.join(distDir, 'assets')
const remainingCss = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'))
  : []

const jsFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) jsFiles.push(full)
  }
}
walk(distDir)

const problems = []
const notes = []

console.log(`dist: ${distDir}`)
console.log(`HTML 字节: ${Buffer.byteLength(html)}`)
console.log(`<style> 段数: ${styleBlocks.length}，内联 CSS 总字节: ${inlineCss.length}`)
console.log(`剩余 <link rel=stylesheet>: ${stylesheetLinks.length} ${JSON.stringify(stylesheetLinks)}`)
console.log(`assets/ 里剩余的 CSS: ${JSON.stringify(remainingCss)}`)

// 1) 主 CSS 不该还躺在 assets/ 里
const mainCssLeft = remainingCss.filter(f => /^index[.-]?[A-Za-z0-9_-]*\.css$/.test(f))
if (mainCssLeft.length > 0) {
  problems.push(`主 CSS 仍留在 assets/ 里：${mainCssLeft.join(', ')}（内联没生效，或者只是复制了一份）`)
}
// 2) HTML 里不该还有指向主 CSS 的 <link>
for (const link of stylesheetLinks) {
  if (/assets\/(index|main)[.-]/.test(link)) {
    problems.push(`HTML 里还有指向主 CSS 的 <link>：${link}`)
  }
}
// 3) 任何 JS/资源都不该引用已经不存在的 CSS 文件
for (const jsFile of jsFiles) {
  const code = fs.readFileSync(jsFile, 'utf8')
  const hits = [...code.matchAll(/["']([^"']*assets\/[^"']*\.css)["']/g)].map(m => m[1])
  for (const hit of hits) {
    const base = path.basename(hit)
    if (!remainingCss.includes(base)) {
      problems.push(`${path.relative(distDir, jsFile)} 引用了不存在的 CSS：${hit}（运行时请求会 404 → __vitePreload reject）`)
    }
  }
}

// 4) 差分：内联的 CSS 必须与「不内联」参照产物里的那份逐字节一致
if (!refDir) {
  notes.push('没给参照产物目录，跳过「内联 CSS 内容 == Vite 原本要发的那份 CSS」的差分断言。'
    + ' 用 INLINE_MAIN_CSS=0 再构建一份产物并作为第二个参数传入即可启用。')
}
else if (!fs.existsSync(refDir)) {
  problems.push(`参照产物目录不存在：${refDir}`)
}
else {
  const refHtml = fs.readFileSync(path.join(refDir, 'index.html'), 'utf8')
  const refCssHref = [...refHtml.matchAll(/<link\b[^>]*>/g)]
    .map(m => m[0])
    .filter(t => /\brel\s*=\s*"stylesheet"/.test(t))
    .map(t => (t.match(/\bhref\s*=\s*"([^"]+)"/) ?? [])[1])
    .filter(Boolean)
    .map(h => h.replace(/^.*\/(?=assets\/)/, '').replace(/^\//, ''))
    .find(h => /^assets\/index.*\.css$/.test(h))

  if (!refCssHref) {
    problems.push('参照产物的 index.html 里找不到主 CSS 的 <link>（INLINE_MAIN_CSS=0 没生效？）')
  }
  else {
    const refCssPath = path.join(refDir, refCssHref)
    if (!fs.existsSync(refCssPath)) {
      problems.push(`参照产物里缺 ${refCssHref}`)
    }
    else {
      const refCss = fs.readFileSync(refCssPath, 'utf8')
      // 内联进去的是完整的 refCss；把它从 inlineCss 里定位出来做逐字节比对
      const idx = inlineCss.indexOf(refCss)
      if (idx === -1) {
        // 允许只用「长度相同 + 首尾相同」来定位差在哪
        const sameLen = inlineCss.length === refCss.length
        problems.push(
          `内联 CSS 与参照 CSS 不一致：参照 ${refCss.length} B，内联总 ${inlineCss.length} B`
          + (sameLen ? '（长度相同但内容不同）' : `（差 ${inlineCss.length - refCss.length} B）`)
          + ' —— 通常意味着 html-minifier/clean-css 又对内联内容做了二次处理（minifyCSS 应为 false）',
        )
        const n = Math.min(inlineCss.length, refCss.length)
        let at = -1
        for (let i = 0; i < n; i++) { if (inlineCss[i] !== refCss[i]) { at = i; break } }
        if (at >= 0) {
          problems.push(`  首个差异 @${at}: inline=${JSON.stringify(inlineCss.slice(at, at + 60))} ref=${JSON.stringify(refCss.slice(at, at + 60))}`)
        }
      }
      else {
        console.log(`✅ 内联 CSS 与参照 CSS 逐字节一致（${refCss.length} B，偏移 ${idx}）`)
      }
    }
  }
}

console.log('')
for (const n of notes) console.log('ℹ️  ' + n)
if (problems.length === 0) {
  console.log('✅ 通过：主 CSS 已内联、无残留引用' + (refDir ? '、内容与参照产物逐字节一致' : ''))
  process.exit(0)
}
console.log(`❌ ${problems.length} 个问题：`)
for (const p of problems) console.log('  - ' + p)
process.exit(1)
