// 页面探测表达式（agent-browser eval 用）。
// 只用 ES5 语法，避免被 shell 或旧 Chrome 咬。
//
// 三个坑：
// 1. 文本必须剔除 <style>/<script>。这个站会往 body 里注入 <style>，而两个构建的
//    CSS 本来就不同（这正是 PR 要改的东西），不剔除的话对比会被 CSS 文本污染。
// 2. 不能只靠「等 N 秒」就快照。网格/地图是渐进渲染的，两个构建到达时序不同 →
//    同一时刻挂载的元素数不同，快照差异是噪声。用 page-stable.js 轮询到稳定态再拍。
// 3. 图片文件名要 decodeURIComponent 后再比，否则同一个对象在两边会一个带 %E5%B7%B2
//    编码、一个是原文，集合比会误报。
(function () {
  var imgs = Array.prototype.slice.call(document.images)
  var stylesheets = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"]'))
  var manifests = Array.prototype.slice.call(document.querySelectorAll('#manifest'))

  var clone = document.body.cloneNode(true)
  Array.prototype.slice.call(clone.querySelectorAll('style, script, noscript, template')).forEach(function (n) {
    if (n.parentNode) { n.parentNode.removeChild(n) }
  })
  var pureText = (clone.textContent || '').replace(/\s+/g, ' ').trim()

  function basename(src) {
    var s = String(src || '')
    if (!s || s.indexOf('data:') === 0) return null
    s = s.split('?')[0].split('#')[0]
    try { s = decodeURIComponent(s) } catch (e) { /* 保持原样 */ }
    var m = s.match(/\/([^/]+?)(\.[a-z0-9]+)?$/)
    return m ? m[1] : null
  }

  var idSet = {}
  imgs.forEach(function (i) {
    var name = basename(i.currentSrc || i.src)
    if (name) idSet[name] = 1
  })
  var renderedIds = Object.keys(idSet).sort()

  var logs = (window.__abLogs || []).slice()

  return JSON.stringify({
    url: location.pathname + location.search,
    title: document.title,
    text: pureText,
    textLen: pureText.length,
    imgCount: imgs.length,
    imgLoadedCount: imgs.filter(function (i) { return i.complete && i.naturalWidth > 0 }).length,
    imgPendingCount: imgs.filter(function (i) { return !i.complete }).length,
    imgBrokenCount: imgs.filter(function (i) { return i.complete && i.naturalWidth === 0 }).length,
    renderedIds: renderedIds,
    renderedIdCount: renderedIds.length,
    eagerImgs: document.querySelectorAll('img[loading="eager"]').length,
    highPriorityImgs: document.querySelectorAll('img[fetchpriority="high"]').length,
    lazyImgs: document.querySelectorAll('img[loading="lazy"]').length,
    stylesheetLinks: stylesheets.map(function (l) { return l.getAttribute('href') }),
    inlineStyleCount: document.querySelectorAll('style').length,
    inlineStyleBytes: Array.prototype.slice.call(document.querySelectorAll('style')).reduce(
      function (a, s) { return a + (s.textContent || '').length }, 0),
    preloadAsImage: document.querySelectorAll('link[rel="preload"][as="image"]').length,
    preconnect: document.querySelectorAll('link[rel="preconnect"]').length,
    hasManifestGlobal: typeof window.__MANIFEST__ !== 'undefined',
    hasManifestUrlGlobal: typeof window.__MANIFEST_URL__ !== 'undefined',
    manifestScriptText: manifests.length ? (manifests[0].textContent || '').slice(0, 300) : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    markerCount: document.querySelectorAll('.maplibregl-marker').length,
    logs: logs,
    logCount: logs.length,
    errorLogs: logs.filter(function (l) {
      return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection' || l.level === 'resource-error'
    }),
  })
})()
