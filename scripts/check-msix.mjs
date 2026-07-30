import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = readFileSync('packaging/msix/AppxManifest.xml.in', 'utf8');
const buildScript = readFileSync('scripts/build-msix.ps1', 'utf8');
const iconScript = readFileSync('scripts/generate-msix-icons.ps1', 'utf8');
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

const targetSizes = [
  16, 20, 24, 30, 32, 36, 40, 44,
  48, 60, 64, 72, 80, 96, 256,
];
for (const targetSize of targetSizes) {
  for (const alternateForm of ['unplated', 'lightunplated']) {
    const path = 'crates/strand-tauri/icons/'
      + `Square44x44Logo.targetsize-${targetSize}_altform-${alternateForm}.png`;
    const size = pngSize(path);
    if (size.width !== targetSize || size.height !== targetSize) {
      fail(`${path} must be ${targetSize}x${targetSize}, `
        + `got ${size.width}x${size.height}`);
    }
  }
}

for (const fragment of [
  'HighQualityBicubic',
  "('unplated', 'lightunplated')",
  '16, 20, 24, 30, 32, 36, 40, 44, 48, 60, 64, 72, 80, 96, 256',
  'Square44x44Logo.targetsize-$($targetSize)_altform-$alternateForm.png',
]) {
  const normalizedFragment = fragment.replace(/\s+/g, ' ');
  const normalizedIconScript = iconScript.replace(/\s+/g, ' ');
  const normalizedBuildScript = buildScript.replace(/\s+/g, ' ');
  if (!normalizedIconScript.includes(normalizedFragment)) {
    fail(`MSIX icon generator must retain ${JSON.stringify(fragment)}`);
  }
  if (
    fragment !== 'HighQualityBicubic'
    && !normalizedBuildScript.includes(normalizedFragment)
  ) {
    fail(`MSIX build must retain ${JSON.stringify(fragment)}`);
  }
}

if (!updatesStore.includes('UPDATES_MANAGED_BY_STORE')) {
  fail('update store must recognize Store-managed MSIX updates');
}
if (!app.includes('if (!UPDATES_MANAGED_BY_STORE && !updateAutoCheck) return;')) {
  fail('launch update check must always run for MSIX');
}
if (!updatesStore.includes('microsoftStoreUpdateAvailable')) {
  fail('update store must query Microsoft Store for MSIX updates');
}
if (!updatesSection.includes("t('updates.openStore')")) {
  fail('Updates settings must hand available Store updates to Microsoft Store');
}

for (const fragment of [
  'release:',
  'types: [published]',
  'MSIX_IDENTITY_NAME: Danielss.strand',
  'MSIX_PUBLISHER: CN=7BDB5F20-9C38-41B0-82F1-799F0AFDF699',
  'MSIX_PUBLISHER_DISPLAY_NAME: Danielss',
  'MS_STORE_PRODUCT_ID: 9N0JG96LRC4W',
  '-StoreSubmission',
  'target/msix/dist/*.msixupload',
  'microsoft/microsoft-store-apppublisher@v1.1',
  'AZURE_AD_APPLICATION_CLIENT_ID',
  'AZURE_AD_APPLICATION_SECRET',
  'AZURE_AD_TENANT_ID',
  'SELLER_ID',
  'msstore publish',
  'environment: microsoft-store-production',
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
  + 'Partner Center identity, DPI-tailored unplated assets, Store-managed '
  + 'updates, and '
  + 'GitHub-to-Partner-Center release submission.',
);
