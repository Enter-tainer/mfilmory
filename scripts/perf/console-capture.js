// 页面 init script：在**任何页面脚本之前**装好 console / 错误捕获。
//
// 为什么不用 `agent-browser console`：它的缓冲区语义不受控（实测同一个页面两次运行
// 抓到的条数不同，比如 /map 那条 `Found N photos with GPS coordinates` 在 opt 里
// 就丢了），用它判"有没有新增 error"是不可靠的。
//
// 顺带捕获 uncaught error 和 unhandledrejection —— 这两类才是"动态 import 失败 /
// preload 失败"这类问题的真实表现（它们不一定产生 console.error）。
(function () {
  var logs = []
  window.__abLogs = logs

  var levels = ['log', 'info', 'warn', 'error', 'debug']
  for (var i = 0; i < levels.length; i++) {
    (function (level) {
      var original = console[level]
      console[level] = function () {
        try {
          var parts = []
          for (var j = 0; j < arguments.length; j++) {
            var a = arguments[j]
            if (typeof a === 'string') parts.push(a)
            else if (a instanceof Error) parts.push(a.name + ': ' + a.message)
            else {
              try { parts.push(JSON.stringify(a).slice(0, 300)) }
              catch (e) { parts.push(String(a)) }
            }
          }
          logs.push({ level: level, text: parts.join(' ').slice(0, 500) })
        }
        catch (e) { /* 捕获器自身绝不抛 */ }
        return original.apply(console, arguments)
      }
    })(levels[i])
  }

  window.addEventListener('error', function (e) {
    var target = e.target
    // 资源加载失败（img/script/link）不冒泡到 window.error 的 message，单独记
    if (target && target !== window && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      logs.push({ level: 'resource-error', text: target.tagName + ' ' + (target.currentSrc || target.src || target.href || '') })
      return
    }
    logs.push({ level: 'uncaught', text: String(e.message) + ' @' + String(e.filename) + ':' + e.lineno + (e.error && e.error.stack ? '\n' + String(e.error.stack).slice(0, 600) : '') })
  }, true)

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    var text
    if (r && r.stack) text = String(r.stack)
    else if (r && r.message) text = String(r.message)
    else {
      try { text = JSON.stringify(r) } catch (err) { text = String(r) }
    }
    logs.push({ level: 'unhandledrejection', text: String(text).slice(0, 600) })
  })
})()
