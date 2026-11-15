import { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import { Semaphore } from '../../../utils/src/semaphore.js'
import { logger, relayLogMessage } from '../logger/index.js'
import type { CpuPhotoTaskInput, CpuPhotoTaskOutput } from '../photo/cpu-task.js'
import { runOgRenderTask, runPhotoCpuTask } from '../photo/cpu-task.js'
import type { CpuWorkerRequest, CpuWorkerResponse } from './cpu-worker.js'

export interface CpuPoolConfig {
  cpuConcurrency: number | 'auto'
  sharpConcurrency: number | 'auto'
  cpuWorkerCount: number | 'auto'
  taskCount: number
}

export interface ResolvedCpuPlan {
  mode: 'cpu-worker' | 'in-process'
  cpuSlots: number
  sharpConcurrency: number
  workerCount: number
}

interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

interface WorkerSlot {
  id: number
  child: ChildProcess
  maxSlots: number
  activeTasks: number
  exited: boolean
  pending: Map<number, PendingRequest<unknown>>
}

function resolveWorkerScriptPath(): string | null {
  for (const candidate of ['./cpu-worker.ts', './cpu-worker.js', './cpu-worker.mjs']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) {
      return path
    }
  }
  return null
}

function filterChildExecArgv(execArgv: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
      i++
      continue
    }
    if (arg.startsWith('--eval=') || arg.startsWith('--print=') || arg.startsWith('--inspect')) {
      continue
    }
    filtered.push(arg)
  }
  return filtered
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error('Expected Buffer payload from CPU worker')
}

export function resolveCpuPlan(config: CpuPoolConfig, hasWorkerScript: boolean): ResolvedCpuPlan {
  const cores = Math.max(1, os.cpus().length)
  const effectiveTasks = Math.max(1, config.taskCount)

  const sharpConc
    = typeof config.sharpConcurrency === 'number' && config.sharpConcurrency > 0
      ? Math.floor(config.sharpConcurrency)
      : effectiveTasks >= cores
        ? 1
        : Math.min(4, Math.max(1, Math.floor(cores / effectiveTasks)))

  const requestedSlots
    = typeof config.cpuConcurrency === 'number' && config.cpuConcurrency > 0
      ? Math.max(1, Math.floor(config.cpuConcurrency))
      : Math.max(1, Math.floor(cores / sharpConc))

  const cpuSlots = Math.max(1, Math.min(effectiveTasks, requestedSlots))

  let workerCount: number
  if (!hasWorkerScript || config.cpuWorkerCount === 0) {
    workerCount = 0
  }
  else if (typeof config.cpuWorkerCount === 'number' && config.cpuWorkerCount > 0) {
    workerCount = Math.min(cpuSlots, Math.floor(config.cpuWorkerCount))
  }
  else {
    // 默认拆出少数轻量子进程（2–8 个），让每进程只需极小的 UV 池即可跑满核且不阻塞主进程
    const targetWorkers = cpuSlots <= 4 ? Math.min(cpuSlots, 2) : Math.min(8, Math.max(2, Math.ceil(cpuSlots / 3)))
    workerCount = Math.min(cpuSlots, targetWorkers)
  }

  if (workerCount === 0) {
    // 同进程回退必须为 fs/dns 留出 libuv 余量，避免 4.8s 级池饥饿
    const uvSize = Math.max(4, Number.parseInt(process.env.UV_THREADPOOL_SIZE || '4', 10) || 4)
    const ioReserve = uvSize <= 4 ? 2 : 3
    const safeInProcessSlots = Math.max(1, Math.min(cpuSlots, uvSize - ioReserve))
    const safeSharpConc
      = typeof config.sharpConcurrency === 'number' && config.sharpConcurrency > 0
        ? sharpConc
        : Math.min(4, Math.max(sharpConc, Math.floor(cores / safeInProcessSlots)))

    return {
      mode: 'in-process',
      cpuSlots: safeInProcessSlots,
      sharpConcurrency: safeSharpConc,
      workerCount: 0,
    }
  }

  return {
    mode: 'cpu-worker',
    cpuSlots,
    sharpConcurrency: sharpConc,
    workerCount,
  }
}

/**
 * 纯 CPU 任务池：将 sharp / heic-convert / bmp 编解码隔离到少量纯算力子进程，
 * 主进程保持干净的 libuv 线程池和事件循环。
 */
export class CpuPool {
  readonly plan: ResolvedCpuPlan
  private readonly workerScriptPath: string | null
  private readonly globalGate: Semaphore
  private readonly workers: WorkerSlot[] = []
  private readonly previousSharpConcurrency: number
  private nextRequestId = 1
  private started = false
  private closed = false

  constructor(config: CpuPoolConfig) {
    this.workerScriptPath = resolveWorkerScriptPath()
    this.plan = resolveCpuPlan(config, this.workerScriptPath !== null)
    this.globalGate = new Semaphore(this.plan.cpuSlots)
    this.previousSharpConcurrency = sharp.concurrency()
  }

  async start(): Promise<void> {
    if (this.started || this.closed) {
      return
    }
    this.started = true

    if (this.plan.mode === 'in-process' || !this.workerScriptPath) {
      sharp.concurrency(this.plan.sharpConcurrency)
      return
    }

    const { workerCount, cpuSlots, sharpConcurrency } = this.plan
    const baseSlots = Math.floor(cpuSlots / workerCount)
    const remainder = cpuSlots % workerCount
    const execArgv = filterChildExecArgv(process.execArgv)

    const readyPromises: Array<Promise<void>> = []
    for (let i = 0; i < workerCount; i++) {
      const workerId = i + 1
      const slotsForWorker = baseSlots + (i < remainder ? 1 : 0)
      const uvSize = Math.max(2, slotsForWorker + 1)
      readyPromises.push(this.spawnWorker(workerId, slotsForWorker, uvSize, sharpConcurrency, execArgv))
    }

    await Promise.all(readyPromises)
  }

