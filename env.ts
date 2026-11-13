import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import { expand } from 'dotenv-expand'

import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Load the repo-root `.env` explicitly instead of relying on `process.cwd()`.
// pnpm runs workspace scripts with cwd set to the package directory (e.g.
// packages/builder), so the implicit `dotenv-expand/config` lookup missed the
// root .env and every S3 value came back undefined.
expand(loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true }))

export const env = createEnv({
  server: {
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_ENDPOINT: z
      .string()
      .default('https://s3.us-east-1.amazonaws.com')
      .optional(),
    S3_BUCKET_NAME: z.string().min(1).optional(),
    S3_PREFIX: z.string().default('').optional(),
    S3_CUSTOM_DOMAIN: z.string().default('').optional(),
    S3_EXCLUDE_REGEX: z.string().optional(),

    // Git token for uploading updated manifest to remote repository
    GIT_TOKEN: z.string().optional(),
  },
  runtimeEnv: process.env,
  isServer: typeof window === 'undefined',
})
