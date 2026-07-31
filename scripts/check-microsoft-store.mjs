import { readFileSync } from 'node:fs';

const mainConfig = JSON.parse(
  readFileSync('crates/strand-tauri/tauri.conf.json', 'utf8'),
);
const storeConfig = JSON.parse(
  readFileSync('crates/strand-tauri/tauri.microsoftstore.conf.json', 'utf8'),
);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const storeWorkflow = readFileSync(
  '.github/workflows/microsoft-store.yml',
  'utf8',
);
const submissionGuide = readFileSync(
  'docs/microsoft-store-submission.md',
  'utf8',
);
const privacyPolicy = readFileSync('website/docs/privacy.md', 'utf8');
const contentGuidelines = readFileSync(
  'website/docs/content-guidelines.md',
  'utf8',
);
const docsManifest = readFileSync('website/docs/manifest.json', 'utf8');
const websiteIndex = readFileSync('website/index.html', 'utf8');

function fail(message) {
  throw new Error(`Microsoft Store check failed: ${message}`);
}

function pngSize(path) {
  const bytes = readFileSync(path);
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) {
    fail(`${path} is not a PNG`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

if (mainConfig.version !== packageJson.version) {
  fail('Tauri and package.json versions differ');
}

const bundle = storeConfig.bundle;
if (JSON.stringify(bundle?.targets) !== JSON.stringify(['msi'])) {
  fail('Store flavor must build only the MSI target');
}
if (!bundle.publisher || bundle.publisher === mainConfig.productName) {
  fail('publisher must be present and differ from the product name');
}

const windows = bundle.windows;
if (
  windows?.webviewInstallMode?.type !== 'offlineInstaller'
  || windows.webviewInstallMode.silent !== true
) {
  fail('Store MSI must bundle the silent offline WebView2 installer');
}
if (windows.digestAlgorithm !== 'sha256' || !windows.timestampUrl) {
  fail('Store signing must use SHA-256 and a timestamp service');
}

if (mainConfig.bundle?.createUpdaterArtifacts !== true) {
  fail('Store flavor must retain signed Tauri updater artifacts');
}
const endpoint = mainConfig.plugins?.updater?.endpoints;
if (
  endpoint?.length !== 1
  || !endpoint[0].startsWith('https://')
) {
  fail('Store flavor must retain one HTTPS updater endpoint');
}

for (const fragment of [
  'ref: ${{ inputs.tag }}',
  'node scripts/check-release-version.mjs',
  'pnpm release:check-security',
  'pnpm store:check',
  'WINDOWS_CERTIFICATE_BASE64',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'prepare-microsoft-store-config.mjs',
  'verify-microsoft-store-package.ps1',
  'pnpm release:check-updater-signatures',
  'if: inputs.publish_asset',
  'gh release upload',
]) {
  if (!storeWorkflow.includes(fragment)) {
    fail(`Store workflow must retain ${JSON.stringify(fragment)}`);
  }
}
if (
  storeWorkflow.includes('gh release upload')
  && storeWorkflow.includes('--clobber')
) {
  fail('Store release assets must be immutable and cannot use --clobber');
}

if (!/live generative AI/i.test(submissionGuide)) {
  fail('submission guide must disclose live generative AI');
}
if (!/report inappropriate output/i.test(submissionGuide)) {
  fail('submission guide must explain how to report inappropriate AI output');
}
if (!/privacy/i.test(privacyPolicy)) {
  fail('privacy policy must remain present');
}
if (!/"file"\s*:\s*"privacy"/i.test(docsManifest)) {
  fail('documentation manifest must include the privacy page');
}
if (!/"file"\s*:\s*"content-guidelines"/i.test(docsManifest)) {
  fail('documentation manifest must include the content guidelines');
}
if (!/docs\/privacy\//i.test(websiteIndex)) {
  fail('website footer must link to the privacy policy');
}
if (!/docs\/content-guidelines\//i.test(websiteIndex)) {
  fail('website footer must link to the content guidelines');
}
if (
  !/report inappropriate content/i.test(contentGuidelines)
  || !/removed or\s+disabled/i.test(contentGuidelines)
) {
  fail('content guidelines must retain reporting and enforcement guidance');
}

for (const [path, expected] of [
  ['strand.png', 1254],
  ['crates/strand-tauri/icons/icon.png', 512],
  ['crates/strand-tauri/icons/StoreLogo.png', 50],
]) {
  const size = pngSize(path);
  if (size.width !== expected || size.height !== expected) {
    fail(`${path} must be ${expected}x${expected}, got ${size.width}x${size.height}`);
  }
}

for (const path of [
  'docs/microsoft-store-submission.md',
  'website/docs/privacy.md',
  'website/docs/content-guidelines.md',
]) {
  readFileSync(path);
}

const screenshots = [
  'docs/store-assets/01-review.png',
  'docs/store-assets/02-history.png',
  'docs/store-assets/03-settings.png',
  'docs/store-assets/04-work.png',
];
for (const path of screenshots) {
  const size = pngSize(path);
  if (size.width < 1366 || size.height < 768) {
    fail(`${path} is too small for a desktop Store listing`);
  }
}

console.log(
  `Microsoft Store configuration is valid for Strand ${packageJson.version}: `
  + 'MSI-only, offline WebView2, silent install, SHA-256 timestamping, '
  + 'signed release workflow and updater retained, privacy, user-content, and '
  + `AI disclosures present, and ${screenshots.length} listing screenshots present.`,
);
