import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error(
    'usage: node scripts/prepare-microsoft-store-config.mjs <source> <output>',
  );
}

const thumbprint = (process.env.WINDOWS_CERTIFICATE_THUMBPRINT ?? '')
  .replaceAll(/\s/g, '')
  .toUpperCase();
if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
  throw new Error(
    'WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 thumbprint',
  );
}

const config = JSON.parse(await readFile(sourcePath, 'utf8'));
config.bundle.windows.certificateThumbprint = thumbprint;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared Store signing config for certificate ${thumbprint}.`);
