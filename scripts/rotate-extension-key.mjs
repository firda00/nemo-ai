import { generateKeyPairSync, createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const secretsPath = path.join(root, '.secrets.local')
const manifestPath = path.join(root, 'extension', 'manifest.json')
const localEnvPath = path.join(root, '.env.local')
const envExamplePath = path.join(root, '.env.example')
const extensionLinkPath = path.join(root, 'src', 'lib', 'extensionLink.ts')

if (!fs.existsSync(secretsPath)) throw new Error('.secrets.local is required for key rotation')

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim()
const publicDer = publicKey.export({ type: 'spki', format: 'der' })
const manifestKey = publicDer.toString('base64')
const extensionId = [...createHash('sha256').update(publicDer).digest().subarray(0, 16)]
  .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
  .join('')

const secrets = fs.readFileSync(secretsPath, 'utf8')
const privateKeyBegin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const privateKeyEnd = ['-----END', 'PRIVATE KEY-----'].join(' ')
const privateKeyPattern = new RegExp(
  `^NEMO_EXTENSION_PRIVATE_KEY=(?:"${privateKeyBegin}[\\s\\S]*?${privateKeyEnd}"|[^\\r\\n]*)`,
  'm',
)
if (!privateKeyPattern.test(secrets)) throw new Error('NEMO_EXTENSION_PRIVATE_KEY is missing')
fs.writeFileSync(secretsPath, secrets.replace(privateKeyPattern, `NEMO_EXTENSION_PRIVATE_KEY="${privatePem}"`), 'utf8')

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.key = manifestKey
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

if (fs.existsSync(localEnvPath)) {
  const env = fs.readFileSync(localEnvPath, 'utf8')
  const next = /^VITE_NEMO_EXTENSION_ID=.*$/m.test(env)
    ? env.replace(/^VITE_NEMO_EXTENSION_ID=.*$/m, `VITE_NEMO_EXTENSION_ID=${extensionId}`)
    : `${env.replace(/\s*$/, '')}\nVITE_NEMO_EXTENSION_ID=${extensionId}\n`
  fs.writeFileSync(localEnvPath, next, 'utf8')
}

const envExample = fs.readFileSync(envExamplePath, 'utf8')
fs.writeFileSync(
  envExamplePath,
  envExample.replace(/^VITE_NEMO_EXTENSION_ID=.*$/m, `VITE_NEMO_EXTENSION_ID=${extensionId}`),
  'utf8',
)
const extensionLink = fs.readFileSync(extensionLinkPath, 'utf8')
if (!/\?\? '[a-p]{32}'/.test(extensionLink)) throw new Error('Pinned extension id fallback is missing')
fs.writeFileSync(extensionLinkPath, extensionLink.replace(/\?\? '[a-p]{32}'/, `?? '${extensionId}'`), 'utf8')

console.log(`Extension signing key rotated. New public extension id: ${extensionId}`)
console.log('Private material was replaced in .secrets.local and was not printed.')
