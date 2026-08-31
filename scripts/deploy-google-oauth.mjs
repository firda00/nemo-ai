import { spawnSync } from 'node:child_process'

if (!process.env.SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is required. The script never prints or persists it.')
  process.exit(1)
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const args = ['supabase', 'functions', 'deploy', 'google-oauth', '--no-verify-jwt']
if (process.env.SUPABASE_PROJECT_REF) args.push('--project-ref', process.env.SUPABASE_PROJECT_REF)

const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })
if (result.error) {
  console.error(`Could not start Supabase CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
