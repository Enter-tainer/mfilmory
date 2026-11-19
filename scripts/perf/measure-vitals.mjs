/**
 * Web Vitals（FCP / LCP / CLS / TBT）与首屏静态壳像素一致性对照测量。
 *
 * 1. 无节流对比（1440x900 / 390x844）：本地回环直连 base vs opt，各跑 N 次（独立 session，不吃 HTTP 缓存）。
 * 2. 弱网 JS 延迟对比（默认 JS + manifest 延迟 2500 ms，HTML / 字体 / R2 缩略图不加本地延迟）：
 *    把「HTML 到手 → JS 下载执行 → React 渲染」这段延迟显式拉开，观察预渲染壳能否把 LCP 从 JS 解耦。
 * 3. 像素一致性（opt 在 1440x900 与 390x844 下）：在 JS 被延迟期间抓取 `#ssg-shell [data-ssg-photo]`
 *    的 getBoundingClientRect()，待 `#ssg-shell` 退场后抓取 `#root [data-viewer-transition-id]` 的坐标，
 *    断言每张卡片 x / y / width 误差为 0 px（height <= 1 px）。
 *
 * 用法:
 *   node scripts/perf/measure-vitals.mjs <basePort> <optPort> [runs=3] [jsDelayMs=2500]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const basePort = Number(process.argv[2] ?? 4831)
const optPort = Number(process.argv[3] ?? 4832)
const runs = Number(process.argv[4] ?? 3)
const jsDelayMs = Number(process.argv[5] ?? 2500)

const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN
  ?? (process.platform === 'win32'
    ? 'C:/Users/mgt/AppData/Local/pnpm/agent-browser.CMD'
    : 'agent-browser')

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile', w: 390, h: 844 },
]

const VITALS_INIT_CODE = `
(function () {
  window.__vitals = { fp: null, fcp: null, lcps: [], cls: 0, shifts: [], longTasks: [], tbt: 0, initW: window.innerWidth, initH: window.innerHeight };
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (e.name === 'first-paint') window.__vitals.fp = e.startTime;
        if (e.name === 'first-contentful-paint') window.__vitals.fcp = e.startTime;
      });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        var el = e.element;
        window.__vitals.lcps.push({
          startTime: e.startTime,
          renderTime: e.renderTime,
          loadTime: e.loadTime,
          size: e.size,
          tag: el ? el.tagName : null,
          url: e.url || null,
          inSsgShell: !!(el && el.closest && el.closest('#ssg-shell')),
          inRoot: !!(el && el.closest && el.closest('#root')),
          alt: el && el.getAttribute ? el.getAttribute('alt') : null
        });
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (!e.hadRecentInput) {
          window.__vitals.cls += e.value;
          window.__vitals.shifts.push({ startTime: e.startTime, value: e.value });
        }
      });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        window.__vitals.longTasks.push({ startTime: e.startTime, duration: e.duration });
        if (e.duration > 50) window.__vitals.tbt += (e.duration - 50);
      });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})();
`

const initFile = path.join(os.tmpdir(), `mfilmory-vitals-${process.pid}.js`)
fs.writeFileSync(initFile, VITALS_INIT_CODE, 'utf8')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function ab(session, args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(AGENT_BROWSER, ['--session', session, ...args], {
      shell: process.platform === 'win32',
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => resolve(out))
    child.on('close', () => resolve(out))
    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

async function evalJs(session, code) {
  const raw = (await ab(session, ['eval', '--stdin'], code)).trim()
  let v = raw
  for (let i = 0; i < 3; i++) {
    if (typeof v !== 'string') {
      break
    }
    try {
      v = JSON.parse(v)
    }
    catch {
      break
    }
  }
  return v
}

function startDelayProxy(targetPort, delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0]
      const shouldDelay = delayMs > 0
        && (/^\/assets\/[^/]+\.js$/.test(urlPath) || /\/photos-manifest\.[^/]+\.json$/.test(urlPath))

      const forward = () => {
        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              connection: 'close',
            },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
            proxyRes.pipe(res)
          },
        )
        proxyReq.on('error', (err) => {
          res.writeHead(502)
          res.end(String(err))
        })
        proxyReq.end()
      }

      if (shouldDelay) {
        setTimeout(forward, delayMs)
      }
      else {
        forward()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port })
    })
  })
}

async function runSingleMeasure({ label, url, w, h, session, captureBeforeDismiss = false }) {
  try {
    await ab(session, ['close'])
  }
  catch {}
  try {
    // 先 open about:blank 装好 init-script 并固定 viewport，再导航到目标 URL，
    // 保证首屏同步脚本 (#ssg-init) 执行时 innerWidth/innerHeight 就是目标尺寸且不吃缓存。
    await ab(session, ['--init-script', initFile, 'open', 'about:blank'])
    await ab(session, ['set', 'viewport', String(w), String(h)])

    let ssgCapture = null
    if (captureBeforeDismiss) {
      const openPromise = ab(session, ['open', url])
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        const snap = await evalJs(session, `
          (function () {
            var sh = document.getElementById('ssg-shell');
            if (!sh) return JSON.stringify({ exists: false });
            var tiles = Array.prototype.slice.call(sh.querySelectorAll('[data-ssg-photo]')).map(function (el) {
              var r = el.getBoundingClientRect();
              return { id: el.getAttribute('data-ssg-photo'), x: r.left, y: r.top, width: r.width, height: r.height };
            });
            return JSON.stringify({ exists: true, w: window.innerWidth, h: window.innerHeight, tiles: tiles });
          })()
        `)
        if (snap && snap.exists && snap.tiles && snap.tiles.length > 0) {
          ssgCapture = snap
          break
        }
        await delay(60)
      }
      await openPromise
    }
    else {
      await ab(session, ['open', url])
    }

    // 等待 React 挂载且 #ssg-shell 退场、真实远程缩略图加载完（排除 inline data: Thumbhash）
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(session, `
        (function () {
          var ssgAlive = !!document.getElementById('ssg-shell');
          var cells = document.querySelectorAll('#root [data-viewer-transition-id]').length;
          var imgs = Array.prototype.slice.call(document.querySelectorAll('#root [role="gridcell"] img'))
            .filter(function (img) { return img.src && img.src.indexOf('data:') !== 0; });
          var loaded = imgs.filter(function (img) { return img.complete && img.naturalWidth > 0; }).length;
          return JSON.stringify({ ssgAlive: ssgAlive, cells: cells, imgs: imgs.length, loaded: loaded });
        })()
      `)
      if (ready && !ready.ssgAlive && ready.cells >= 4 && ready.imgs >= 4 && ready.loaded >= 4) {
        break
      }
      await delay(150)
    }

    // 多等一小会儿确保 LCP / layout-shift 稳定
    await ab(session, ['wait', '1000'])

    const vitalsRaw = await evalJs(session, `
      (function () {
        var nav = performance.getEntriesByType('navigation')[0];
        var v = window.__vitals || {};
        var lastLcp = (v.lcps && v.lcps.length > 0) ? v.lcps[v.lcps.length - 1] : null;
        var reactRects = {};
        Array.prototype.slice.call(document.querySelectorAll('#root [data-viewer-transition-id]')).forEach(function (el) {
          var id = el.getAttribute('data-viewer-transition-id');
          var r = el.getBoundingClientRect();
          reactRects[id] = { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        return JSON.stringify({
          label: ${JSON.stringify(label)},
          viewport: { w: window.innerWidth, h: window.innerHeight },
          ttfb: nav ? nav.responseStart : null,
          domInteractive: nav ? nav.domInteractive : null,
          fp: v.fp,
          fcp: v.fcp,
          lcp: lastLcp ? lastLcp.startTime : null,
          lcpSource: lastLcp ? (lastLcp.inSsgShell ? 'ssg-shell' : (lastLcp.inRoot ? 'root' : lastLcp.tag)) : null,
          lcpCount: (v.lcps || []).length,
          lcps: v.lcps,
          cls: v.cls,
          shifts: v.shifts,
          tbt: v.tbt,
          longTaskCount: (v.longTasks || []).length,
          ssgRemaining: !!document.getElementById('ssg-shell'),
          reactTileCount: Object.keys(reactRects).length,
          reactRects: reactRects
        });
      })()
    `)

    let abVitals = null
    try {
      const avOut = (await ab(session, ['vitals', '--json'])).trim()
      if (avOut) {
        abVitals = JSON.parse(avOut)
      }
    }
    catch {}

    let parity = null
    if (ssgCapture && ssgCapture.tiles && vitalsRaw && vitalsRaw.reactRects) {
      let maxDx = 0
      let maxDy = 0
      let maxDw = 0
      let maxDh = 0
      let matched = 0
      const mismatches = []
      for (const tile of ssgCapture.tiles) {
        const rr = vitalsRaw.reactRects[tile.id]
        if (!rr) {
          continue
        }
        matched++
        const dx = Math.abs(rr.x - tile.x)
        const dy = Math.abs(rr.y - tile.y)
        const dw = Math.abs(rr.width - tile.width)
        const dh = Math.abs(rr.height - tile.height)
        if (dx > maxDx) {
          maxDx = dx
        }
        if (dy > maxDy) {
          maxDy = dy
        }
        if (dw > maxDw) {
          maxDw = dw
        }
        if (dh > maxDh) {
          maxDh = dh
        }
        if (dx > 0 || dy > 0 || dw > 0 || dh > 1) {
          mismatches.push({ id: tile.id, ssg: tile, react: rr, dx, dy, dw, dh })
        }
      }
      parity = {
        ssgCount: ssgCapture.tiles.length,
        matched,
        maxDx: Number(maxDx.toFixed(3)),
        maxDy: Number(maxDy.toFixed(3)),
        maxDw: Number(maxDw.toFixed(3)),
        maxDh: Number(maxDh.toFixed(3)),
        mismatches: mismatches.slice(0, 5),
      }
    }

    return { ...vitalsRaw, abVitals, parity }
  }
  finally {
    try {
      await ab(session, ['close'])
    }
    catch {}
  }
}

const median = (nums) => {
  const valid = nums.filter(n => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b)
  if (valid.length === 0) {
    return null
  }
  const mid = Math.floor(valid.length / 2)
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2
}

const fmt = n => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} ms`)

async function main() {
  const proxyBase = await startDelayProxy(basePort, jsDelayMs)
  const proxyOpt = await startDelayProxy(optPort, jsDelayMs)

  try {
    const scenarios = [
      { scenario: 'unthrottled', base: `http://127.0.0.1:${basePort}/`, opt: `http://127.0.0.1:${optPort}/`, delay: 0 },
      { scenario: `js-delay-${jsDelayMs}ms`, base: `http://127.0.0.1:${proxyBase.port}/`, opt: `http://127.0.0.1:${proxyOpt.port}/`, delay: jsDelayMs },
    ]

    const allResults = []

    for (const sc of scenarios) {
      for (const vp of VIEWPORTS) {
        const baseSamples = []
        const optSamples = []
        for (let i = 0; i < runs; i++) {
          baseSamples.push(await runSingleMeasure({
            label: `${sc.scenario}-${vp.name}-base-${i}`,
            url: sc.base,
            w: vp.w,
            h: vp.h,
            session: `mv-${process.pid}-${sc.scenario}-${vp.name}-b-${i}`,
          }))
          optSamples.push(await runSingleMeasure({
            label: `${sc.scenario}-${vp.name}-opt-${i}`,
            url: sc.opt,
            w: vp.w,
            h: vp.h,
            session: `mv-${process.pid}-${sc.scenario}-${vp.name}-o-${i}`,
            captureBeforeDismiss: sc.delay > 0 && i === 0,
          }))
        }

        const summarize = arr => ({
          fcp: median(arr.map(x => x.fcp)),
          lcp: median(arr.map(x => x.lcp)),
          cls: Number((median(arr.map(x => x.cls)) ?? 0).toFixed(5)),
          tbt: median(arr.map(x => x.tbt)),
          lcpSources: arr.map(x => x.lcpSource),
          rawFcps: arr.map(x => Math.round(x.fcp ?? -1)),
          rawLcps: arr.map(x => Math.round(x.lcp ?? -1)),
          rawClss: arr.map(x => Number((x.cls ?? 0).toFixed(5))),
          rawTbts: arr.map(x => Math.round(x.tbt ?? -1)),
          parity: arr.find(x => x.parity)?.parity ?? null,
          abVitalsSample: arr[0]?.abVitals ?? null,
          shiftsSample: arr.map(x => x.shifts),
        })

        const bSum = summarize(baseSamples)
        const oSum = summarize(optSamples)
        allResults.push({ scenario: sc.scenario, viewport: vp.name, base: bSum, opt: oSum })

        console.log(`\n=== ${sc.scenario} | ${vp.name} (${vp.w}x${vp.h}, ${runs} runs) ===`)
        console.log(`  FCP (median): base ${fmt(bSum.fcp)} (${JSON.stringify(bSum.rawFcps)})  →  opt ${fmt(oSum.fcp)} (${JSON.stringify(oSum.rawFcps)})`)
        console.log(`  LCP (median): base ${fmt(bSum.lcp)} (${JSON.stringify(bSum.rawLcps)}, ${JSON.stringify(bSum.lcpSources)})  →  opt ${fmt(oSum.lcp)} (${JSON.stringify(oSum.rawLcps)}, ${JSON.stringify(oSum.lcpSources)})`)
        console.log(`  CLS (median): base ${bSum.cls} (${JSON.stringify(bSum.rawClss)})  →  opt ${oSum.cls} (${JSON.stringify(oSum.rawClss)})`)
        console.log(`  TBT (median): base ${fmt(bSum.tbt)} (${JSON.stringify(bSum.rawTbts)})  →  opt ${fmt(oSum.tbt)} (${JSON.stringify(oSum.rawTbts)})`)
        if (oSum.parity) {
          console.log(`  PIXEL PARITY (#ssg-shell vs #root): ${JSON.stringify(oSum.parity)}`)
        }
      }
    }

    console.log('\n=== JSON_SUMMARY ===')
    console.log(JSON.stringify(allResults, null, 2))
  }
  finally {
    proxyBase.server.close()
    proxyOpt.server.close()
    try {
      fs.unlinkSync(initFile)
    }
    catch {}
  }
}

await main()
