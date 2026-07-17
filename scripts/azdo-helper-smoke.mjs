import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

const [manifestPath, assetPath, binaryPath, target, versionPath] = process.argv.slice(2);
if (![manifestPath, assetPath, binaryPath, target, versionPath].every(Boolean)) {
  throw new Error('usage: azdo-helper-smoke <manifest> <asset> <binary> <target> <version-json>');
}
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const version = JSON.parse(await readFile(versionPath, 'utf8'));
const asset = manifest.assets.find((entry) => entry.target === target);
if (!asset) throw new Error(`manifest is missing ${target}`);
if (asset.name !== assetPath.split(/[\\/]/).at(-1)) throw new Error('asset name mismatch');
if (asset.size !== (await stat(assetPath)).size) throw new Error('asset size mismatch');
if (asset.archive_sha256 !== await sha256(assetPath)) throw new Error('archive hash mismatch');
if (asset.binary_sha256 !== await sha256(binaryPath)) throw new Error('binary hash mismatch');
if (manifest.strand_version !== version.version || manifest.protocol_version !== version.protocol_version) {
  throw new Error('helper version or protocol does not match the signed manifest');
}