  private spawnWorker(
    workerId: number,
    maxSlots: number,
    uvSize: number,
    sharpConcurrency: number,
    execArgv: string[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerScriptPath!, [], {
        execArgv,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          UV_THREADPOOL_SIZE: String(uvSize),
          SHARP_CONCURRENCY: String(sharpConcurrency),
          AFILMORY_CPU_WORKER_ID: String(workerId),
        },
      })

      const slot: WorkerSlot = {
        id: workerId,
        child,
        maxSlots,
        activeTasks: 0,
        exited: false,
        pending: new Map(),
      }
      this.workers.push(slot)

      let settled = false
      const startupTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`CPU worker ${workerId} 启动超时`))
        }
      }, 15_000)

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text) {
          logger.main.warn(`[CPU-WORKER-${workerId}] ${text}`)
        }
      })

      child.on('message', (raw: CpuWorkerResponse) => {
        if (raw.type === 'ready') {
          if (!settled) {
            settled = true
            clearTimeout(startupTimer)
            resolve()
          }
          return
        }

        if (raw.type === 'log') {
          relayLogMessage(raw.tag, raw.level, [raw.text])
          return
        }

        const pending = slot.pending.get(raw.id)
        if (!pending) {
          return
        }
        slot.pending.delete(raw.id)
        slot.activeTasks = Math.max(0, slot.activeTasks - 1)

        if (raw.type === 'error') {
          pending.reject(new Error(raw.message))
          return
        }

        if (raw.type === 'photo-result') {
          const output = raw.output
          pending.resolve({
            ...output,
            thumbnailBuffer: output.thumbnailBuffer ? toBuffer(output.thumbnailBuffer) : null,
            previewBuffer: output.previewBuffer ? toBuffer(output.previewBuffer) : null,
            thumbHash: output.thumbHash ? new Uint8Array(output.thumbHash) : null,
          } satisfies CpuPhotoTaskOutput)
          return
        }

        if (raw.type === 'og-result') {
          pending.resolve(toBuffer(raw.buffer))
        }
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(startupTimer)
          reject(error)
        }
        this.failSlotPending(slot, error)
      })

      child.on('exit', (code, signal) => {
        slot.exited = true
        clearTimeout(startupTimer)
        const reason = new Error(`CPU worker ${workerId} exited (code=${code}, signal=${signal})`)
        if (!settled) {
          settled = true
          reject(reason)
        }
        this.failSlotPending(slot, reason)
      })
    })
  }

  private failSlotPending(slot: WorkerSlot, error: Error): void {
    for (const [id, pending] of slot.pending) {
      slot.pending.delete(id)
      pending.reject(error)
    }
    slot.activeTasks = 0
  }

  private pickWorker(): WorkerSlot {
    const alive = this.workers.filter(w => !w.exited)
    if (alive.length === 0) {
      throw new Error('没有可用的 CPU worker 进程')
    }

    let best = alive[0]
    for (let i = 1; i < alive.length; i++) {
      const candidate = alive[i]
      const candidateRatio = candidate.activeTasks / candidate.maxSlots
      const bestRatio = best.activeTasks / best.maxSlots
      if (candidateRatio < bestRatio) {
        best = candidate
      }
    }
    return best
  }

  private dispatch<T>(buildRequest: (id: number) => CpuWorkerRequest): Promise<T> {
    const slot = this.pickWorker()
    const id = this.nextRequestId++
    slot.activeTasks++

    return new Promise<T>((resolve, reject) => {
      slot.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      try {
        slot.child.send(buildRequest(id))
      }
      catch (error) {
        slot.pending.delete(id)
        slot.activeTasks = Math.max(0, slot.activeTasks - 1)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async runPhotoTask(input: CpuPhotoTaskInput): Promise<CpuPhotoTaskOutput> {
    if (!this.started) {
      await this.start()
    }

    return await this.globalGate.run(async () => {
      if (this.plan.mode === 'in-process') {
        return await runPhotoCpuTask(input)
      }
      return await this.dispatch<CpuPhotoTaskOutput>(id => ({
        type: 'photo',
        id,
        input,
      }))
    })
  }

  async runOgRender(buffer: Buffer, fit?: 'cover' | 'inside'): Promise<Buffer> {
    if (!this.started) {
      await this.start()
    }

    return await this.globalGate.run(async () => {
      if (this.plan.mode === 'in-process') {
        return await runOgRenderTask({ buffer, fit })
      }
      return await this.dispatch<Buffer>(id => ({
        type: 'og',
        id,
        input: { buffer, fit },
      }))
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true

    if (this.plan.mode === 'in-process') {
      sharp.concurrency(this.previousSharpConcurrency)
      return
    }

    const exits = this.workers.map((slot) => {
      if (slot.exited) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          if (!slot.exited) {
            slot.child.kill('SIGKILL')
          }
          resolve()
        }, 2000)

        slot.child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })

        try {
          slot.child.send({ type: 'shutdown' } satisfies CpuWorkerRequest)
        }
        catch {
          clearTimeout(killTimer)
          resolve()
        }
      })
    })

    await Promise.all(exits)
    this.workers.length = 0
  }
}
