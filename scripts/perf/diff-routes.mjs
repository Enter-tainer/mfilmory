// 对比 verify-routes.ps1 产出的 base/opt 两份结果。
//
// 判据不是拍脑袋定的 —— 先用**同一个 main 基线构建**把每条路由跑 3 次，量出噪声底线，
// 只有基线自己 3/3 稳定的指标才拿来当硬性判据。
//
// 噪声底线在 **1440x900** 下量过（`.perf/noise1440-{1,2,3}`）。注意默认 viewport 是
// 1258x566，两者结论不同 —— 所以 viewport 必须固定并记录（verify-routes.ps1 会写
// `.viewport.txt`）。**换了 viewport 就要重新量噪声底线。**
//
//   路由            文本 3 次全同               imgCount      结论
//   gallery         ✅ 1938/1938/1938           87/86/86      文本硬判据；img 允许 ±2
//   filter-camera   ❌ 1831/1869/1831（随机）    100/100/100   文本只作提示
//   map             ❌ 聚类数字顺序每次不同      86/86/86      文本只作提示，改判 marker 数
//   deeplink        ❌ 加载进度浮层             125/126       文本只作提示，改判 id 重合度
//   manifest-page   徽标差异有意为之；369 张图会有 pending
//
// `filter-camera` 在 1258x566 下曾经 4/4 稳定，在 1440x900 下不稳定 —— 顶部那 12 张随机
// hero 拼贴的布局与可见数量随宽高变化。
//
// 用法: node scripts/perf/diff-routes.mjs <outDir>
import fs from 'node:fs'
import path from 'node:path'

const outDir = process.argv[2] ?? '.perf/routes'
const files = fs.readdirSync(outDir)

/** 文本对比在这些路由上对时序/随机性天然敏感，基线自己都不稳定 —— 只作提示 */
const TEXT_IS_UNSTABLE = new Set(['map', 'deeplink', 'filter-camera'])

/** 文本差异是**有意为之**的路由 */
const TEXT_DIFF_INTENDED = {
  'manifest-page': '本 PR 在标题旁加了一枚「runtime manifest（已裁掉 digest / ogImageUrl）」徽标',
}

/**
 * 从 opt 构建产物里的 manifest 数一下「有多少张照片带 GPS 坐标」。
 * 地图页的文案会写成「探索地图发现了 N 个拍摄位置」，N 就是这个数 —— 它不随聚类动画变，
 * 所以可以当硬判据。读不到就返回 null（调用方降级成提示）。
 */
function distGpsPhotoCount() {
  for (const distDir of (process.env.PERF_DIST_DIRS ?? 'apps/web/dist').split(',')) {
    if (!fs.existsSync(distDir)) continue
    const manifestFile = fs.readdirSync(distDir).find(f => /^photos-manifest.*\.json$/.test(f))
    if (!manifestFile) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(distDir, manifestFile), 'utf8')).data ?? []
      return data.filter(p => p.exif && p.exif.GPSLatitude !== undefined && p.exif.GPSLongitude !== undefined).length
    }
    catch {
      continue
    }
  }
  return null
}

const parseProbe = (file) => {
  const raw = fs.readFileSync(path.join(outDir, file), 'utf8').trim()
  let value = raw
  for (let i = 0; i < 3; i++) {
    if (typeof value !== 'string') break
    try { value = JSON.parse(value) } catch { break }
  }
  return typeof value === 'object' ? value : null
}

const slugs = [...new Set(files
  .filter(f => /^base--.+\.json$/.test(f))
  .map(f => f.replace(/^base--/, '').replace(/\.json$/, '')))].sort()

let hardFailures = 0
let softNotes = 0

const overlapRatio = (a, b) => {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let common = 0
  for (const x of sa) if (sb.has(x)) common++
  return common / Math.max(sa.size, sb.size)
}

