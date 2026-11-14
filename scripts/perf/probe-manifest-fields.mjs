// 「manifest 字段有没有被裁掉」的功能探针 —— 直接读**渲染出来的 DOM**，不看数据。
//
// 这是第一轮那组 P0 的直接防线。第一版 PR 把 manifest 拆成 index + detail、砍掉了
// `location` 和 16 个 exif 字段，结果：
//   - 列表视图的位置行整行消失（`ListView.tsx:184-187` 读 `photo.location.locationName`）
//   - Cmd-K 按地名搜不到任何照片（`CommandPalette.tsx:108,354` 读 `photo.location`）
//   - EXIF 面板缺 GPSAltitude / ExposureCompensation / ShutterSpeedValue
// 而当时的「验证」只比了网格页的 `document.body.textContent` —— 网格的 hover 卡只显示
// 标题/尺寸/大小/焦距/光圈/快门/ISO，**根本不含 location**，所以文本一致完全不能证明没坏。
//
// 这个脚本走真实交互路径（切列表视图 / 开 Cmd-K 搜索 / 开深链 viewer 的 EXIF 面板），
// 断言 DOM 里真的出现了 location 与那几个 exif 字段的值。
//
// 用法: node scripts/perf/probe-manifest-fields.mjs <port> [label]
//   例: node scripts/perf/probe-manifest-fields.mjs 4812 opt
//   例: node scripts/perf/probe-manifest-fields.mjs 4811 base

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const port = process.argv[2] ?? '4812'
const label = process.argv[3] ?? `port-${port}`
const manifestPath = process.argv[4] ?? 'apps/web/src/data/photos-manifest.json'
const origin = `http://127.0.0.1:${port}`
const session = `probe-fields-${port}`

// Windows 上 agent-browser 是 .CMD；Node 24 execFileSync 直连 .CMD 会 EINVAL，必须走 shell。
// 但 shell 会破坏含引号/中文的参数 —— 所以所有 JS 走 `eval --stdin`，其余参数都是简单 ASCII。
const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

