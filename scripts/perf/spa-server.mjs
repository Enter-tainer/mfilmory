/**
 * SPA-fallback static server for local adversarial testing.
 * Mimics Cloudflare Pages: unknown paths -> index.html; correct MIME; no caching surprises.
 * Usage: node spa-server.mjs <dir> <port>
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'apps/web/dist')
const port = Number(process.argv[3] ?? 8140)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  let filePath = path.join(root, urlPath)

  // directory -> index.html inside it
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }

  let send = filePath
  if (!existsSync(send) || !statSync(send).isFile()) {
    // SPA fallback — same as Cloudflare Pages' single-page-app behaviour
    send = path.join(root, 'index.html')
  }

  const ext = path.extname(send).toLowerCase()
  const isHtmlShell = path.basename(send) === 'index.html'
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // hashed assets: immutable; everything else: revalidate (like the real _headers file)
    'cache-control': /^\/(assets|vendor|fonts)\//.test(urlPath) || /photos-manifest\./.test(urlPath)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  }
  if (isHtmlShell) {
    headers['cache-control'] = 'public, max-age=0, must-revalidate'
  }

  res.writeHead(200, headers)
  createReadStream(send).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`spa server on http://127.0.0.1:${port} serving ${root}`)
})
