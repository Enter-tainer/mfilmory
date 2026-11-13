import fs from 'node:fs/promises'
import path from 'node:path'

import { workdir } from '@afilmory/builder/path.js'

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

async function load(): Promise<Record<string, string>> {
  if (table) return table
  try {
    table = JSON.parse(await fs.readFile(SIGNATURE_PATH, 'utf8')) as Record<string, string>
  }
  catch {
    table = {}
  }
  return table
}

function keyOf(kind: AssetKind, photoId: string): string {
  return `${kind}:${photoId}`
}

export function hardForceEncode(): boolean {
  return process.env.MFILMORY_FORCE_ENCODE === '1'
}

export async function signatureMatches(kind: AssetKind, photoId: string, signature: string): Promise<boolean> {
  if (hardForceEncode()) return false
  const all = await load()
  return all[keyOf(kind, photoId)] === signature
}

export async function writeSignature(kind: AssetKind, photoId: string, signature: string): Promise<void> {
  const all = await load()
  const key = keyOf(kind, photoId)
  if (all[key] === signature) return
  all[key] = signature
  await fs.mkdir(path.dirname(SIGNATURE_PATH), { recursive: true })
  await fs.writeFile(SIGNATURE_PATH, JSON.stringify(all, null, 2))
}
