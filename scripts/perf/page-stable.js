// 稳定性轮询表达式：等到「没有 pending 图片 + 文本长度连续两次不变」再快照。
// 用法: agent-browser wait --fn "$(cat scripts/perf/page-stable.js)" --timeout 20000
(function () {
  var w = window
  var text = (function () {
    var clone = document.body.cloneNode(true)
    Array.prototype.slice.call(clone.querySelectorAll('style, script, noscript, template')).forEach(function (n) {
      if (n.parentNode) { n.parentNode.removeChild(n) }
    })
    return (clone.textContent || '').replace(/\s+/g, ' ').trim()
  })()

  var pending = Array.prototype.slice.call(document.images).filter(function (i) { return !i.complete }).length
  var sig = text.length + '|' + pending + '|' + document.images.length

  if (w.__stable_sig !== sig) {
    w.__stable_sig = sig
    w.__stable_hits = 0
    return false
  }
  w.__stable_hits = (w.__stable_hits || 0) + 1
  // 连续 3 次（约 0.9 s）签名不变，且没有 pending 图片
  return w.__stable_hits >= 3 && pending === 0
})()
