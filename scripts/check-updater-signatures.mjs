import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

const config = JSON.parse(
  readFileSync('crates/strand-tauri/tauri.conf.json', 'utf8'),
);

function fail(message) {
  throw new Error(`updater signature check failed: ${message}`);
}

function minisignPacket(text, label) {
  const payload = text
    .split(/\r?\n/)
    .find((line) => line && !line.includes(':'));
  if (!payload) {
    fail(`${label} does not contain a minisign packet`);
  }

  const packet = Buffer.from(payload, 'base64');
  if (packet.length < 10) {
    fail(`${label} contains an invalid minisign packet`);
  }
  return packet;
}

function keyId(packet) {
  return Buffer.from(packet.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

function signatureFiles(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    fail(`path does not exist: ${path}`);
  }
  if (!statSync(absolutePath).isDirectory()) {
    return absolutePath.endsWith('.sig') ? [absolutePath] : [];
  }

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(absolutePath, entry.name);
    if (entry.isDirectory()) {
      return signatureFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.sig') ? [entryPath] : [];
  });
}

const publicKeyText = Buffer.from(
  config.plugins?.updater?.pubkey ?? '',
  'base64',
).toString('utf8');
const expectedKeyId = keyId(minisignPacket(publicKeyText, 'embedded updater public key'));
const files = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['target'])
  .flatMap(signatureFiles);

if (files.length === 0) {
  fail('no updater .sig artifacts were found');
}

for (const file of files) {
  const signedArtifact = file.slice(0, -'.sig'.length);
  if (!existsSync(signedArtifact)) {
    fail(`${file} has no matching signed artifact`);
  }

  const encodedSignature = readFileSync(file, 'utf8').trim();
  const signatureText = Buffer.from(encodedSignature, 'base64').toString('utf8');
  const actualKeyId = keyId(minisignPacket(signatureText, file));
  if (actualKeyId !== expectedKeyId) {
    fail(`${file} uses key ${actualKeyId}; expected ${expectedKeyId}`);
  }
}

console.log(
  `${files.length} updater signature artifact(s) use embedded key ${expectedKeyId}.`,
);
