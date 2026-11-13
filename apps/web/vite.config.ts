import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path, { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { codeInspectorPlugin } from 'code-inspector-plugin'
import { cyan, dim, green } from 'kolorist'
import type { PluginOption, ViteDevServer } from 'vite'
import { defineConfig } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
import { checker } from 'vite-plugin-checker'
import { createHtmlPlugin } from 'vite-plugin-html'
import { VitePWA } from 'vite-plugin-pwa'
import { routeBuilderPlugin } from 'vite-plugin-route-builder'
import tsconfigPaths from 'vite-tsconfig-paths'

import PKG from '../../package.json'
import { siteConfig } from '../../site.config'
import { astPlugin } from './plugins/vite/ast'
import { createDependencyChunksPlugin } from './plugins/vite/deps'
import { createFeedSitemapPlugin } from './plugins/vite/feed-sitemap'
import { inlineMainCssPlugin } from './plugins/vite/inline-main-css'
import { localesJsonPlugin } from './plugins/vite/locales-json'
import { manifestInjectPlugin } from './plugins/vite/manifest-inject'
import { ogImagePlugin } from './plugins/vite/og-image-plugin'
import { photosStaticPlugin } from './plugins/vite/photos-static'
import { siteConfigInjectPlugin } from './plugins/vite/site-config-inject'

const devPrint = (): PluginOption => ({
  name: 'dev-print',
  configureServer(server: ViteDevServer) {
    server.printUrls = () => {
      console.info(`  ${green('➜')}  ${dim('Next.js SSR')}: ${cyan('http://localhost:1924')}`)
    }
  },
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (process.env.CI) {
  rmSync(path.join(process.cwd(), 'src/pages/(debug)'), {
    recursive: true,
    force: true,
  })
}
const DEV_NEXT_JS = process.env.DEV_NEXT_JS === 'true'

const ReactCompilerConfig = {
  /* ... */
}

const ROOT = fileURLToPath(new URL('./', import.meta.url))
// fast-glob requires forward slashes on Windows: a native `C:\...\src\pages`
// pattern silently matches zero files and the SPA ends up with no routes.
const toPosixPath = (p: string) => p.replaceAll('\\', '/')
const routeGenPlugins: PluginOption[] = [
  routeBuilderPlugin({
    pagePattern: `${toPosixPath(resolve(ROOT, './src/pages'))}/**/*.tsx`,
    outputPath: `${resolve(ROOT, './src/generated-routes.ts')}`,
    enableInDev: true,

    segmentGroupOrder: ['main'],
  }),
]
const staticWebBuildPlugins: PluginOption[] = [
  manifestInjectPlugin(),
  inlineMainCssPlugin(),
  siteConfigInjectPlugin(),
  photosStaticPlugin(),
  // PWA service worker has been retired: it provided no offline capability (navigateFallback was
  // disabled and index.html was never precached) while its workbox precache could permanently poison
  // a chunk URL — Cloudflare Pages answers a missing asset with `200 text/html`, workbox only rejects
  // `status >= 400`, and `assets/**` entries carried `revision: null`, so the SPA shell was cached
  // under the `.js` key forever. `selfDestroying` ships a worker that unregisters itself
  // and deletes every Cache Storage entry on activate, healing already-affected clients;
  // `injectRegister: false` stops emitting `registerSW.js`, which would otherwise re-register the
  // worker on every page load. Keep `manifest` — installability does not require a service worker.
  // To restore PWA support, drop `selfDestroying` and `injectRegister`, restore `registerType` and
  // the previous `workbox` block from git history.
  VitePWA({
    base: '/',
    scope: '/',
    selfDestroying: true,
    injectRegister: false,
    includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
    manifest: {
      name: siteConfig.title,
      short_name: siteConfig.name,
      description: siteConfig.description,
      theme_color: '#1c1c1e',
      background_color: '#1c1c1e',
      display: 'standalone',
      scope: '/',
      start_url: '/',
      icons: [
        {
          src: 'android-chrome-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        {
          src: 'android-chrome-512x512.png',
          sizes: '512x512',
          type: 'image/png',
        },
        {
          src: 'apple-touch-icon.png',
          sizes: '180x180',
          type: 'image/png',
        },
      ],
    },
    devOptions: {
      enabled: false, // 开发环境不启用 PWA
    },
  }),

  ogImagePlugin({
    title: siteConfig.title,
    description: siteConfig.description,
    siteName: siteConfig.name,
    siteUrl: siteConfig.url,
  }),
  createFeedSitemapPlugin(siteConfig),
  createHtmlPlugin({
    minify: {
      collapseWhitespace: true,
      keepClosingSlash: true,
      removeComments: true,
      removeRedundantAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      useShortDoctype: true,
      minifyCSS: true,
      minifyJS: true,
    },
    inject: {
      data: {
        title: siteConfig.title,
        description: siteConfig.description,
      },
    },
  }),
]

const BUILD_FOR_SERVER_SERVE = process.env.BUILD_FOR_SERVER_SERVE === '1'
// https://vitejs.dev/config/
export default defineConfig(() => {
  return {
    base: BUILD_FOR_SERVER_SERVE ? '/static/web/' : '/',
    assetsInclude: ['**/*.wasm'],
    build: {
      rollupOptions: BUILD_FOR_SERVER_SERVE
        ? {
            input: {
              main: path.resolve(__dirname, 'index.html'),
            },
          }
        : undefined,
    },
    plugins: [
      codeInspectorPlugin({
        bundler: 'vite',
        hotKeys: ['altKey'],
      }),
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
        },
      }),

      astPlugin,
      tsconfigPaths(),
      checker({
        typescript: true,
        enableBuild: true,
        root: __dirname,
      }),

      ...routeGenPlugins,
      createDependencyChunksPlugin([
        ['heic-to'],
        ['react', 'react-dom'],
        ['i18next', 'i18next-browser-languagedetector', 'react-i18next'],
      ]),
      localesJsonPlugin(),
      tailwindcss(),
      ...(BUILD_FOR_SERVER_SERVE ? [] : staticWebBuildPlugins),
      process.env.analyzer && analyzer(),

      devPrint(),
    ],
    server: {
      port: !DEV_NEXT_JS ? 1924 : 13333, // 1924 年首款 35mm 相机问世
    },
    define: {
      APP_DEV_CWD: JSON.stringify(process.cwd()),
      APP_NAME: JSON.stringify(PKG.name),
      BUILT_DATE: JSON.stringify(new Date().toLocaleDateString()),
      GIT_COMMIT_HASH: JSON.stringify(getGitHash()),
    },
  }
})

function getGitHash() {
  try {
    return execSync('git rev-parse HEAD').toString().trim()
  }
  catch (e) {
    console.error('Failed to get git hash', e)
    return ''
  }
}
