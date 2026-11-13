import type { Plugin } from 'vite'

/**
 * 把主样式表内联进 HTML。
 *
 * 首屏的 render-blocking 资源只有一条 `<link rel="stylesheet">`：浏览器必须先下完它、
 * 解析完才会 paint（哪怕 splash 是纯 inline style 的静态 HTML 也一样等）。
 * 线上实测这条 CSS 从 752 ms 开始、1636 ms 才下完，first-paint 拖到 1808 ms ——
 * 它就是 FCP 的瓶颈。
 *
 * 内联之后 CSS 随 HTML 一起到达，省掉一次「发现 → 请求 → 等待」的 RTT。
 * 重复访问不受影响：HTML 是 `must-revalidate`，304 时浏览器直接用缓存里那份带内联样式的 HTML。
 *
 * 只处理 index.html 里真正引用的那一个 CSS chunk；懒加载 chunk（viewer / maplibre）的
 * CSS 不在这里，仍然按需加载。
 */
export function inlineMainCssPlugin(): Plugin {
  return {
    name: 'afilmory:inline-main-css',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) {
          return html
        }

        const linkPattern = /<link[^>]*rel="stylesheet"[^>]*href="\/([^"]+\.css)"[^>]*>/g
        let result = html
        const inlined: string[] = []

        for (const match of html.matchAll(linkPattern)) {
          const fileName = match[1]
          const asset = bundle[fileName]
          if (!asset || asset.type !== 'asset') {
            continue
          }
          const css = typeof asset.source === 'string' ? asset.source : asset.source.toString()
          // </style> 出现在样式里会提前结束标签；转义掉以防万一
          const safeCss = css.replaceAll('</style', String.raw`<\/style`)
          result = result.replace(match[0], `<style>${safeCss}</style>`)
          inlined.push(fileName)
        }

        // 已经内联的文件从产物里删掉，避免变成「下载了但没人用」的死资源
        for (const fileName of inlined) {
          delete bundle[fileName]
        }

        return result
      },
    },
  }
}
