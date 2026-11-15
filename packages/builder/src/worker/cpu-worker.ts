import { Buffer } from 'node:buffer'
import process from 'node:process'
import { format as utilFormat } from 'node:util'

import sharp from 'sharp'

import { logger, setLogListener } from '../logger/index.js'
import type { CpuOgRenderInput, CpuPhotoTaskInput, CpuPhotoTaskOutput } from '../photo/cpu-task.js'
import { runOgRenderTask, runPhotoCpuTask } from '../photo/cpu-task.js'
import { runWithPhotoExecutionContext } from '../photo/execution-context.js'
import { createPhotoProcessingLoggers } from '../photo/logger-adapter.js'

export type CpuWorkerRequest
  = | { type: 'photo', id: number, input: CpuPhotoTaskInput }
    | { type: 'og', id: number, input: CpuOgRenderInput }
    | { type: 'shutdown' }

export type CpuWorkerResponse
  = | { type: 'ready', workerId: number }
    | { type: 'photo-result', id: number, output: CpuPhotoTaskOutput }
    | { type: 'og-result', id: number, buffer: Buffer }
    | { type: 'error', id: number, message: string }
    | { type: 'log', tag: string, level: string, text: string }

function toUint8ArrayOrBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error('Expected Buffer/Uint8Array payload in CPU worker')
}

function safeSend(message: CpuWorkerResponse): void {
  try {
    if (process.send && process.connected) {
      process.send(message)
    }
  }
  catch {
    // 主进程已关闭 IPC 通道
  }
}

function startCpuWorker(): void {
  const workerId = Math.max(1, Number.parseInt(process.env.AFILMORY_CPU_WORKER_ID || '1', 10) || 1)
  const sharpConcurrency = Math.max(1, Number.parseInt(process.env.SHARP_CONCURRENCY || '1', 10) || 1)

  process.title = `afilmory-cpu-worker-${workerId}`
  sharp.concurrency(sharpConcurrency)
  // 禁用 libvips 文件描述符缓存，避免 Windows 上持有原图缓存句柄
  sharp.cache({ memory: 50, files: 0, items: 50 })

  setLogListener(
    (msg) => {
      safeSend({
        type: 'log',
        tag: msg.tag,
        level: String(msg.level),
        text: utilFormat(...(msg.args as unknown[])),
      })
    },
    { forwardToConsole: false },
  )

  const workerLoggers = createPhotoProcessingLoggers(workerId, logger)
  const workerContext = {
    builder: null!,
    storageManager: null!,
    storageConfig: null!,
    normalizeStorageKey: (key: string) => key,
    loggers: workerLoggers,
  }

  process.on('message', async (message: CpuWorkerRequest) => {
    if (message.type === 'shutdown') {
      process.removeAllListeners('message')
      process.exit(0)
    }

    if (message.type === 'photo') {
      try {
        const input: CpuPhotoTaskInput = message.input.rawBuffer
          ? { ...message.input, rawBuffer: toUint8ArrayOrBuffer(message.input.rawBuffer) }
          : message.input

        const output = await runWithPhotoExecutionContext(workerContext, () => runPhotoCpuTask(input))
        safeSend({ type: 'photo-result', id: message.id, output })
      }
      catch (error) {
        safeSend({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
      }
      return
    }

    if (message.type === 'og') {
      try {
        const input: CpuOgRenderInput = {
          ...message.input,
          buffer: toUint8ArrayOrBuffer(message.input.buffer),
        }
        const buffer = await runWithPhotoExecutionContext(workerContext, () => runOgRenderTask(input))
        safeSend({ type: 'og-result', id: message.id, buffer })
      }
      catch (error) {
        safeSend({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
      }
    }
  })

  safeSend({ type: 'ready', workerId })
}

startCpuWorker()
