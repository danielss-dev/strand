import { readFile } from 'node:fs/promises';
import process from 'node:process';

const manifest = await readFile(new URL('../crates/strand-azdo/Cargo.toml', import.meta.url), 'utf8');
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) {
  throw new Error('strand-azdo Cargo.toml has no explicit package version');
}
const tag = process.env.VERSION;
if (tag !== `strand-azdo-v${version}`) {
  throw new Error(
    `helper release tag ${tag ?? '(missing)'} does not match strand-azdo version ${version}`,
  );
}
