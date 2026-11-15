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
  signal?: AbortSignal
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
  uvSize: number
  respawns: number
  activeTasks: number
  ready: boolean
  exited: boolean
  clearStartupTimer?: () => void
  rejectStartup?: (error: Error) => void
  pending: Map<number, PendingRequest<unknown>>
}

function hasTsLoader(): boolean {
  if ('bun' in process.versions) {
    return true
  }
  const tsLoaderPattern = /tsx|ts-node|loader|register|import/i
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  return process.execArgv.some(arg => tsLoaderPattern.test(arg)) || tsLoaderPattern.test(nodeOptions)
}

function resolveWorkerScriptPath(): string | null {
  const isCompiledModule = import.meta.url.endsWith('.mjs') || import.meta.url.endsWith('.js')
  const candidates = isCompiledModule
    ? ['./cpu-worker.mjs', './cpu-worker.js', '../cpu-worker.mjs', './worker/cpu-worker.mjs']
    : hasTsLoader()
      ? ['./cpu-worker.ts', './cpu-worker.mjs', './cpu-worker.js']
      : ['./cpu-worker.mjs', './cpu-worker.js']

  for (const candidate of candidates) {
    const resolvedPath = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(resolvedPath)) {
      return resolvedPath
    }
  }
  return null
}

export function hasCpuWorkerScript(): boolean {
  return resolveWorkerScriptPath() !== null
}

