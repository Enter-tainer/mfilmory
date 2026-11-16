function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error(typeof reason === 'string' ? reason : 'Semaphore wait aborted')
  error.name = 'AbortError'
  return error
}

export class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(permits: number) {
    this.permits = Number.isFinite(permits) ? Math.max(1, Math.floor(permits)) : 1
  }

  private createReleaser(): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.release()
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw toAbortError(signal.reason)
    }

    if (this.permits > 0) {
      this.permits--
      return this.createReleaser()
    }

    return new Promise<() => void>((resolve, reject) => {
      let active = true
      const onAbort = () => {
        if (!active) {
          return
        }
        active = false
        const index = this.queue.indexOf(grant)
        if (index !== -1) {
          this.queue.splice(index, 1)
        }
        reject(toAbortError(signal?.reason))
      }

      const grant = () => {
        if (!active) {
          return
        }
        active = false
        signal?.removeEventListener('abort', onAbort)
        this.permits--
        resolve(this.createReleaser())
      }

      this.queue.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private release(): void {
    this.permits++
    const next = this.queue.shift()
    if (next) {
      next()
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await fn()
    }
    finally {
      release()
    }
  }
}
