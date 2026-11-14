// 在浏览器里跑：快速跳转滚动 N 次，每次跳转后**轮询到覆盖恢复**，记录恢复耗时。
//
// 之前试过「跳转后同步立刻采样」，结论毫无意义 —— 那一刻 DOM 还是跳转前的渲染结果，
// 所以**任何** overscanBy 取值都会测出 0% 覆盖（连默认 2 也是）。真正有意义的是
// 「跳转后要多久才重新盖住视口」，这才是用户看到的空白时长。
//
// 参数从 window.__GAP_OPTS__ 读：{ hops, step, maxWaitMs }
(function () {
  var opts = window.__GAP_OPTS__ || { hops: 9, step: 1200, maxWaitMs: 1200 }

  function findScroller() {
    var candidates = [document.scrollingElement].concat(Array.prototype.slice.call(document.querySelectorAll('div')))
    var best = document.scrollingElement
    var bestRange = 0
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      if (!el) continue
      var range = el.scrollHeight - el.clientHeight
      if (range > bestRange && el.clientHeight > 300) {
        bestRange = range
        best = el
      }
    }
    return best
  }

  var scroller = findScroller()
  var THUMB_RE = /\.afilmory\/(thumbnails|previews)\//

  function coverage() {
    var vh = window.innerHeight
    var rects = []
    var imgs = document.querySelectorAll('img')
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      var s = img.currentSrc || img.src || ''
      if (s.indexOf('data:') === 0) continue
      if (!THUMB_RE.test(s)) continue
      var r = img.getBoundingClientRect()
      if (r.height < 4) continue
      if (r.bottom <= 0 || r.top >= vh) continue
      rects.push([Math.max(0, r.top), Math.min(vh, r.bottom)])
    }
    rects.sort(function (a, b) { return a[0] - b[0] })
    var covered = 0
    var curStart = -1
    var curEnd = -1
    for (var j = 0; j < rects.length; j++) {
      var rr = rects[j]
      if (curStart < 0) { curStart = rr[0]; curEnd = rr[1]; continue }
      if (rr[0] > curEnd + 2) { covered += curEnd - curStart; curStart = rr[0]; curEnd = rr[1] }
      else if (rr[1] > curEnd) curEnd = rr[1]
    }
    if (curStart >= 0) covered += curEnd - curStart
    return { coverage: +(covered / vh).toFixed(3), imgCount: rects.length }
  }

  var samples = []
  var startState = coverage()
  samples.push({ phase: 'settled', hop: -1, scrollTop: Math.round(scroller.scrollTop), coverage: startState.coverage, imgCount: startState.imgCount, recoverMs: 0 })

  var chain = Promise.resolve()
  for (var hop = 0; hop < opts.hops; hop++) {
    (function (h) {
      chain = chain.then(function () {
        scroller.scrollTop = scroller.scrollTop + opts.step
        var t0 = performance.now()
        var atJump = coverage().coverage

        return new Promise(function (resolve) {
          var polls = 0
          function tick() {
            polls++
            var c = coverage()
            var elapsed = performance.now() - t0
            if (c.coverage >= 0.95 || elapsed >= opts.maxWaitMs) {
              samples.push({
                phase: 'jump',
                hop: h,
                scrollTop: Math.round(scroller.scrollTop),
                coverageAtJump: atJump,
                coverageAfter: c.coverage,
                imgCount: c.imgCount,
                recoverMs: Math.round(elapsed),
                polls: polls,
              })
              // 再给一帧，让下一跳从一个已渲染的稳定态出发（跟真人连续滚动不同，
              // 但这里要的是「单次跳转的恢复时间」这个可比指标）
              setTimeout(resolve, 30)
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
    })(hop)
  }

  return chain.then(function () {
    return JSON.stringify({ scrollTopEnd: Math.round(scroller.scrollTop), samples: samples })
  })
})()
