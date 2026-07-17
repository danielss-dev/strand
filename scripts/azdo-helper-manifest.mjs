import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [inputDir, outputPath] = process.argv.slice(2);
if (!inputDir || !outputPath) {
  throw new Error('usage: azdo-helper-manifest <metadata-directory> <output>');
}

async function findMetadata(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findMetadata(candidate));
    else if (entry.name.endsWith('.metadata.json')) found.push(candidate);
  }
  return found;
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const files = await findMetadata(inputDir);
if (files.length !== 3) throw new Error(`expected 3 helper assets, found ${files.length}`);
const assets = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
assets.sort((left, right) => left.target.localeCompare(right.target));
if (new Set(assets.map((asset) => asset.target)).size !== assets.length) {
  throw new Error('helper metadata contains duplicate targets');
}
await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  strand_version: packageJson.version,
  protocol_version: 1,
  assets,
}, null, 2)}\n`);
