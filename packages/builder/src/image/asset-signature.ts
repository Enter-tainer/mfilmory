import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { workdir } from '@afilmory/builder/path.js'

import { sleep } from '../../../utils/src/backoff.js'

/**
 * 产物参数签名。
 *
 * 缩略图 / 占位图 / OG 卡都是「输入原图 × 一组编码参数」的纯函数结果。
 * 只改其中一档参数时，另外两档没必要重算——这个表记录每张照片每种产物
 * 上次是用哪组参数生成的，参数没变就直接复用磁盘上的文件。
 *
 * 真正想强制重算时设 MFILMORY_FORCE_ENCODE=1（例如怀疑文件损坏）。
 */
export type AssetKind = 'thumbnail' | 'preview' | 'og'

const SIGNATURE_PATH = path.join(workdir, 'src/data/.cache/asset-signatures.json')

let table: Record<string, string> | null = null
let loadPromise: Promise<Record<string, string>> | null = null
let mutationRevision = 0
let flushedRevision = 0
let deferFlush = false
let flushChain: Promise<void> = Promise.resolve()

async function retryOnWindowsLock(op: () => Promise<void>): Promise<void> {
  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await op()
      return
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === 'EPERM' || code === 'EBUSY') && attempt < maxAttempts) {
        await sleep(30 * attempt)
        continue
      }
      throw error
    }
  }
}

export async function renameWithWindowsRetry(srcPath: string, dstPath: string): Promise<void> {
  await retryOnWindowsLock(() => fs.rename(srcPath, dstPath))
}

export async function removeWithWindowsRetry(targetPath: string): Promise<void> {
  await retryOnWindowsLock(() => fs.rm(targetPath, { force: true }))
}

async function load(): Promise<Record<string, string>> {
  if (table) {
    return table
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(SIGNATURE_PATH, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          table = parsed as Record<string, string>
        }
        else {
          table = {}
        }
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          console.warn(`[asset-signature] Failed to load ${SIGNATURE_PATH}, starting fresh:`, error)
        }
        table = {}
      }
      return table
    })()
  }
  return loadPromise
}

function keyOf(kind: AssetKind, photoId: string): string {
  return `${kind}:${photoId}`
}

export function hardForceEncode(): boolean {
  return process.env.MFILMORY_FORCE_ENCODE === '1'
}

export function setSignatureBatchMode(enabled: boolean): void {
  deferFlush = enabled
}

export async function signatureMatches(kind: AssetKind, photoId: string, signature: string): Promise<boolean> {
  if (hardForceEncode()) {
    return false
  }
  const all = await load()
  return all[keyOf(kind, photoId)] === signature
}

export async function flushSignatures(): Promise<void> {
  const nextFlush = flushChain.then(async () => {
    if (flushedRevision >= mutationRevision || !table) {
      return
    }
    const targetRevision = mutationRevision
    const snapshot = JSON.stringify(table, null, 2)
    const dir = path.dirname(SIGNATURE_PATH)
    await fs.mkdir(dir, { recursive: true })
    const tmpPath = `${SIGNATURE_PATH}.tmp-${process.pid}-${crypto.randomUUID()}`
    try {
      await fs.writeFile(tmpPath, snapshot)
      await renameWithWindowsRetry(tmpPath, SIGNATURE_PATH)
      flushedRevision = targetRevision
    }
    finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  })

  // 防止单次落盘失败永久污染 flushChain 链，同时保留本次调用的异常抛出
  flushChain = nextFlush.catch(() => {})
  await nextFlush
}

export async function writeSignature(kind: AssetKind, photoId: string, signature: string): Promise<void> {
  const all = await load()
  const key = keyOf(kind, photoId)
  if (all[key] === signature) {
    return
  }
  all[key] = signature
  mutationRevision++
  if (!deferFlush) {
    await flushSignatures()
  }
}
