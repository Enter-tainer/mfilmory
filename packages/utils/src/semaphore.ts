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

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--
      return this.createReleaser()
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.permits--
        resolve(this.createReleaser())
      })
    })
  }

  private release(): void {
    this.permits++
    const next = this.queue.shift()
    if (next) {
      next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    }
    finally {
      release()
    }
  }
}