for (const slug of slugs) {
  const base = parseProbe(`base--${slug}.json`)
  const opt = parseProbe(`opt--${slug}.json`)
  console.log(`\n=== ${slug} ===`)
  if (!base || !opt) {
    console.log('  ❌ 探测结果缺失或无法解析')
    hardFailures++
    continue
  }

  const hard = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '❌'} ${name}${detail ? `  → ${detail}` : ''}`)
    if (!ok) hardFailures++
  }
  const soft = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '⚠️ '} ${name}${detail ? `  → ${detail}` : ''}`)
    if (!ok) softNotes++
  }

  // ── 硬性：所有路由都查 ──
  // `/manifest` 是调试页，会一次性加载 369 张远程缩略图。实测同一份构建连跑三次，
  // 两侧都会随机出现 0 / 1 / 27 张瞬时失败（HEAD 这些 URL 都是 200，是并发被限流而不是 404）。
  // 所以这条路由的「破图 / 资源加载失败」只作提示，不当回归信号。
  const FLAKY_BULK_IMAGES = slug === 'manifest-page'
  const optErrs = opt.errorLogs ?? []
  if (FLAKY_BULK_IMAGES) {
    soft('opt 无 error（该页一次性加载 369 张远程图，两侧都会随机出现瞬时失败，只作提示）',
      optErrs.length === 0,
      optErrs.length ? `${optErrs.length} 条，例如 ${optErrs[0].text.slice(0, 120)}` : '0 条')
  }
  else {
    hard('opt 无 error / uncaught / unhandledrejection / 资源加载失败',
      optErrs.length === 0,
      optErrs.length ? optErrs.slice(0, 3).map(e => `[${e.level}] ${e.text.slice(0, 160)}`).join(' ;; ') : '0 条')
  }

  if (FLAKY_BULK_IMAGES) {
    soft('opt 无破图（同上，只作提示）', opt.imgBrokenCount === 0, `broken=${opt.imgBrokenCount}`)
  }
  else {
    hard('opt 无破图', opt.imgBrokenCount === 0, `broken=${opt.imgBrokenCount}`)
  }
  // pending 只作提示：1440x900 下网格挂载 87 张、/manifest 页 369 张，
  // 浏览器不会把视口外全部加载完；这条只反映"稳定态有没有达到"，不是回归信号。
  soft('opt 无残留 pending 图片', opt.imgPendingCount === 0, `pending=${opt.imgPendingCount}`)
  hard('manifest 全局变量形态正确',
    opt.hasManifestGlobal === true && opt.hasManifestUrlGlobal === true
    && /__MANIFEST__\s*=\s*null/.test(opt.manifestScriptText ?? ''),
    opt.manifestScriptText)
  // 网格是虚拟化 + 渐进渲染的，同一份构建自己跑两次也会有抖动：
  //   gallery        87/86/86
  //   deeplink       124/124/125（背后还有画廊网格在渲染）
  //   /map           56/125/104（聚类动画）
  const imgDelta = Math.abs(base.imgCount - opt.imgCount)
  if (slug === 'map') {
    soft('渲染图片数与基线大致一致（聚类动画中间态，同构建自身 56→125）', true,
      `${base.imgCount} → ${opt.imgCount}`)
  }
  else if (slug === 'gallery' || slug === 'filter-camera' || slug === 'deeplink') {
    hard('渲染图片数与基线一致（虚拟化抖动允许 ±2）', imgDelta <= 2, `${base.imgCount} → ${opt.imgCount}`)
  }
  else {
    hard('渲染图片数与基线一致', imgDelta === 0, `${base.imgCount} → ${opt.imgCount}`)
  }

  // ── 硬性：按路由特性 ──
  if (slug === 'map') {
    // marker 数是聚类动画的中间态，同一构建跑 3 次就 16/32/32 —— 不能当硬判据
    soft('map marker 数量大致一致（聚类动画中间态，同构建自身就有 16→32 的抖动）',
      Math.abs(base.markerCount - opt.markerCount) <= 24,
      `${base.markerCount} → ${opt.markerCount}`)
    // 真正稳定的功能信号：地图文案里的「发现了 N 个拍摄位置」，N = 带 GPS 的照片总数。
    // 只有当所有 GPS 照片都进了 markers 数组时才会出现这个数。
    const gpsCount = distGpsPhotoCount()
    if (gpsCount === null) {
      soft('map 文案里出现全部 GPS 照片数', false, '读不到 dist manifest，跳过')
    }
    else {
      hard(`map 文案里出现全部 GPS 照片数（${gpsCount}）—— 证明 GPS exif 没被裁掉`,
        opt.text.includes(String(gpsCount)), `期望包含 ${gpsCount}`)
    }
  }

  const intended = TEXT_DIFF_INTENDED[slug]
  if (TEXT_IS_UNSTABLE.has(slug)) {
    soft('渲染文本一致（该路由文本对时序天然敏感，基线 3 次跑也各不同，只作提示）',
      base.text === opt.text, firstDiff(base.text, opt.text))
  }
  else {
    hard('渲染文本逐字符一致', base.text === opt.text || Boolean(intended),
      base.text === opt.text ? `${base.textLen} 字` : (intended ?? firstDiff(base.text, opt.text)))
  }

  // ── 软性：id 集合（网格会因测量时序把同一张图渲染 0/1/2 次）──
  const ratio = overlapRatio(base.renderedIds, opt.renderedIds)
  soft('已渲染照片 id 集合高重合', ratio >= 0.9,
    `base ${base.renderedIds.length} / opt ${opt.renderedIds.length}，重合 ${(ratio * 100).toFixed(1)}%`)

  console.log(`  图片 ${base.imgCount} → ${opt.imgCount}（已加载 ${base.imgLoadedCount} → ${opt.imgLoadedCount}）`)
  console.log(`  console 捕获 base ${base.logCount} 条 / opt ${opt.logCount} 条（error 类 ${base.errorLogs?.length ?? 0} / ${optErrs.length}）`)
  console.log(`  preload-as-image ${base.preloadAsImage} → ${opt.preloadAsImage}；preconnect ${base.preconnect} → ${opt.preconnect}；eager ${base.eagerImgs} → ${opt.eagerImgs}；high ${base.highPriorityImgs} → ${opt.highPriorityImgs}；lazy ${base.lazyImgs} → ${opt.lazyImgs}`)
  console.log(`  inline style 字节 ${base.inlineStyleBytes} → ${opt.inlineStyleBytes}`)
  if (slug === 'map') console.log(`  map marker ${base.markerCount} → ${opt.markerCount}`)
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `首个差异 @${i}: base=…${JSON.stringify(a.slice(Math.max(0, i - 30), i + 50))} | opt=…${JSON.stringify(b.slice(Math.max(0, i - 30), i + 50))}`
    }
  }
  return `长度不同且前缀相同: base=${a.length} opt=${b.length}`
}

console.log(`\n${hardFailures === 0 ? '✅ 硬性判据全部通过' : `❌ ${hardFailures} 项硬性判据失败`}；软性提示 ${softNotes} 项`)
process.exit(hardFailures === 0 ? 0 : 1)