function filterChildExecArgv(execArgv: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (
      arg === '-e'
      || arg === '--eval'
      || arg === '-p'
      || arg === '--print'
      || arg === '--watch-path'
      || arg === '--input-type'
    ) {
      i++
      continue
    }
    if (arg === '--inspect-port') {
      if (i + 1 < execArgv.length && !execArgv[i + 1].startsWith('-')) {
        i++
      }
      continue
    }
    if (
      arg.startsWith('--eval=')
      || arg.startsWith('--print=')
      || arg.startsWith('--inspect')
      || arg.startsWith('--input-type=')
      || arg === '--watch'
      || arg.startsWith('--watch-path=')
      || arg === '--test'
      || arg.startsWith('--test-')
    ) {
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
    = typeof config.sharpConcurrency === 'number' && Number.isFinite(config.sharpConcurrency) && config.sharpConcurrency > 0
      ? Math.max(1, Math.floor(config.sharpConcurrency))
      : effectiveTasks >= cores
        ? 1
        : Math.min(4, Math.max(1, Math.floor(cores / effectiveTasks)))

  const requestedSlots
    = typeof config.cpuConcurrency === 'number' && Number.isFinite(config.cpuConcurrency) && config.cpuConcurrency > 0
      ? Math.max(1, Math.floor(config.cpuConcurrency))
      : Math.max(1, Math.floor(cores / sharpConc))

  const cpuSlots = Math.max(1, Math.min(effectiveTasks, requestedSlots))

  let workerCount: number
  if (!hasWorkerScript || config.cpuWorkerCount === 0) {
    workerCount = 0
  }
  else if (typeof config.cpuWorkerCount === 'number' && Number.isFinite(config.cpuWorkerCount) && config.cpuWorkerCount > 0) {
    workerCount = Math.min(cpuSlots, Math.max(1, Math.floor(config.cpuWorkerCount)))
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
      = typeof config.sharpConcurrency === 'number' && Number.isFinite(config.sharpConcurrency) && config.sharpConcurrency > 0
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
  private readonly capacityWaiters: Array<{ resolve: () => void, reject: (error: Error) => void }> = []
  private readonly previousSharpConcurrency: number
  private readonly execArgv: string[]
  private readonly signal?: AbortSignal
  private readonly onSignalAbort?: () => void
  private readonly onProcessExit: () => void
  private nextRequestId = 1
  private respawningWorkers = 0
  private startPromise: Promise<void> | null = null
  private started = false
  private closed = false
  private aborted = false
  private processExitRegistered = false

  constructor(config: CpuPoolConfig) {
    this.workerScriptPath = resolveWorkerScriptPath()
    this.plan = resolveCpuPlan(config, this.workerScriptPath !== null)
    this.globalGate = new Semaphore(this.plan.cpuSlots)
    this.previousSharpConcurrency = sharp.concurrency()
    this.execArgv = filterChildExecArgv(process.execArgv)
    this.signal = config.signal
    this.aborted = Boolean(config.signal?.aborted)
    if (config.signal && !config.signal.aborted) {
      this.onSignalAbort = () => {
        this.aborted = true
      }
      config.signal.addEventListener('abort', this.onSignalAbort, { once: true })
    }
    this.onProcessExit = () => {
      this.killAllWorkersSync()
    }
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('CpuPool has been closed')
    }
    if (this.aborted || this.signal?.aborted) {
      this.aborted = true
      const reason = this.signal?.reason
      throw reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : 'CpuPool aborted')
    }
    if (this.started) {
      return
    }
    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = (async () => {
      if (this.plan.mode === 'in-process' || !this.workerScriptPath) {
        sharp.concurrency(this.plan.sharpConcurrency)
        sharp.cache({ memory: 50, files: 0, items: 50 })
        this.started = true
        return
      }

      if (!this.processExitRegistered) {
        process.once('exit', this.onProcessExit)
        this.processExitRegistered = true
      }

      const { workerCount, cpuSlots, sharpConcurrency } = this.plan
      const baseSlots = Math.floor(cpuSlots / workerCount)
      const remainder = cpuSlots % workerCount

      const readyPromises: Array<Promise<void>> = []
      for (let i = 0; i < workerCount; i++) {
        const workerId = i + 1
        const slotsForWorker = baseSlots + (i < remainder ? 1 : 0)
        const uvSize = Math.max(2, slotsForWorker + 1)
        readyPromises.push(this.spawnWorker(workerId, slotsForWorker, uvSize, sharpConcurrency, 0))
      }

      try {
        await Promise.all(readyPromises)
        if (this.closed) {
          throw new Error('CpuPool closed during startup')
        }
        this.started = true
      }
      catch (error) {
        this.terminateAllWorkersNow(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()

    try {
      await this.startPromise
    }
    catch (error) {
      this.startPromise = null
      throw error
    }
  }

  private spawnWorker(
    workerId: number,
    maxSlots: number,
    uvSize: number,
    sharpConcurrency: number,
    respawns: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.workerScriptPath) {
        reject(new Error('CpuPool has been closed'))
        return
      }

      const child = fork(this.workerScriptPath, [], {
        execArgv: this.execArgv,
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
        uvSize,
        respawns,
        activeTasks: 0,
        ready: false,
        exited: false,
        pending: new Map(),
      }
      this.workers.push(slot)

      let settled = false
      const startupTimer = setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGKILL')
          }
          catch {
            // ignore kill error
          }
          markSlotDead(new Error(`CPU worker ${workerId} 启动超时`), false)
        }
      }, 15_000)

      const clearStartupTimer = () => {
        clearTimeout(startupTimer)
        slot.clearStartupTimer = undefined
      }
      slot.clearStartupTimer = clearStartupTimer
      slot.rejectStartup = (err: Error) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      }

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text) {
          logger.main.warn(`[CPU-WORKER-${workerId}] ${text}`)
        }
      })

      const markSlotDead = (reason: Error, allowRespawn: boolean) => {
        if (slot.exited) {
          this.failSlotPending(slot, reason)
          return
        }
        const wasReady = slot.ready
        slot.exited = true
        slot.ready = false
        clearStartupTimer()
        slot.rejectStartup?.(reason)
        slot.rejectStartup = undefined
        this.failSlotPending(slot, reason)

        if (allowRespawn && wasReady && !this.aborted && !this.closed && this.started && slot.respawns < 2) {
          void this.tryRespawnWorker(slot)
        }
        else {
          this.drainCapacityWaiters()
        }
      }

      child.on('message', (raw: CpuWorkerResponse) => {
        if (raw.type === 'ready') {
          if (!settled) {
            settled = true
            slot.ready = true
            slot.rejectStartup = undefined
            clearStartupTimer()
            this.drainCapacityWaiters()
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
        this.drainCapacityWaiters()

        if (raw.type === 'error') {
          pending.reject(new Error(raw.message))
          return
        }

        try {
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
        }
        catch (err) {
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      })

      child.on('error', (error) => {
        markSlotDead(error instanceof Error ? error : new Error(String(error)), false)
      })

      child.on('disconnect', () => {
        markSlotDead(new Error(`CPU worker ${workerId} disconnected`), !this.closed)
      })

      child.on('exit', (code, signal) => {
        const reason = new Error(`CPU worker ${workerId} exited (code=${code}, signal=${signal})`)
        markSlotDead(reason, !this.closed && (code !== 0 || signal !== null))
      })
    })
  }

  private async tryRespawnWorker(deadSlot: WorkerSlot): Promise<void> {
    if (this.closed || this.aborted) {
      return
    }
    this.respawningWorkers++
    try {
      logger.main.warn(`CPU worker ${deadSlot.id} 异常退出，尝试拉起替代子进程 (${deadSlot.respawns + 1}/2)`)
      await this.spawnWorker(
        deadSlot.id,
        deadSlot.maxSlots,
        deadSlot.uvSize,
        this.plan.sharpConcurrency,
        deadSlot.respawns + 1,
      )
    }
    catch (error) {
      logger.main.warn(`CPU worker ${deadSlot.id} 重启失败`, error)
    }
    finally {
      this.respawningWorkers = Math.max(0, this.respawningWorkers - 1)
      this.drainCapacityWaiters()
    }
  }

  private failSlotPending(slot: WorkerSlot, error: Error): void {
    for (const [id, pending] of slot.pending) {
      slot.pending.delete(id)
      pending.reject(error)
    }
    slot.activeTasks = 0
  }

  private killAllWorkersSync(): void {
    for (const slot of this.workers) {
      if (slot.exited) {
        continue
      }
      slot.exited = true
      slot.ready = false
      try {
        slot.child.kill('SIGKILL')
      }
      catch {
        // ignore kill error
      }
    }
  }

  private terminateAllWorkersNow(reason = new Error('CpuPool terminated')): void {
    for (const slot of this.workers) {
      slot.clearStartupTimer?.()
      slot.rejectStartup?.(reason)
      slot.rejectStartup = undefined
      this.failSlotPending(slot, reason)
    }
    this.killAllWorkersSync()
    this.workers.length = 0
  }

  private drainCapacityWaiters(): void {
    while (this.capacityWaiters.length > 0) {
      const alive = this.workers.filter(w => w.ready && !w.exited && w.child.connected)
      if (alive.some(w => w.activeTasks < w.maxSlots)) {
        const waiter = this.capacityWaiters.shift()
        waiter?.resolve()
        continue
      }
      if (alive.length === 0 && this.respawningWorkers === 0) {
        this.failCapacityWaiters(new Error('没有可用的 CPU worker 进程'))
      }
      break
    }
  }

  private failCapacityWaiters(error: Error): void {
    while (this.capacityWaiters.length > 0) {
      const waiter = this.capacityWaiters.shift()
      waiter?.reject(error)
    }
  }

  private async pickAvailableWorker(): Promise<WorkerSlot> {
    while (true) {
      if (this.closed) {
        throw new Error('CpuPool has been closed')
      }

      const alive = this.workers.filter(w => w.ready && !w.exited && w.child.connected)
      const withCapacity = alive.filter(w => w.activeTasks < w.maxSlots)

      if (withCapacity.length > 0) {
        let best = withCapacity[0]
        for (let i = 1; i < withCapacity.length; i++) {
          const candidate = withCapacity[i]
          if (candidate.activeTasks / candidate.maxSlots < best.activeTasks / best.maxSlots) {
            best = candidate
          }
        }
        return best
      }

      if (alive.length === 0 && this.respawningWorkers === 0) {
        throw new Error('没有可用的 CPU worker 进程')
      }

      await new Promise<void>((resolve, reject) => {
        this.capacityWaiters.push({ resolve, reject })
      })
    }
  }

  private async dispatch<T>(buildRequest: (id: number) => CpuWorkerRequest): Promise<T> {
    const slot = await this.pickAvailableWorker()
    const id = this.nextRequestId++
    slot.activeTasks++

    return await new Promise<T>((resolve, reject) => {
      slot.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })

      const cleanupSendFailure = (err: Error) => {
        if (slot.pending.delete(id)) {
          slot.activeTasks = Math.max(0, slot.activeTasks - 1)
          this.drainCapacityWaiters()
          reject(err)
        }
      }

      try {
        if (!slot.child.connected) {
          cleanupSendFailure(new Error(`CPU worker ${slot.id} IPC channel is disconnected`))
          return
        }
        const accepted = slot.child.send(buildRequest(id), undefined, undefined, (sendErr) => {
          if (sendErr) {
            cleanupSendFailure(sendErr)
          }
        })
        if (!accepted && !slot.child.connected) {
          cleanupSendFailure(new Error(`CPU worker ${slot.id} IPC channel closed on send`))
        }
      }
      catch (error) {
        cleanupSendFailure(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async runPhotoTask(input: CpuPhotoTaskInput): Promise<CpuPhotoTaskOutput> {
    if (this.closed) {
      throw new Error('CpuPool has been closed')
    }
    if (!this.started) {
      await this.start()
    }

    return await this.globalGate.run(async () => {
      if (this.closed) {
        throw new Error('CpuPool has been closed')
      }
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
    if (this.closed) {
      throw new Error('CpuPool has been closed')
    }
    if (!this.started) {
      await this.start()
    }

    return await this.globalGate.run(async () => {
      if (this.closed) {
        throw new Error('CpuPool has been closed')
      }
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
    if (this.signal && this.onSignalAbort) {
      this.signal.removeEventListener('abort', this.onSignalAbort)
    }
    this.failCapacityWaiters(new Error('CpuPool has been closed'))

    if (this.startPromise) {
      if (!this.started) {
        this.terminateAllWorkersNow(new Error('CpuPool closed during startup'))
      }
      await this.startPromise.catch(() => {})
    }

    try {
      if (this.plan.mode === 'in-process') {
        sharp.concurrency(this.previousSharpConcurrency)
        return
      }

      const exits = this.workers.map((slot) => {
        if (slot.exited) {
          this.failSlotPending(slot, new Error('CpuPool closed'))
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
            if (slot.child.connected) {
              slot.child.send({ type: 'shutdown' } satisfies CpuWorkerRequest)
            }
            else {
              clearTimeout(killTimer)
              slot.child.kill('SIGKILL')
              resolve()
            }
          }
          catch {
            clearTimeout(killTimer)
            try {
              slot.child.kill('SIGKILL')
            }
            catch {
              // ignore kill error
            }
            resolve()
          }
        })
      })

      await Promise.all(exits)
      this.workers.length = 0
    }
    finally {
      if (this.processExitRegistered) {
        process.off('exit', this.onProcessExit)
        this.processExitRegistered = false
      }
    }
  }
}
