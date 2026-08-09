import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildManifest } from './azdo-helper-manifest.mjs';

const targets = [
  'universal-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'strand-azdo-manifest-'));
  await Promise.all(targets.map((target, index) => writeFile(
    path.join(directory, `${target}.metadata.json`),
    JSON.stringify({
      helper_version: '1.2.1',
      protocol_version: 6,
      target,
      name: `strand-azdo-1.2.1-${target}.${target.includes('linux') ? 'tar.gz' : 'zip'}`,
      archive_sha256: `${index}`.repeat(64),
      binary_sha256: `${index + 1}`.repeat(64),
      size: index + 1,
      ...(overrides[target] ?? {}),
    }),
  )));
  return directory;
}

test('manifest derives one helper and protocol version from build metadata', async () => {
  const directory = await fixture();
  const output = path.join(directory, 'manifest.json');
  try {
    await buildManifest(directory, output);
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(manifest.strand_version, '1.2.1');
    assert.equal(manifest.protocol_version, 6);
    assert.equal(manifest.assets.length, 3);
    assert.ok(manifest.assets.every((asset) => !('helper_version' in asset)));
    assert.ok(manifest.assets.every((asset) => !('protocol_version' in asset)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest rejects protocol drift between platform builds', async () => {
  const directory = await fixture({
    'x86_64-pc-windows-msvc': { protocol_version: 4 },
  });
  try {
    await assert.rejects(
      buildManifest(directory, path.join(directory, 'manifest.json')),
      /different protocol versions/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
