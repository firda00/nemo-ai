// Per-File run dedupe for chat cards. Three properties the review demanded, in one structure:
//   • identity is the File OBJECT itself (WeakMap key) — two different files that happen to
//     share a name and size can never collide, and a remounted chat (fresh turn ids) can never
//     resurrect a previous file's result;
//   • every entry is scoped to the caller's session/tenant: after an auth switch the same File
//     object is a MISS, so a cached result (signed URLs included) never crosses accounts;
//   • eviction is structural, not scheduled: a WeakMap entry lives exactly as long as the File
//     it belongs to. Chat state is what bounds that lifetime — SmartTaskDesk trims history
//     (slice(-8)) on every new user message and drops all turns on remount, so dropped Files
//     take their entries with them. There is no time-based eviction; that is the honest scope.
// Strict-Mode double effects pass the SAME File object, so the dedupe they need is preserved.
export interface FileRunCache<T> {
  getOrRun(file: File, scope: string, execute: () => Promise<T>): Promise<T>
}

/**
 * Session-generation scope: a plain user id is NOT enough — logout and login as the SAME user
 * must not resurrect the previous session's cached results. Every observed identity CHANGE
 * (including to signed-out) bumps a generation, so 'u1' → anon → 'u1' yields a fresh scope.
 */
export function createSessionScope(): (identity: string | null) => string {
  let lastIdentity: string | null | undefined
  let generation = 0
  return (identity) => {
    if (identity !== lastIdentity) { generation += 1; lastIdentity = identity }
    return `${identity ?? 'anon'}#${generation}`
  }
}

export function createFileRunCache<T>(): FileRunCache<T> {
  const runs = new WeakMap<File, { scope: string; run: Promise<T> }>()
  return {
    getOrRun(file, scope, execute) {
      const cached = runs.get(file)
      if (cached && cached.scope === scope) return cached.run
      const run = execute()
      runs.set(file, { scope, run })
      return run
    },
  }
}
