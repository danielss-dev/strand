import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('crates/strand-tauri/tauri.conf.json', 'utf8'));
const capability = JSON.parse(
  readFileSync('crates/strand-tauri/capabilities/default.json', 'utf8'),
);
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');

function fail(message) {
  throw new Error(`release security check failed: ${message}`);
}

const expectedCsp = {
  'default-src': "'self' customprotocol: asset:",
  'base-uri': "'none'",
  'connect-src': 'ipc: http://ipc.localhost',
  'font-src': "'self' data:",
  'form-action': "'none'",
  'frame-src': "'none'",
  'img-src': "'self' asset: http://asset.localhost blob: data: https:",
  'object-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
};
if (JSON.stringify(config.app?.security?.csp) !== JSON.stringify(expectedCsp)) {
  fail('production CSP differs from the reviewed allowlist');
}

const expectedPermissions = [
  'core:app:allow-version',
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  'core:menu:allow-new',
  'core:menu:allow-set-as-app-menu',
  'core:window:allow-is-maximized',
  'core:window:allow-minimize',
  'core:window:allow-toggle-maximize',
  'core:window:allow-close',
  'core:window:allow-start-dragging',
  'core:webview:allow-set-webview-zoom',
  'dialog:allow-open',
  'dialog:allow-save',
  'notification:allow-is-permission-granted',
  'notification:allow-request-permission',
  'notification:allow-notify',
  'updater:allow-check',
  'updater:allow-download-and-install',
  'process:allow-restart',
  'sql:allow-load',
  'sql:allow-select',
  'sql:allow-execute',
  'shell:allow-open',
].sort();
const actualPermissions = [...(capability.permissions ?? [])].sort();
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions)) {
  fail('main-window capabilities differ from the reviewed least-privilege allowlist');
}
if (capability.remote != null || capability.local === false) {
  fail('main-window capabilities must remain local-only');
}

if (config.bundle?.createUpdaterArtifacts !== true) {
  fail('signed updater artifacts are disabled');
}
const updater = config.plugins?.updater;
if (
  updater?.endpoints?.length !== 1
  || updater.endpoints[0] !== 'https://github.com/danielss-dev/strand/releases/latest/download/latest.json'
) {
  fail('stable updater endpoint differs from the reviewed HTTPS release channel');
}
let publicKey;
try {
  publicKey = Buffer.from(updater?.pubkey ?? '', 'base64').toString('utf8');
} catch {
  fail('updater public key is not valid base64');
}
if (!publicKey.includes('minisign public key: 84FCBFD2A981CE5D')) {
  fail('updater public key is missing or unexpected');
}

const tagCheckout = 'ref: ${{ github.event.inputs.tag || github.ref }}';
if (releaseWorkflow.split(tagCheckout).length - 1 < 3) {
  fail('release jobs do not all check out the requested tag');
}
for (const fragment of [
  'id-token: write',
  'uses: sigstore/cosign-installer@v4.1.2',
  'cosign sign-blob --yes --bundle',
  'cosign verify-blob',
  '--certificate-identity "$IDENTITY"',
  "--certificate-oidc-issuer 'https://token.actions.githubusercontent.com'",
]) {
  if (!releaseWorkflow.includes(fragment)) {
    fail(`Linux Sigstore release policy is missing: ${fragment}`);
  }
}

console.log('Release CSP, capabilities, signed updater, tag checkout, and Linux Sigstore policies are valid.');
