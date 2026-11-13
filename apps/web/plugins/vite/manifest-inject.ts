import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import type { Plugin } from 'vite'

import { MANIFEST_PATH } from './__internal__/constants'

const MANIFEST_PLACEHOLDER = '<script id="manifest"></script>'
const MANIFEST_FILE_BASENAME = 'photos-manifest'

type ManifestMode = 'inline' | 'external'

/**
 * `AFILMORY_EMBED_MANIFEST`:
 *   - `true`  → 老行为：整份 manifest 内联进 HTML（769 KB，HTML 不可缓存）
 *   - `false` → 外置成可缓存的 JSON
 *   - 未设置  → build 时外置，dev 时内联（dev 没有构建产物，内联才能热更新）
 */
function resolveMode(command: 'serve' | 'build'): ManifestMode {
  const flag = process.env.AFILMORY_EMBED_MANIFEST?.trim().toLowerCase()
  if (flag === 'true') {
    return 'inline'
  }
  if (flag === 'false') {
    return 'external'
  }
  return command === 'serve' ? 'inline' : 'external'
}

export function manifestInjectPlugin(): Plugin {
  let mode: ManifestMode = 'inline'
  let manifestJson = '{}'
  /** 形如 /photos-manifest.1a2b3c4d.json */
  let publicPath = ''
  let outDir = ''

  function readManifest(): { text: string, json: string } {
    try {
      const text = readFileSync(MANIFEST_PATH, 'utf-8')
      // 构建产物是格式化过的 JSON；压缩后 brotli 收益仍在，且解析更快
      return { text, json: JSON.stringify(JSON.parse(text)) }
    }
    catch (error) {
      console.warn('Failed to read manifest file:', error)
      return { text: '{}', json: '{}' }
    }
  }

  /** 外置模式下计算产物路径（保持 buildStart / dev server 两条路径一致） */
  function ensurePublicPath(): string {
    if (publicPath) {
      return publicPath
    }
    const { json } = readManifest()
    manifestJson = json
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 8)
    publicPath = `/${MANIFEST_FILE_BASENAME}.${hash}.json`
    return publicPath
  }

  return {
    name: 'manifest-inject',

    configResolved(config) {
      mode = resolveMode(config.command as 'serve' | 'build')
      outDir = path.resolve(config.root, config.build.outDir)
    },

    buildStart() {
      if (mode !== 'external') {
        return
      }
      ensurePublicPath()
    },

    writeBundle(options) {
      if (mode !== 'external' || !publicPath) {
        return
      }
      const dir = options.dir ? path.resolve(options.dir) : outDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, path.basename(publicPath)), manifestJson)
    },

    configureServer(server) {
      if (mode !== 'inline') {
        return
      }

      // 监听 manifest 文件变化
      server.watcher.add(MANIFEST_PATH)

      server.watcher.on('change', (file) => {
        if (file === MANIFEST_PATH) {
          // eslint-disable-next-line no-console
          console.info('[manifest-inject] Manifest file changed, triggering HMR...')
          // 触发页面重新加载
          server.ws.send({
            type: 'full-reload',
          })
        }
      })
    },

    transformIndexHtml(html, ctx) {
      const command: 'serve' | 'build' = ctx?.server ? 'serve' : 'build'
      mode = resolveMode(command)

      if (mode === 'inline') {
        const { text } = readManifest()
        return html.replace(MANIFEST_PLACEHOLDER, `<script id="manifest">window.__MANIFEST__ = ${text};</script>`)
      }

      // 外置：HTML 里只留 URL + 一条 preload，让 JSON 和 HTML/CSS/JS 并行下载
      const url = ensurePublicPath()
      const tags = [
        `<link rel="preload" href="${url}" as="fetch" crossorigin="anonymous">`,
        `<script id="manifest">window.__MANIFEST__=null;window.__MANIFEST_URL__=${JSON.stringify(url)}</script>`,
      ].join('')

      return html.replace(MANIFEST_PLACEHOLDER, tags)
    },
  }
}
