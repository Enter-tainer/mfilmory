import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { OutputBundle, Plugin } from 'vite'

/**
 * 把主样式表内联进 HTML。
 *
 * 首屏的 render-blocking 资源只有一条 `<link rel="stylesheet">`：浏览器必须先下完它、
 * 解析完才会 paint（哪怕 splash 是纯 inline style 的静态 HTML 也一样等）。
 * 线上实测这条 CSS 从 752 ms 开始、1636 ms 才下完，first-paint 拖到 1808 ms ——
 * 它就是 FCP 的瓶颈。内联之后 CSS 随 HTML 一起到达，省掉一次「发现 → 请求 → 等待」的 RTT。
 *
 * 只处理 index.html 里真正引用的那一个 CSS chunk；懒加载 chunk（viewer / MapLibre）的
 * CSS 不在这里，仍然按需加载。
 *
 * ## 为什么这么啰嗦
 *
 * 「从产物里删掉已经内联的 CSS」有一个不能靠肉眼发现的陷阱：Vite 生成
 * `__vite__mapDeps` 时会把 `chunk.viteMetadata.importedCss` 里的每个文件都塞进依赖数组，
 * **并且不检查那个 asset 是否还在 bundle 里**。入口 chunk 的 importedCss 含主 CSS，
 * 而 viewer / map 等懒加载 chunk 都静态 import 入口 chunk —— 于是它们递归继承了主 CSS，
 * 内联后仍会在运行时 `appendChild(<link rel=stylesheet>)` 去请求一个已经被删掉的文件。
 * 那是个 error 时 reject 的 promise，会派发 `vite:preloadError`；仓库里没有任何监听器，
 * 于是抛进 `__vitePreload`，动态 import 直接失败 —— `/map`、viewer 的 MiniMap 全炸，
 * 而且**只对全新访客炸**（老访客的 `/assets/*` 是 immutable 一年的 HTTP 缓存，不会真去请求）。
 *
 * 所以这里做三件事，缺一不可：
 * 1. 删 asset 的同时，把该文件名从**所有** chunk 的 `viteMetadata.importedCss` 里摘掉；
 * 2. `writeBundle` 里读磁盘上的 `index.html` 和内存里的 chunk 代码，断言没有任何一处
 *    还引用被删掉的文件 —— 任何未来改动（Vite 升级、开 `build.manifest`、加 precache）
 *    只要把引用带回来，构建立刻失败，而不是上线后静默 404；
 * 3. 拿不到 CSS / 匹配不到 `<link>` / 出现 `</style` 这些「优化静默失效」的路径一律
 *    warn 或 error，不再闷声放过。
 *
 * 另外 `vite.config.ts` 里的 `createHtmlPlugin({ minify: { minifyCSS: true } })` 必须关掉：
 * 它在 `generateBundle`（晚于所有 `transformIndexHtml`）把内联后的整份 CSS 再丢给
 * clean-css 重压一遍，而 clean-css 5.3.3 不认识 `@scope`，会把 DaisyUI `join` 那一整块
 * 静默删掉 —— 于是「产物里的 CSS」和「浏览器实际拿到的 CSS」不是同一份。
 */
