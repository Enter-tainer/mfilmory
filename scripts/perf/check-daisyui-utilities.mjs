// 精确检查 daisyui 四个 utilities 实际产出的类名有没有被用到：
//   radius     → .rounded-box / .rounded-field / .rounded-selector（含 -t/-b/-l/-r/-tl… 变体）
//   glass      → .glass
//   join       → .join / .join-item / .join-vertical / .join-horizontal
//   typography → .prose
// 只有当源码里出现**这些具体类名**时才算真正在用（`Array.prototype.join`、
// `--radius-lg` 这种 Tailwind 自己的变量都不算）。
import fs from 'node:fs'
import path from 'node:path'

const roots = ['apps/web/src', 'packages/ui/src', 'packages/utils/src', 'apps/web/plugins', 'apps/web/index.html']

const targets = [
  'rounded-box', 'rounded-field', 'rounded-selector',
  'rounded-t-box', 'rounded-b-box', 'rounded-l-box', 'rounded-r-box',
  'rounded-tl-box', 'rounded-tr-box', 'rounded-bl-box', 'rounded-br-box',
  'rounded-t-field', 'rounded-b-field', 'rounded-l-field', 'rounded-r-field',
  'glass',
  'join', 'join-item', 'join-vertical', 'join-horizontal',
  'prose',
]

const files = []
function walk(p) {
  if (!fs.existsSync(p)) return
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) walk(path.join(p, e))
    return
  }
  if (!/\.(tsx?|jsx?|html|css)$/.test(p) || p.endsWith('.d.ts')) return
  files.push(p)
}
for (const r of roots) walk(r)

// 只认「类名位置」的出现：className="… class …" / class="…" / `@apply …` / tw`…`
const classAttrRe = /(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{["']([^"']*)["']\})|@apply\s+([^;\n]+)|tw`([^`]*)`/g

const found = new Map()

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  classAttrRe.lastIndex = 0
  let m
  while ((m = classAttrRe.exec(text)) !== null) {
    const blob = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
    if (!blob) continue
    const tokens = blob.split(/[\s"'`{}()[\],:+?]+/).filter(Boolean)
    for (const token of tokens) {
      // 去掉响应式/状态前缀：sm:、hover:、dark: 等
      const bare = token.replace(/^(?:[a-z-]+:)+/, '')
      if (targets.includes(bare)) {
        const key = `${file}::${bare}`
        if (!found.has(key)) found.set(key, { file, token: bare, line: text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index === -1 ? text.length : m.index)).trim().slice(0, 140) })
      }
    }
  }
}

console.log(`扫描 ${files.length} 个文件，按「类名位置」精确匹配\n`)
if (found.size === 0) {
  console.log('✅ 命中 0 处 —— daisyui 的 join / glass / radius / typography 四个 utilities 都没有被使用。')
}
else {
  console.log(`⚠️ 命中 ${found.size} 处：`)
  for (const h of found.values()) console.log(`  ${h.file}: ${JSON.stringify(h.token)}  |  ${h.line}`)
}
