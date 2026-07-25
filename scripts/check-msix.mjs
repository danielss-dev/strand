import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = readFileSync('packaging/msix/AppxManifest.xml.in', 'utf8');
const buildScript = readFileSync('scripts/build-msix.ps1', 'utf8');
const workflow = readFileSync(
  '.github/workflows/microsoft-store-msix.yml',
  'utf8',
);
const app = readFileSync('ui/src/App.tsx', 'utf8');
const updatesStore = readFileSync('ui/src/stores/updates.ts', 'utf8');
const updatesSection = readFileSync(
  'ui/src/views/settings/UpdatesSection.tsx',
  'utf8',
);

function fail(message) {
  throw new Error(`MSIX check failed: ${message}`);
}

function pngSize(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    fail(`${path} is not a PNG`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

for (const fragment of [
  'uap10:RuntimeBehavior="packagedClassicApp"',
  'uap10:TrustLevel="mediumIL"',
  '<rescap:Capability Name="runFullTrust" />',
  'ProcessorArchitecture="x64"',
  'MinVersion="10.0.22000.0"',
  'Executable="strand.exe"',
]) {
  if (!manifest.includes(fragment)) {
    fail(`manifest must retain ${JSON.stringify(fragment)}`);
  }
}

for (const placeholder of [
  '__IDENTITY_NAME__',
  '__PUBLISHER__',
  '__PUBLISHER_DISPLAY_NAME__',
  '__VERSION__',
]) {
  if (!manifest.includes(placeholder)) {
    fail(`manifest must retain ${placeholder}`);
  }
}

for (const fragment of [
  "VITE_DISTRIBUTION = 'msix'",
  'build --no-bundle --ci',
  'MakeAppx.exe',
  "ChangeExtension($OutputPath, '.msixupload')",
  'StoreSubmission requires the exact Partner Center package Identity Name',
  'StoreSubmission requires the exact Partner Center Publisher ID',
]) {
  if (!buildScript.includes(fragment)) {
    fail(`build script must retain ${JSON.stringify(fragment)}`);
  }
}

if (!updatesStore.includes('UPDATES_MANAGED_BY_STORE')) {
  fail('update store must recognize Store-managed MSIX updates');
}
if (!app.includes('if (!isTauri() || UPDATES_MANAGED_BY_STORE) return;')) {
  fail('launch auto-update check must be disabled for MSIX');
}
if (!updatesSection.includes("t('updates.managedByStore')")) {
  fail('Updates settings must explain Store-managed updates');
}

for (const fragment of [
  'identity_name:',
  'publisher:',
  'publisher_display_name:',
  '-StoreSubmission',
  'target/msix/dist/*.msixupload',
]) {
  if (!workflow.includes(fragment)) {
    fail(`Store workflow must retain ${JSON.stringify(fragment)}`);
  }
}

for (const [path, expected] of [
  ['crates/strand-tauri/icons/StoreLogo.png', 50],
  ['crates/strand-tauri/icons/Square150x150Logo.png', 150],
  ['crates/strand-tauri/icons/Square44x44Logo.png', 44],
]) {
  const size = pngSize(path);
  if (size.width !== expected || size.height !== expected) {
    fail(`${path} must be ${expected}x${expected}, got ${size.width}x${size.height}`);
  }
}

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  fail(`package version must map to an MSIX quad, got ${packageJson.version}`);
}

console.log(
  `MSIX packaging policy is valid for Strand ${packageJson.version}: `
  + 'x64 packaged-classic full trust, Windows 11 minimum, parameterized '
  + 'Partner Center identity, validated assets, and Store-managed updates.',
);
