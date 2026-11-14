// 在一个「把 plugins/ 也纳入 type-check」的 tsconfig 上跑 tsc，验证 PR #11 的插件代码本身
// 能通过类型检查 —— 单独看 PR #11 时它过，是因为 apps/web/tsconfig.json 的 include 里没有
// plugins/，插件根本不参与检查。和「把 plugins/**/* 纳入 type-check」的改动一起合入时，
// 这个错误就会变成 vite build 的失败。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const webDir = process.argv[2] ?? 'apps/web'
const tsconfigPath = path.join(webDir, 'tsconfig.json')
const tmpPath = path.join(webDir, 'tsconfig.plugins-check.json')

const original = fs.readFileSync(tsconfigPath, 'utf8')
const from = '"include": ["./src/**/*", "./scripts/**/*"]'
if (!original.includes(from)) {
  console.error('没找到预期的 include 行，实际是：')
  console.error(original.match(/"include":[^\]]*\]/)?.[0] ?? '(无)')
  process.exit(1)
}
const patched = original.replace(from, '"include": ["./src/**/*", "./scripts/**/*", "./plugins/**/*"]')
fs.writeFileSync(tmpPath, patched, 'utf8')

try {
  execFileSync('npx', ['tsc', '-p', path.basename(tmpPath), '--noEmit'], {
    cwd: webDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  console.log('✅ 插件目录类型检查通过')
}
catch {
  console.error('❌ 插件目录类型检查失败')
  process.exitCode = 1
}
finally {
  fs.rmSync(tmpPath, { force: true })
}
