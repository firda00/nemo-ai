// Content identity of the actual working-tree source, including uncommitted changes.
// Reads no environment/credential files and prints no source text, diff, or secrets.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const output = resolve(here, 'source-version.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('SOURCE_VERSION_GIT_FAILED');
  return result.stdout;
}
const splitPaths = value => value.split('\0').filter(Boolean);
const scope = {
  version: 1,
  tracked: 'All Git-tracked regular working-tree files, except the explicit exclusions below. Deleted tracked files remain as absent entries.',
  untracked: 'Nonignored source/config/assets under src, supabase, tests, scripts, public, docs, agent-hub, plus root source/config files with approved extensions.',
  bytes: 'SHA256 of exact working-tree bytes; no newline normalization. Git index content is not substituted for dirty files.',
  excluded: [
    'Environment and credential files: .env*, .secrets*, secrets.*, credentials.*, local-login.json, *.pem/key/p12/pfx/keystore, id_rsa/id_ed25519 and .npmrc/.netrc.',
    'Dependency, build, database and VCS directories: node_modules, .git, .next, dist, build, coverage, .vercel, .temp, .branches, .cache, .data.',
    'Generated evidence/output directories: artifacts, test-results, playwright-report, screenshots, recordings, attachments, logs.',
    'Generated files: source-version.json, *results.json, *report.json, migration-manifest.json, *.log/tgz/zip/7z/bak/tmp/tsbuildinfo and deploy/init-supabase.sql.',
    'Local Supabase copied migrations (canonical supabase/migrations source is included). Symlinks are never followed.',
    'Untracked files outside the declared source scope or approved extensions; ignored untracked files are not enumerated by Git.',
  ],
};
const sourceExtension = /\.(?:[cm]?[jt]sx?|json|jsonc|sql|toml|ya?ml|md|mdx|html?|css|scss|sass|less|ps1|psm1|sh|bash|py|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|xml|txt)$/i;
const sourceConfigName = /(?:^|\/)(?:\.gitignore|\.dockerignore|\.nvmrc|\.node-version|Dockerfile|Makefile)$/;
const untrackedRoots = /^(?:src|supabase|tests|scripts|public|docs|agent-hub)\//;
function exclusion(path) {
  const pieces = path.split('/');
  const name = pieces.at(-1);
  if (pieces.some(piece => /^(?:node_modules|\.git|\.next|dist|build|coverage|\.vercel|\.temp|\.branches|\.cache|\.data)$/i.test(piece))) return 'dependency-build-runtime';
  if (pieces.some(piece => /^(?:artifacts|test-results|playwright-report|screenshots|recordings|attachments|logs)$/i.test(piece))) return 'generated-output';
  if (/^(?:\.env(?:\..*)?|\.secrets?(?:\..*)?|secrets?(?:\..*)?|credentials?(?:\..*)?|local-login\.json|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|\.npmrc|\.netrc)$/i.test(name) || /\.env(?:\.|$)|\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return 'credential-file';
  if (/^(?:source-version\.json|.*results\.json|.*report\.json|migration-manifest\.json)$/i.test(name) || /\.(?:log|tgz|zip|7z|bak|tmp|tsbuildinfo)$/i.test(name)) return 'generated-file';
  if (path === 'deploy/init-supabase.sql' || path.startsWith('agent-hub/trial-booking-local/supabase/migrations/')) return 'generated-copy';
  return null;
}
export function snapshot() {
  const tracked = new Set(splitPaths(git('ls-files', '-z')));
  const untracked = splitPaths(git('ls-files', '--others', '--exclude-standard', '-z'));
  const dirty = new Set(splitPaths(git('diff', '--name-only', '-z', 'HEAD', '--')));
  const counts = {};
  const files = [];
  for (const path of [...new Set([...tracked, ...untracked])].sort()) {
    if (path.includes('..') && path.split('/').includes('..')) throw new Error('SOURCE_VERSION_UNSAFE_PATH');
    let reason = exclusion(path);
    if (!reason && !tracked.has(path) && !((sourceExtension.test(path) || sourceConfigName.test(path)) && (untrackedRoots.test(path) || !path.includes('/')))) reason = 'outside-untracked-scope';
    if (reason) { counts[reason] = (counts[reason] || 0) + 1; continue; }
    let stat;
    try { stat = lstatSync(resolve(root, path)); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('SOURCE_VERSION_READ_FAILED');
      if (tracked.has(path)) files.push({ path, state: 'absent', tracked: true, dirty: true });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { counts['nonregular-or-symlink'] = (counts['nonregular-or-symlink'] || 0) + 1; continue; }
    const bytes = readFileSync(resolve(root, path));
    files.push({ path, state: 'present', bytes: bytes.length, sha256: sha256(bytes), tracked: tracked.has(path), dirty: !tracked.has(path) || dirty.has(path) });
  }
  // Identity depends on source bytes/presence and scope, not timestamps or Git staging state.
  const canonicalFiles = files.map(({ path, state, bytes, sha256: hash }) => ({ path, state, ...(state === 'present' ? { bytes, sha256: hash } : {}) }));
  const sourceSha256 = sha256(JSON.stringify({ scope, files: canonicalFiles }));
  return { schema: 'nemo-working-source-v1', sourceSha256, git: { head: git('rev-parse', 'HEAD').trim(), branch: git('branch', '--show-current').trim() || '(detached)', includesUncommittedChanges: files.some(file => file.dirty) }, scope, excludedCounts: counts, files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const mode = process.argv[2];
if (mode && mode !== '--verify') throw new Error('Use no argument to write source-version.json, or --verify to check it.');
const manifest = snapshot();
if (mode === '--verify') {
  const previous = JSON.parse(readFileSync(output, 'utf8'));
  if (previous.sourceSha256 !== manifest.sourceSha256) throw new Error('SOURCE_VERSION_CHANGED: regenerate the manifest and rerun affected verification.');
} else writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: mode === '--verify' ? 'verified' : 'written', sourceSha256: manifest.sourceSha256, files: manifest.files.length, changedOrUntracked: manifest.files.filter(file => file.dirty).length, manifest: 'agent-hub/trial-booking-local/source-version.json' }));
}