export function inlineMainCssPlugin(): Plugin {
  /** 本次构建里被内联掉的产物文件名，供 writeBundle 断言使用 */
  const inlinedFileNames = new Set<string>()
  let outDir = ''
  let base = '/'

  return {
    name: 'afilmory:inline-main-css',
    apply: 'build',

    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
      base = config.base
    },

    transformIndexHtml: {
      // 必须晚于 `vite:build-html`（它才负责把 <link rel=stylesheet> 注入 HTML）
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) {
          // build 阶段 transformIndexHtml 一定带 bundle；真没有就说明 Vite 行为变了，
          // 不能悄悄跳过（那会让这个优化静默消失）。
          this.warn('[inline-main-css] 没有拿到 bundle，跳过内联（Vite 行为可能变了）')
          return html
        }

        // href 可能带 base（`BUILD_FOR_SERVER_SERVE=1` 时 base 是 `/static/web/`），
        // 也可能是绝对 URL（CDN）。只处理能映射到 bundle 键的那种。
        const toBundleKey = (href: string): string | null => {
          let url = href
          if (base !== '/' && url.startsWith(base)) {
            url = url.slice(base.length)
          }
          else if (url.startsWith('/')) {
            url = url.slice(1)
          }
          else if (!/^[a-z]+:/i.test(url)) {
            // 相对路径（如 `./assets/x.css`）
            url = url.replace(/^\.\//, '')
          }
          else {
            return null
          }
          return url.split(/[?#]/)[0]
        }

        const linkPattern = /<link\b[^>]*>/g
        const replacements: { tag: string, fileName: string }[] = []

        for (const match of html.matchAll(linkPattern)) {
          const tag = match[0]
          // 属性顺序不固定，逐个属性挑出来判断，不依赖书写顺序
          if (!/\brel\s*=\s*"stylesheet"/.test(tag)) {
            continue
          }
          const href = tag.match(/\bhref\s*=\s*"([^"]+)"/)?.[1]
          if (!href) {
            continue
          }
          const fileName = toBundleKey(href)
          if (!fileName) {
            // 绝对 URL 的外链样式表：不归这个插件管，但要说一声，免得以为内联了
            this.warn(`[inline-main-css] 跳过非本地产物样式表：${href}`)
            continue
          }
          const asset = bundle[fileName]
          if (!asset || asset.type !== 'asset') {
            this.warn(`[inline-main-css] HTML 里引用了 ${href}，但 bundle 里没有 ${fileName}，跳过`)
            continue
          }
          replacements.push({ tag, fileName })
        }

        if (replacements.length === 0) {
          this.warn('[inline-main-css] HTML 里没有可内联的样式表 —— 内联优化没有生效（不是失败，但请确认这是预期）')
          return html
        }

        let result = html
        for (const { tag, fileName } of replacements) {
          const asset = bundle[fileName]
          if (!asset || asset.type !== 'asset') {
            continue
          }
          const css = typeof asset.source === 'string'
            ? asset.source
            : new TextDecoder().decode(asset.source)

          // `</style` 会提前结束 rawtext 元素；HTML 的结束标签是大小写不敏感的。
          // 正常 CSS 里不可能出现它 —— 出现了说明有人在往 CSS 里塞 markup，
          // 这是构建期就该炸的错误，不该靠静默改字节糊过去。
          if (/<\/style/i.test(css)) {
            this.error(`[inline-main-css] ${fileName} 里出现了 </style，无法安全内联`)
          }

          // 注意用函数式 replacer：字符串形式会把 CSS 里的 `$&` / `$'` / `$1` 当成
          // 替换模式解释，一条 `content: "$&"` 就能把整个文档塞进 <style>。
          result = result.replace(tag, () => `<style>${css}</style>`)
          inlinedFileNames.add(fileName)
        }

        // 删产物 + 清掉所有 chunk 的 importedCss 引用（见文件头 B1 说明）
        for (const fileName of inlinedFileNames) {
          delete bundle[fileName]
        }
        dropImportedCssReferences(bundle, inlinedFileNames)

        return result
      },
    },

    writeBundle(options, bundle) {
      if (inlinedFileNames.size === 0) {
        return
      }

      const dir = options.dir ? path.resolve(options.dir) : outDir

      // 1) 磁盘上的 index.html 不该再有任何指向被删文件的 <link>
      let emittedHtml = ''
      try {
        emittedHtml = readFileSync(path.join(dir, 'index.html'), 'utf8')
      }
      catch (error) {
        this.error(`[inline-main-css] 读不到 ${path.join(dir, 'index.html')}：${String(error)}`)
      }
      for (const fileName of inlinedFileNames) {
        // 只查 `<link ...>` 里的引用，避免把 <style> 内的文本误判
        for (const match of emittedHtml.matchAll(/<link\b[^>]*>/g)) {
          if (match[0].includes(fileName)) {
            this.error(`[inline-main-css] index.html 里还有 <link> 指向已内联的 ${fileName}`)
          }
        }
      }

      // 2) 任何 chunk 的代码里都不该出现被删文件名 —— 这正是 __vite__mapDeps 那种
      //    「JS 里留了引用、运行时去请求一个不存在的文件」的防线
      for (const [bundleKey, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') {
          continue
        }
        for (const fileName of inlinedFileNames) {
          if (output.code.includes(fileName)) {
            this.error(
              `[inline-main-css] chunk ${bundleKey} 仍引用已内联的 ${fileName}`
              + `（Vite 的 __vite__mapDeps 会让懒加载路由去请求一个不存在的文件）`,
            )
          }
        }
      }
    },
  }
}

/**
 * 把文件名从所有 chunk 的 `viteMetadata.importedCss` 里摘掉（兼容 Set 与数组两种形态）。
 * Vite 8 里它是 `Set<string>`，写兼容是怕以后变成数组后这里静默不生效。
 */
function dropImportedCssReferences(bundle: OutputBundle, fileNames: Set<string>) {
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') {
      continue
    }
    const importedCss = (output.viteMetadata as { importedCss?: unknown } | undefined)?.importedCss
    if (!importedCss) {
      continue
    }
    if (importedCss instanceof Set) {
      for (const fileName of fileNames) {
        importedCss.delete(fileName)
      }
      continue
    }
    if (Array.isArray(importedCss)) {
      const kept = importedCss.filter(item => typeof item !== 'string' || !fileNames.has(item))
      importedCss.length = 0
      importedCss.push(...kept)
      continue
    }
    // 形态未知：什么都不做，让 writeBundle 的断言去兜底（它会因为 JS 里残留引用而失败）
  }
}
