#!/usr/bin/env node
/**
 * Cloudflare Pages deploy helper.
 *
 * Why a script instead of a bare `wrangler pages deploy`: wrangler only picks up
 * the `functions/` directory of its *working directory*, and this repo keeps the
 * CF OG middleware in the repo root (`functions/_middleware.ts`). Deploying from
 * `apps/web` silently ships a Pages project without that middleware.
 *
 * Usage:
 *   node scripts/deploy.mjs                  # build + deploy to production (branch main)
 *   node scripts/deploy.mjs --preview        # build + deploy as a preview deployment
 *   node scripts/deploy.mjs --skip-build     # deploy the existing apps/web/dist (regenerates the middleware if missing)
 *   node scripts/deploy.mjs --dry-run        # print the wrangler command only
 *   node scripts/deploy.mjs --project=foo --branch=bar --dirty
 *
 * Env overrides: CF_PAGES_PROJECT, CF_PRODUCTION_BRANCH, CF_PREVIEW_BRANCH.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// drop the bare `--` pnpm inserts when invoked as `pnpm deploy:preview -- --flag`
const argv = process.argv.slice(2).filter(arg => arg !== '--')
const has = flag => argv.includes(flag)
const value = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(`--${name}=`.length) : fallback
}

const preview = has('--preview')
const project = value('project', process.env.CF_PAGES_PROJECT ?? 'mgt-afilmory')
const branch = value(
  'branch',
  preview ? (process.env.CF_PREVIEW_BRANCH ?? 'mfilmory-preview') : (process.env.CF_PRODUCTION_BRANCH ?? 'main'),
)
const skipBuild = has('--skip-build')
const dryRun = has('--dry-run')
const allowMissingMiddleware = has('--allow-missing-middleware')

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

for (const [label, val] of [['project', project], ['branch', branch]]) {
  if (!/^[\w.-]+$/.test(val)) fail(`invalid ${label}: "${val}"`)
}

const distDir = path.join(root, 'apps', 'web', 'dist')
const middleware = path.join(root, 'functions', '_middleware.ts')

if (skipBuild) {
  console.info('• --skip-build: reusing', path.relative(root, distDir))
}
else {
  console.info('• building (pnpm build)…')
  execSync('pnpm build', { cwd: root, stdio: 'inherit' })
}

if (!existsSync(path.join(distDir, 'index.html'))) {
  fail(`apps/web/dist/index.html is missing — run "pnpm build" first (or drop --skip-build)`)
}

if (!existsSync(middleware)) {
  const hint = 'run "pnpm build" (the builder regenerates it) or "pnpm og:middleware"'
  if (allowMissingMiddleware) {
    console.warn(`⚠ functions/_middleware.ts is missing — the Cloudflare OG middleware will NOT be deployed (${hint})`)
  }
  else if (dryRun) {
    console.warn(`⚠ functions/_middleware.ts is missing (dry-run: not regenerating) — ${hint}`)
  }
  else {
    // The middleware is git-ignored build output, so a fresh clone or a
    // `--skip-build` deploy may not have it. Regenerate it from the vendor
    // template before giving up; the generator reads S3_CUSTOM_DOMAIN from .env.
    console.info('• functions/_middleware.ts is missing — regenerating (pnpm og:middleware)…')
    try {
      execSync('pnpm og:middleware', { cwd: root, stdio: 'inherit' })
    }
    catch {
      // fall through to the explicit failure below
    }
    if (!existsSync(middleware)) {
      fail(`functions/_middleware.ts is missing and could not be regenerated — ${hint}; make sure .env contains S3_CUSTOM_DOMAIN`)
    }
  }
}

// wrangler refuses to deploy a dirty working tree unless told to.
let dirtyFlag = ''
if (has('--dirty')) {
  dirtyFlag = ' --commit-dirty=true'
}
else {
  try {
    const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim()
    if (status.length > 0) dirtyFlag = ' --commit-dirty=true'
  }
  catch {
    // not a git checkout — nothing to do
  }
}

const command = `pnpx wrangler pages deploy apps/web/dist --project-name ${project} --branch ${branch}${dirtyFlag}`

console.info(`\n• project : ${project}`)
console.info(`• branch  : ${branch}${preview ? '  (preview deployment)' : '  (production deployment)'}`)
console.info(`• dir     : apps/web/dist (${path.relative(root, distDir)})`)
console.info(`• functions: ${path.relative(root, middleware)}${dryRun ? ' [dry-run]' : ''}\n`)

if (dryRun) {
  console.info(`${command}\n`)
  process.exit(0)
}

execSync(command, { cwd: root, stdio: 'inherit' })
console.info(`\n✓ deployed → https://${project}.pages.dev${preview ? ' (preview)' : ''}`)