function run(args, { stdin, allowFail = false } = {}) {
  const res = spawnSync(AGENT_BROWSER, ['--session', session, ...args], {
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (res.status !== 0 && !allowFail) {
    throw new Error(`agent-browser ${args.join(' ')} 失败 (${res.status}): ${res.stderr || res.stdout}`)
  }
  return res.stdout ?? ''
}

/** 用 --stdin 执行 JS 并解析结果（agent-browser 会把返回值 JSON 编码一次） */
function evalJs(code) {
  const out = run(['eval', '--stdin'], { stdin: code }).trim()
  if (!out) return null
  let value = out
  for (let i = 0; i < 3; i++) {
    if (typeof value !== 'string') break
    try { value = JSON.parse(value) } catch { break }
  }
  return value
}

/** 复用同一段「取纯文本」的前导代码 */
const PURE_TEXT = `
  var clone = document.body.cloneNode(true)
  Array.prototype.slice.call(clone.querySelectorAll('style,script,noscript,template')).forEach(function (n) {
    if (n.parentNode) n.parentNode.removeChild(n)
  })
  var pure = (clone.textContent || '').replace(/\\s+/g, ' ')
`

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const sample = manifest.data.find(p => p.location?.locationName && p.exif?.GPSAltitude !== undefined)
if (!sample) {
  console.error('manifest 里找不到「同时有 location.locationName 和 exif.GPSAltitude」的照片')
  process.exit(1)
}
const expected = {
  id: sample.id,
  locationName: sample.location.locationName,
  city: sample.location.city,
  cityShort: sample.location.city ? sample.location.city.split(',')[0].trim() : null,
  altitude: sample.exif.GPSAltitude,
  shutter: sample.exif.ShutterSpeedValue,
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '❌'} ${name}${detail ? `  → ${detail}` : ''}`)
}

console.log(`样本照片: ${expected.id}`)
console.log(`  期望 locationName = ${JSON.stringify(expected.locationName)}`)
console.log(`  期望 city          = ${JSON.stringify(expected.city)}`)
console.log(`  期望 GPSAltitude   = ${JSON.stringify(expected.altitude)}`)
console.log(`  期望 ShutterSpeed  = ${JSON.stringify(expected.shutter)}`)

try {
  run(['close'], { allowFail: true })

  // ── 1. 列表视图的位置行 ──────────────────────────────────────────────
  console.log('\n=== 1) 列表视图的位置行（ListView.tsx:184-187 读 photo.location.locationName）===')
  run(['open', `${origin}/`])
  run(['wait', '--load', 'load', '--timeout', '20000'], { allowFail: true })
  run(['wait', '2500'])

  const switchResult = evalJs(`
    (function () {
      var candidates = Array.prototype.slice.call(document.querySelectorAll('button, [role="tab"], [role="radio"]'))
      for (var i = 0; i < candidates.length; i++) {
        var b = candidates[i]
        if (b.offsetParent === null) continue
        var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '')
        if (/列表|list view|ListView/i.test(label)) {
          b.click()
          return JSON.stringify({ clicked: true, label: label.trim().slice(0, 60) })
        }
      }
      return JSON.stringify({ clicked: false, buttons: candidates.filter(function(b){return b.offsetParent!==null}).map(function(b){return (b.getAttribute('aria-label')||b.title||b.textContent||'').trim().slice(0,25)}).slice(0,20) })
    })()
  `)
  console.log(`  切换列表视图: ${JSON.stringify(switchResult)}`)
  run(['wait', '2000'])

  const listProbe = evalJs(`
    (function () {
      ${PURE_TEXT}
      return JSON.stringify({
        textLen: pure.length,
        hasLocationName: pure.indexOf(${JSON.stringify(expected.locationName)}) !== -1,
        hasCityShort: ${JSON.stringify(expected.cityShort)} ? pure.indexOf(${JSON.stringify(expected.cityShort)}) !== -1 : null,
        sample: pure.slice(0, 400),
      })
    })()
  `)
  check('列表视图 DOM 里出现 location.locationName', listProbe?.hasLocationName === true,
    `文本 ${listProbe?.textLen} 字`)
  if (listProbe?.hasLocationName !== true) console.log(`    实际文本: ${JSON.stringify(listProbe?.sample)}`)

  // ── 2. 深链 viewer 的 EXIF 面板 ─────────────────────────────────────
  console.log('\n=== 2) 深链 viewer 的 EXIF 面板（GPS 段落读 location + exif.GPSAltitude）===')
  run(['close'], { allowFail: true })
  run(['open', `${origin}/photos/${encodeURIComponent(expected.id)}`])
  run(['wait', '--load', 'load', '--timeout', '20000'], { allowFail: true })
  run(['wait', '4000'])

  // 面板可能默认收起，先看它是不是已经在 DOM 里；不在就找按钮点开
  const exifProbe0 = evalJs(`
    (function () {
      ${PURE_TEXT}
      return JSON.stringify({
        textLen: pure.length,
        hasLocationName: pure.indexOf(${JSON.stringify(expected.locationName)}) !== -1,
        hasAltitude: pure.indexOf(${JSON.stringify(String(expected.altitude))}) !== -1,
        hasShutter: ${JSON.stringify(expected.shutter ?? null)} ? pure.indexOf(${JSON.stringify(expected.shutter ?? '')}) !== -1 : null,
      })
    })()
  `)

  let exifProbe = exifProbe0
  if (!exifProbe0?.hasLocationName) {
    const clickResult = evalJs(`
      (function () {
        var candidates = Array.prototype.slice.call(document.querySelectorAll('button'))
        for (var i = 0; i < candidates.length; i++) {
          var b = candidates[i]
          if (b.offsetParent === null) continue
          var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '')
          if (/exif|照片信息|信息|photo info/i.test(label)) {
            b.click()
            return JSON.stringify({ clicked: true, label: label.trim().slice(0, 60) })
          }
        }
        return JSON.stringify({ clicked: false, buttons: candidates.filter(function(b){return b.offsetParent!==null}).map(function(b){return (b.getAttribute('aria-label')||b.title||b.textContent||'').trim().slice(0,25)}).slice(0,25) })
      })()
    `)
    console.log(`  点开 EXIF 面板: ${JSON.stringify(clickResult)}`)
    run(['wait', '2500'])
    exifProbe = evalJs(`
      (function () {
        ${PURE_TEXT}
        return JSON.stringify({
          textLen: pure.length,
          hasLocationName: pure.indexOf(${JSON.stringify(expected.locationName)}) !== -1,
          hasAltitude: pure.indexOf(${JSON.stringify(String(expected.altitude))}) !== -1,
          hasShutter: ${JSON.stringify(expected.shutter ?? null)} ? pure.indexOf(${JSON.stringify(expected.shutter ?? '')}) !== -1 : null,
          sample: pure.slice(0, 600),
        })
      })()
    `)
  }

  check('EXIF 面板 DOM 里出现 location.locationName', exifProbe?.hasLocationName === true,
    `文本 ${exifProbe?.textLen} 字`)
  check('EXIF 面板 DOM 里出现 exif.GPSAltitude', exifProbe?.hasAltitude === true,
    `期望 ${JSON.stringify(String(expected.altitude))}`)
  check('EXIF 面板 DOM 里出现 exif.ShutterSpeedValue', exifProbe?.hasShutter !== false,
    `期望 ${JSON.stringify(expected.shutter)}`)
  if (exifProbe?.hasLocationName !== true) console.log(`    实际文本: ${JSON.stringify(exifProbe?.sample)}`)

  // ── 3. Cmd-K 按地名搜索 ─────────────────────────────────────────────
  console.log('\n=== 3) Cmd-K 按地名搜索（CommandPalette.tsx:108,354 读 photo.location）===')
  run(['close'], { allowFail: true })
  run(['open', `${origin}/`])
  run(['wait', '--load', 'load', '--timeout', '20000'], { allowFail: true })
  run(['wait', '2500'])
  run(['press', 'Control+k'], { allowFail: true })
  run(['wait', '1500'])

  const inputInfo = evalJs(`
    (function () {
      var input = document.querySelector('input[role="combobox"], [cmdk-input], input[type="text"], input[placeholder]')
      return JSON.stringify({
        hasInput: !!input,
        placeholder: input ? (input.getAttribute('placeholder') || '') : null,
        value: input ? input.value : null,
      })
    })()
  `)
  console.log(`  命令面板: ${JSON.stringify(inputInfo)}`)

  if (inputInfo?.hasInput) {
    const term = expected.cityShort ?? expected.locationName.split(',')[0].trim()
    // 用 eval 直接设值并派发 input 事件（React 受控输入需要 native setter）
    evalJs(`
      (function () {
        var input = document.querySelector('input[role="combobox"], [cmdk-input], input[type="text"], input[placeholder]')
        if (!input) return JSON.stringify({ ok: false })
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(term)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return JSON.stringify({ ok: true, value: input.value })
      })()
    `)
    run(['wait', '2000'])
    const searchProbe = evalJs(`
      (function () {
        ${PURE_TEXT}
        return JSON.stringify({
          term: ${JSON.stringify(term)},
          textLen: pure.length,
          hasTerm: pure.indexOf(${JSON.stringify(term)}) !== -1,
          sample: pure.slice(0, 600),
        })
      })()
    `)
    check(`Cmd-K 搜地名 ${JSON.stringify(term)} 有命中`, searchProbe?.hasTerm === true,
      `结果文本 ${searchProbe?.textLen} 字`)
    if (searchProbe?.hasTerm !== true) console.log(`    实际文本: ${JSON.stringify(searchProbe?.sample)}`)
  }
  else {
    check('Cmd-K 能打开并有输入框', false, '没找到输入框（快捷键或 DOM 结构变了）')
  }
}
finally {
  run(['close'], { allowFail: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length}/${results.length} 项失败`}（${label}）`)
process.exit(failed.length === 0 ? 0 : 1)
