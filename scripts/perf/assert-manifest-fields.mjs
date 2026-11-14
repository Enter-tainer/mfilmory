// 断言：构建产出的 manifest 只少了 `digest` 和 `ogImageUrl`，其余字段一个不少。
//
// 这是 PR #7 那组 P0（location 被砍 → ListView 位置行/Cmd-K 地点搜索静默失效；
// exif 白名单漏 GPSAltitude/ExposureCompensation/ShutterSpeedValue → EXIF 面板缺字段）
// 的直接回归防线：拿**源** manifest 和**实际下发给浏览器**的那份逐照片逐字段比。
//
// 用法: node scripts/perf/assert-manifest-fields.mjs <sourceManifest> <distDir>
import fs from 'node:fs'
import path from 'node:path'

const [, , sourcePath, distDir] = process.argv
if (!sourcePath || !distDir) {
  console.error('usage: node scripts/perf/assert-manifest-fields.mjs <sourceManifest> <distDir>')
  process.exit(64)
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const candidates = fs.readdirSync(distDir).filter(f => /^photos-manifest.*\.json$/.test(f))
if (candidates.length !== 1) {
  console.error(`期望 dist 里只有 1 份 manifest，实际 ${candidates.length}: ${candidates.join(', ')}`)
  process.exit(1)
}
const shipped = JSON.parse(fs.readFileSync(path.join(distDir, candidates[0]), 'utf8'))

const ALLOWED_MISSING = new Set(['digest', 'ogImageUrl'])

const problems = []
const stats = { photos: source.data.length, fieldsCompared: 0, exifFieldsCompared: 0 }

if (shipped.data.length !== source.data.length) {
  problems.push(`照片数量不一致: 源 ${source.data.length} vs 产出 ${shipped.data.length}`)
}

const sourceById = new Map(source.data.map(p => [String(p.id), p]))

for (const sp of source.data) {
  const id = String(sp.id)
  const sh = sourceById.has(id) ? shipped.data.find(p => String(p.id) === id) : undefined
  if (!sh) {
    problems.push(`${id}: 产出里没有这张照片`)
    continue
  }

  for (const key of Object.keys(sp)) {
    stats.fieldsCompared++
    if (ALLOWED_MISSING.has(key)) {
      if (key in sh) problems.push(`${id}: ${key} 本应被裁掉，但还在`)
      continue
    }
    if (!(key in sh)) {
      problems.push(`${id}: 字段 ${key} 丢了`)
      continue
    }
    if (JSON.stringify(sp[key]) !== JSON.stringify(sh[key])) {
      problems.push(`${id}: 字段 ${key} 内容变了`)
    }
  }

  // exif 逐子字段
  if (sp.exif && typeof sp.exif === 'object') {
    const shExif = sh.exif ?? {}
    for (const k of Object.keys(sp.exif)) {
      stats.exifFieldsCompared++
      if (!(k in shExif)) problems.push(`${id}: exif.${k} 丢了`)
      else if (JSON.stringify(sp.exif[k]) !== JSON.stringify(shExif[k])) {
        problems.push(`${id}: exif.${k} 内容变了`)
      }
    }
    for (const k of Object.keys(shExif)) {
      if (!(k in sp.exif)) problems.push(`${id}: exif.${k} 是多出来的`)
    }
  }
}

// 顶层非 data 字段（version / cameras / lenses …）一个都不能少
for (const key of Object.keys(source)) {
  if (key === 'data') continue
  if (!(key in shipped)) problems.push(`顶层字段 ${key} 丢了`)
  else if (JSON.stringify(source[key]) !== JSON.stringify(shipped[key])) problems.push(`顶层字段 ${key} 内容变了`)
}

console.log(`源 manifest : ${sourcePath}`)
console.log(`产出 manifest: ${candidates[0]}`)
console.log(`照片 ${stats.photos} 张，比较字段 ${stats.fieldsCompared} 个（其中 exif 子字段 ${stats.exifFieldsCompared} 个）`)
console.log(`允许被裁的字段: ${[...ALLOWED_MISSING].join(', ')}`)

if (problems.length === 0) {
  console.log('\n✅ 通过：除允许裁剪的字段外，所有字段逐照片逐子字段完全一致。')
  process.exit(0)
}
console.log(`\n❌ ${problems.length} 处不一致：`)
for (const p of problems.slice(0, 40)) console.log('  - ' + p)
if (problems.length > 40) console.log(`  …（还有 ${problems.length - 40} 条）`)
process.exit(1)
