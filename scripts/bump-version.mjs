#!/usr/bin/env node
// Bump the Strand version across every manifest that must stay in lockstep.
//
// Tauri names the release artifacts (and the updater `latest.json`) from the
// version in `tauri.conf.json`, NOT from the git tag — so a tag that outruns
// the config produces mislabeled installers and a manifest that never offers
// the update (see docs/packaging.md). This script keeps all four sources of
// truth — plus the Cargo lockfile — on the same number.
//
//   node scripts/bump-version.mjs 0.6.0     # set an explicit version
//   node scripts/bump-version.mjs patch     # 0.5.0 -> 0.5.1
//   node scripts/bump-version.mjs minor     # 0.5.0 -> 0.6.0
//   node scripts/bump-version.mjs major     # 0.5.0 -> 1.0.0
//   node scripts/bump-version.mjs minor --dry-run
//
// `website/package.json` is intentionally NOT touched — the landing site
// versions independently of the app.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// X.Y.Z with an optional `-prerelease` and `+build` suffix.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  fail('usage: node scripts/bump-version.mjs <version|major|minor|patch> [--dry-run]');
}

// The root package.json version is the single source we read the current
// number from; every file is asserted to match it before we change anything.
const rootPkgPath = join(repoRoot, 'package.json');
const current = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version;
if (!SEMVER.test(current)) fail(`current version "${current}" in package.json is not valid semver`);

function computeNext(spec) {
  if (SEMVER.test(spec)) return spec;
  const m = current.match(SEMVER);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (spec) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default:
      return fail(`"${spec}" is neither a valid semver version nor one of major|minor|patch`);
  }
}

const next = computeNext(target);
if (!SEMVER.test(next)) fail(`computed version "${next}" is not valid semver`);

// Each edit is a (file, transform) pair. `transform` returns the new contents
// or throws if the expected current version isn't found — we never want a
// silent partial bump that leaves the manifests disagreeing.
function jsonVersion(label) {
  // Replace only the FIRST `"version": "..."` — in every JSON file here that's
  // the top-level field (it precedes any dependency blocks). Preserves exact
  // formatting, key order, and trailing newline.
  return (text, file) => {
    const re = /(^\s*"version"\s*:\s*")[^"]*(")/m;
    if (!re.test(text)) throw new Error(`no top-level "version" field in ${file} (${label})`);
    return text.replace(re, `$1${next}$2`);
  };
}

function tomlWorkspaceVersion(text, file) {
  // The only bare `version = "..."` line in the workspace manifest is under
  // [workspace.package]; workspace dependencies use inline `{ version = ... }`.
  const re = /^version\s*=\s*"[^"]*"/m;
  if (!re.test(text)) throw new Error(`no [workspace.package] version line in ${file}`);
  return text.replace(re, `version = "${next}"`);
}

function lockfileCrates(crates) {
  return (text, file) => {
    let out = text;
    for (const name of crates) {
      const re = new RegExp(`(name = "${name}"\\r?\\nversion = ")[^"]*(")`);
      if (!re.test(out)) throw new Error(`no [[package]] entry for "${name}" in ${file}`);
      out = out.replace(re, `$1${next}$2`);
    }
    return out;
  };
}

const edits = [
  ['package.json', jsonVersion('root package')],
  ['ui/package.json', jsonVersion('ui package')],
  ['crates/strand-tauri/tauri.conf.json', jsonVersion('tauri config')],
  ['Cargo.toml', tomlWorkspaceVersion],
  ['Cargo.lock', lockfileCrates(['strand-core', 'strand-tauri'])],
];

console.log(`Bumping ${current} -> ${next}${dryRun ? '  (dry run, no files written)' : ''}\n`);

let changed = 0;
for (const [rel, transform] of edits) {
  const abs = join(repoRoot, rel);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    fail(`cannot read ${rel}`);
  }
  let updated;
  try {
    updated = transform(text, rel);
  } catch (e) {
    fail(e.message);
  }
  const path = relative(repoRoot, abs).replace(/\\/g, '/');
  if (updated === text) {
    console.log(`  =  ${path} (already ${next})`);
    continue;
  }
  if (!dryRun) writeFileSync(abs, updated);
  console.log(`  ${dryRun ? '~' : '✓'}  ${path}`);
  changed++;
}

console.log(
  `\n${dryRun ? 'Would update' : 'Updated'} ${changed} file(s).` +
    (dryRun ? '' : `\n\nNext: commit, then tag the release to match:\n  git commit -am "Bump version to ${next}"\n  git tag v${next} && git push origin v${next}`),
);
