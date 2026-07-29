import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import process from 'node:process';

const [binaryPath, archivePath, target, assetName, outputPath] = process.argv.slice(2);
if (![binaryPath, archivePath, target, assetName, outputPath].every(Boolean)) {
  throw new Error('usage: azdo-helper-metadata <binary> <archive> <target> <asset-name> <output>');
}

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const run = promisify(execFile);
const { stdout } = await run(binaryPath, ['version', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024,
  windowsHide: true,
});
let version;
try {
  version = JSON.parse(stdout);
} catch {
  throw new Error('helper version command returned invalid JSON');
}
if (
  typeof version.version !== 'string'
  || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.version)
  || !Number.isSafeInteger(version.protocol_version)
  || version.protocol_version < 1
) {
  throw new Error('helper version command returned invalid version metadata');
}
const archive = await stat(archivePath);
await writeFile(outputPath, `${JSON.stringify({
  helper_version: version.version,
  protocol_version: version.protocol_version,
  target,
  name: assetName,
  archive_sha256: await sha256(archivePath),
  binary_sha256: await sha256(binaryPath),
  size: archive.size,
}, null, 2)}\n`);
