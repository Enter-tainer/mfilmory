#!/usr/bin/env node
/**
 * Cross-platform replacement for the old `sh scripts/prepare-demo-data.sh`.
 *
 * Seeds a runnable demo:
 *  1. copies config.example.json -> config.json when missing,
 *  2. clones https://github.com/Afilmory/demo-photos into ./photos when the folder is empty,
 *  3. copies the photos into apps/web/public/photos (the local storage provider root),
 *  4. writes builder.config.ts with the `local` storage provider so no S3 credentials are needed.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cwd = root

if (!existsSync(path.join(root, 'config.json'))) {
  cpSync(path.join(root, 'config.example.json'), path.join(root, 'config.json'))
}

const photosDir = path.join(root, 'photos')
if (!existsSync(photosDir) || readdirSync(photosDir).length === 0) {
  console.info('[mfilmory] Fetching demo photos from https://github.com/Afilmory/demo-photos ...')
  rmSync(photosDir, { recursive: true, force: true })
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/Afilmory/demo-photos', photosDir], {
    cwd,
    stdio: 'inherit',
  })
  rmSync(path.join(photosDir, '.git'), { recursive: true, force: true })
}

const publicPhotosDir = path.join(root, 'apps', 'web', 'public', 'photos')
mkdirSync(publicPhotosDir, { recursive: true })
cpSync(photosDir, publicPhotosDir, { recursive: true })

// A real deployment points builder.config.ts at S3/R2. Do not silently throw that
// away: keep a copy next to it before swapping in the local demo provider.
const builderConfigPath = path.join(root, 'builder.config.ts')
if (
  existsSync(builderConfigPath)
  && !readFileSync(builderConfigPath, 'utf8').includes("provider: 'local'")
) {
  cpSync(builderConfigPath, `${builderConfigPath}.bak`, { force: true })
  console.info('[mfilmory] backed up existing builder.config.ts -> builder.config.ts.bak')
}

writeFileSync(
  path.join(root, 'builder.config.ts'),
  `import { defineBuilderConfig } from '@afilmory/builder'

export default defineBuilderConfig(() => ({
  storage: {
    provider: 'local',
    basePath: './apps/web/public/photos',
    baseUrl: '/photos',
  },
}))
`,
)

console.info('[mfilmory] demo data ready: photos copied to apps/web/public/photos, builder.config.ts uses the local provider')
