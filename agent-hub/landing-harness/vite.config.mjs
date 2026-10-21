import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
const root = process.cwd()
export default {
  root, envFile: false,
  plugins: [react(), { name: 'landing-offline-auth', enforce: 'pre', resolveId(source, importer) {
    if (importer && source.startsWith('.') && ['src/context/AuthContext', 'src/lib/supabase', 'src/lib/waitlist'].some(target => path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/') === path.join(root, target).replaceAll('\\', '/'))) return path.join(root, 'agent-hub/landing-harness/auth.ts')
  }, load(id) {
    if (id.replaceAll('\\', '/') === path.join(root, 'src/index.css').replaceAll('\\', '/')) return fs.readFileSync(id, 'utf8').replace(/^@import url\([^\n]+\);\r?\n/m, '')
  } }],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: { outDir: 'agent-hub/artifacts/astra-product-stage/build', rollupOptions: { input: path.join(root, 'agent-hub/landing-harness/index.html') } },
}
