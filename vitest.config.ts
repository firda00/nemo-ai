import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// .claude/worktrees contains full working copies of this repo; vitest CLI file
// arguments are substring filters, so without this exclude a run like
// `vitest run tests/foo.test.ts` also picks up every worktree duplicate.
export default defineConfig((configEnv) => mergeConfig(
  viteConfig(configEnv),
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, '**/.claude/**'],
    },
  }),
))
