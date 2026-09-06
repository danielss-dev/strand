import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChannel } from './check-azdo-channel.mjs';

function fixture({ status = {}, protocol = 7, omitTarget } = {}) {
  const calls = [];
  const manifest = {
    schema_version: 1,
    strand_version: '1.3.0',
    protocol_version: protocol,
    assets: ['universal-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']
      .filter((target) => target !== omitTarget)
      .map((target) => ({
        target,
        name: `strand-azdo-1.3.0-${target}.${target.includes('linux') ? 'tar.gz' : 'zip'}`,
      })),
  };
  return {
    calls,
    fetchUrl: async (url, options) => {
      calls.push({ url, method: options.method });
      const name = url.split('/').at(-1);
      return new Response(options.method === 'GET' ? JSON.stringify(manifest) : null, {
        status: status[name] ?? 200,
      });
    },
  };
}

test('desktop release requires its public manifest, signature and all three platform archives', async () => {
  const { fetchUrl, calls } = fixture();
  assert.equal(await checkChannel(7, fetchUrl), 'strand-azdo-protocol-7');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ url }) => url.startsWith('https://github.com/danielss-dev/strand/releases/download/strand-azdo-protocol-7/')));
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'HEAD', 'HEAD', 'HEAD', 'HEAD']);
});

test('unpublished protocol fails with a release instruction and never falls back to an older channel', async () => {
  const { fetchUrl, calls } = fixture({ status: { 'strand-azdo-manifest.json': 404 } });
  await assert.rejects(checkChannel(7, fetchUrl), /protocol-7.*HTTP 404.*Publish or repair/);
  assert.equal(calls.length, 1);
});

test('an older protocol manifest cannot satisfy the release gate', async () => {
  const { fetchUrl } = fixture({ protocol: 5 });
  await assert.rejects(checkChannel(7, fetchUrl), /does not match/);
});

test('a missing platform fails even if the other platforms were published', async () => {
  const { fetchUrl } = fixture({ omitTarget: 'x86_64-pc-windows-msvc' });
  await assert.rejects(checkChannel(7, fetchUrl), /missing or invalid.*x86_64-pc-windows-msvc/);
});

for (const name of ['strand-azdo-manifest.json.minisig', 'strand-azdo-1.3.0-x86_64-pc-windows-msvc.zip']) {
  test(`an incomplete release fails when ${name} is unavailable`, async () => {
    const { fetchUrl } = fixture({ status: { [name]: 404 } });
    await assert.rejects(checkChannel(7, fetchUrl), /HTTP 404.*Publish or repair/);
  });
}

test('server errors fail closed without treating them as a published channel', async () => {
  const { fetchUrl } = fixture({ status: { 'strand-azdo-manifest.json': 503 } });
  await assert.rejects(checkChannel(7, fetchUrl), /HTTP 503/);
});
