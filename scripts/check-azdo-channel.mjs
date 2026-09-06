import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = [
  'universal-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

// Availability gate only; the desktop still verifies the signature and hashes.
export async function checkChannel(protocol, fetchUrl = fetch) {
  const channel = `strand-azdo-protocol-${protocol}`;
  const base = `https://github.com/danielss-dev/strand/releases/download/${channel}`;
  async function request(name, method = 'HEAD') {
    const response = await fetchUrl(`${base}/${name}`, {
      method,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${channel}/${name}: HTTP ${response.status}. Publish or repair the signed helper channel before releasing Strand.`);
    }
    return response;
  }

  const manifest = await (await request('strand-azdo-manifest.json', 'GET')).json();
  if (manifest.schema_version !== 1 || manifest.protocol_version !== protocol
    || typeof manifest.strand_version !== 'string' || !manifest.strand_version.trim()
    || !Array.isArray(manifest.assets)) {
    throw new Error(`${channel}: manifest does not match the required helper protocol`);
  }
  const names = targets.map((target) => {
    const assets = manifest.assets.filter((asset) => asset.target === target);
    const extension = target.includes('linux') ? 'tar.gz' : 'zip';
    const name = `strand-azdo-${manifest.strand_version}-${target}.${extension}`;
    if (assets.length !== 1 || assets[0].name !== name || !/^[\w.+-]+$/.test(name)) {
      throw new Error(`${channel}: missing or invalid helper asset for ${target}`);
    }
    return name;
  });
  await request('strand-azdo-manifest.json.minisig');
  for (const name of names) await request(name);
  return channel;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = await readFile(new URL('../crates/strand-azdo-protocol/src/lib.rs', import.meta.url), 'utf8');
  const protocol = Number(source.match(/^pub const PROTOCOL_VERSION: u32 = (\d+);/m)?.[1]);
  if (!Number.isSafeInteger(protocol) || protocol < 1) throw new Error('Could not read the desktop helper protocol');
  console.log(`Helper channel available: ${await checkChannel(protocol)}`);
}
