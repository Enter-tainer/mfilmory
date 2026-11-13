#!/usr/bin/env node
/**
 * Cross-platform replacement for the old `sh scripts/preinstall.sh`.
 * Seeds the user-editable, git-ignored config files before install so that
 * `site.config.ts` / `builder.config.ts` always resolve.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!existsSync(path.join(root, 'config.json'))) {
  copyFileSync(path.join(root, 'config.example.json'), path.join(root, 'config.json'))
  console.info('[mfilmory] seeded config.json from config.example.json')
}

if (!existsSync(path.join(root, 'builder.config.ts'))) {
  copyFileSync(path.join(root, 'builder.config.default.ts'), path.join(root, 'builder.config.ts'))
  console.info('[mfilmory] seeded builder.config.ts from builder.config.default.ts')
}
