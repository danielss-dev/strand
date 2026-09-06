// Run from Tauri's beforeBuildCommand so the matching CLI is bundled on every
// desktop distribution route, including the separate MSIX layout.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const name = process.platform === 'win32' ? 'strand-cli.exe' : 'strand-cli';
const out = resolve('crates/strand-tauri/binaries');
mkdirSync(out, { recursive: true });
if (target === 'universal-apple-darwin') {
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  for (const t of targets) execFileSync('cargo', ['build', '-p', 'strand-headless', '--release', '--target', t], { stdio: 'inherit' });
  execFileSync('lipo', ['-create', ...targets.map(t => `target/${t}/release/${name}`), '-output', `${out}/${name}`], { stdio: 'inherit' });
} else {
  execFileSync('cargo', ['build', '-p', 'strand-headless', '--release', ...(target ? ['--target', target] : [])], { stdio: 'inherit' });
  copyFileSync(resolve('target', ...(target ? [target] : []), 'release', name), `${out}/${name}`);
}
if (process.platform === 'darwin' && process.env.APPLE_SIGNING_IDENTITY) {
  execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', process.env.APPLE_SIGNING_IDENTITY, `${out}/${name}`], { stdio: 'inherit' });
}
