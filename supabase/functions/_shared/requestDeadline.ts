// One shared request budget with a LAZY bound() contract (Codex-probed invariants):
//   • bound() takes a CALLBACK — an already-expired deadline refuses synchronously and the
//     work is never invoked;
//   • the race's timer is cleared in finally (no retained callbacks per chunk);
//   • expiry is re-checked AFTER the await — a promise that resolves past the deadline is
//     refused even when it beats the timer macrotask (busy microtasks beat timer macrotasks);
//   • abort() fires the shared AbortController; pass a signal-carrying fetch to the client so
//     in-flight network calls are actually CANCELLED, not merely out-raced.
// Throws Error('UPLOAD_TIMEOUT'-style) with the code given at construction.

export class Deadline {
  readonly at: number
  readonly controller = new AbortController()
  private readonly timeoutCode: string

  constructor(budgetMs: number, timeoutCode = 'UPLOAD_TIMEOUT') {
    this.at = Date.now() + budgetMs
    this.timeoutCode = timeoutCode
  }

  get expired(): boolean {
    return Date.now() >= this.at
  }

  async bound<T>(work: () => PromiseLike<T>): Promise<T> {
    if (this.expired) {
      this.controller.abort()
      throw new Error(this.timeoutCode)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.controller.abort()
            reject(new Error(this.timeoutCode))
          }, Math.max(1, this.at - Date.now()))
        }),
      ])
      if (this.expired) {
        this.controller.abort()
        throw new Error(this.timeoutCode)
      }
      return result
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
