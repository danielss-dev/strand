import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';

const [binaryPath, archivePath, target, assetName, outputPath] = process.argv.slice(2);
if (![binaryPath, archivePath, target, assetName, outputPath].every(Boolean)) {
  throw new Error('usage: azdo-helper-metadata <binary> <archive> <target> <asset-name> <output>');
}

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const archive = await stat(archivePath);
await writeFile(outputPath, `${JSON.stringify({
  target,
  name: assetName,
  archive_sha256: await sha256(archivePath),
  binary_sha256: await sha256(binaryPath),
  size: archive.size,
}, null, 2)}\n`);
