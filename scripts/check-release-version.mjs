import { readFile } from 'node:fs/promises';
import process from 'node:process';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.VERSION;
if (tag !== `v${packageJson.version}`) {
  throw new Error(`release tag ${tag ?? '(missing)'} does not match package version v${packageJson.version}`);
}
