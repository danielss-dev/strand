import { readFile } from 'node:fs/promises';
import process from 'node:process';

const [manifestPath, metadataPath] = process.argv.slice(2);
if (!manifestPath || !metadataPath) {
  throw new Error('usage: check-azdo-helper-metadata <manifest> <metadata>');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (
  manifest.strand_version !== metadata.helper_version
  || manifest.protocol_version !== metadata.protocol_version
) {
  throw new Error('published helper version contract does not match the downloaded binary');
}
const asset = manifest.assets?.find((candidate) => candidate.target === metadata.target);
if (!asset) throw new Error(`published helper manifest has no ${metadata.target} asset`);
const { helper_version: _helperVersion, protocol_version: _protocolVersion, ...expected } = metadata;
if (JSON.stringify(asset) !== JSON.stringify(expected)) {
  throw new Error('published helper asset metadata does not match the downloaded archive');
}
console.log(
  `Published strand-azdo ${metadata.helper_version} protocol ${metadata.protocol_version} `
  + `matches ${metadata.target}.`,
);
