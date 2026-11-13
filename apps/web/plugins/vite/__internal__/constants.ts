import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// The manifest is written by `packages/builder` straight into the SPA:
// apps/web/src/data/photos-manifest.json. Point at it directly instead of going
// through the `packages/data/src/photos-manifest.json` symlink (symlinks are
// checked out as plain text files on Windows, which broke the JSON read).
export const MANIFEST_PATH = path.resolve(dirname, '../../../src/data/photos-manifest.json')

export const MONOREPO_ROOT_PATH = path.resolve(dirname, '../../../../..')
