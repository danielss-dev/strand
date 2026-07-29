import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const semver = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((argument) => !argument.startsWith('--'));
if (!target) {
  throw new Error('usage: node scripts/bump-azdo-version.mjs <version|major|minor|patch> [--dry-run]');
}

const manifestPath = join(repoRoot, 'crates/strand-azdo/Cargo.toml');
const manifest = readFileSync(manifestPath, 'utf8');
const current = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!current || !semver.test(current)) {
  throw new Error('strand-azdo Cargo.toml has no valid explicit package version');
}

function nextVersion(spec) {
  if (semver.test(spec)) return spec;
  const match = current.match(semver);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`"${spec}" is neither a semantic version nor major|minor|patch`);
}

const next = nextVersion(target);
const updatedManifest = manifest.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${next}"`,
);
const lockPath = join(repoRoot, 'Cargo.lock');
const lock = readFileSync(lockPath, 'utf8');
const lockPattern = /(name = "strand-azdo"\r?\nversion = ")[^"]*(")/;
if (!lockPattern.test(lock)) throw new Error('Cargo.lock has no strand-azdo package entry');
const updatedLock = lock.replace(lockPattern, `$1${next}$2`);

console.log(`Bumping strand-azdo ${current} -> ${next}${dryRun ? ' (dry run)' : ''}`);
if (!dryRun) {
  writeFileSync(manifestPath, updatedManifest);
  writeFileSync(lockPath, updatedLock);
}
console.log(`Next tag: strand-azdo-v${next}`);
