import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const workdir = process.env.MFILMORY_WORKDIR
  ? path.resolve(process.env.MFILMORY_WORKDIR)
  : path.resolve(__dirname, '../../../apps/web')
