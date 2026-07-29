import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

async function findMetadata(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findMetadata(candidate));
    else if (entry.name.endsWith('.metadata.json')) found.push(candidate);
  }
  return found;
}

export async function buildManifest(inputDir, outputPath) {
  const files = await findMetadata(inputDir);
  if (files.length !== 3) throw new Error(`expected 3 helper assets, found ${files.length}`);
  const metadata = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
  const helperVersions = new Set(metadata.map((asset) => asset.helper_version));
  const protocolVersions = new Set(metadata.map((asset) => asset.protocol_version));
  if (helperVersions.size !== 1) throw new Error('helper builds report different versions');
  if (protocolVersions.size !== 1) throw new Error('helper builds report different protocol versions');
  const [helperVersion] = helperVersions;
  const [protocolVersion] = protocolVersions;
  if (
    typeof helperVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(helperVersion)
    || !Number.isSafeInteger(protocolVersion)
    || protocolVersion < 1
  ) {
    throw new Error('helper metadata contains an invalid version contract');
  }
  const assets = metadata.map(({ helper_version, protocol_version, ...asset }) => asset);
  assets.sort((left, right) => left.target.localeCompare(right.target));
  if (new Set(assets.map((asset) => asset.target)).size !== assets.length) {
    throw new Error('helper metadata contains duplicate targets');
  }
  await writeFile(outputPath, `${JSON.stringify({
    schema_version: 1,
    // Schema v1 shipped this field name; existing Strand clients treat it as
    // the helper binary version, so keep it until a future schema migration.
    strand_version: helperVersion,
    protocol_version: protocolVersion,
    assets,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputDir, outputPath] = process.argv.slice(2);
  if (!inputDir || !outputPath) {
    throw new Error('usage: azdo-helper-manifest <metadata-directory> <output>');
  }
  await buildManifest(inputDir, outputPath);
}
