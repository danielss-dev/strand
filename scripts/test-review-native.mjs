#!/usr/bin/env node
// Windows integration gate: real React stores -> Tauri IPC -> disposable Git.
// Usage: node scripts/test-review-native.mjs [--repeat 2] [--output <directory>]
// Requires Node 22+, pnpm-installed frontend dependencies, Rust and WebView2.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The native review gate requires Windows/WebView2.');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const repeats = Number(option('--repeat', '2'));
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, '--repeat must be 1..10');
const output = resolve(option('--output', join(root, 'target', 'review-native', String(Date.now()))));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, 'fixture-'));
const identifier = `dev.danielss.strand.reviewtest.${Date.now()}.${process.pid}`;
const appDirs = [...new Set([process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean))]
  .map((base) => ({ base: resolve(base), path: resolve(base, identifier) }));
for (const { path } of appDirs) assert(!(await exists(path)), `Test identity already exists: ${path}`);
const emptyConfig = join(scratch, 'gitconfig');
await writeFile(emptyConfig, '');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' };
const children = new Set();
const checks = [];
let cdp;
let app;
let configuredBuild = false;
let failed = false;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  failed = true;
  cdp?.close();
  for (const child of [...children]) void stop(child);
});

async function exists(path) { return stat(path).then(() => true, () => false); }
async function log(message) {
  console.log(message);
  await appendFile(join(output, 'harness.log'), `${new Date().toISOString()} ${message}\n`);
}
function start(command, argv, name, extra = {}) {
  const child = spawn(command, argv, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  void appendFile(join(output, 'processes.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), name, pid: child.pid, command, argv, cwd: extra.cwd ?? root })}\n`);
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', (error) => { void log(`${name}: ${error.message}`); });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { void appendFile(join(output, `${name}.log`), chunk); });
  }
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Only PIDs obtained from this script's own spawn calls may be terminated.
  assert(children.has(child));
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  await once(killer, 'exit');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
async function run(command, argv, name, extra = {}) {
  const child = start(command, argv, name, extra);
  let stdout = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < 8 * 1024 * 1024) stdout += chunk; });
  const timer = setTimeout(() => { void stop(child); }, 20 * 60 * 1000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `${name} failed (${code}); see ${join(output, `${name}.log`)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
const git = (cwd, ...argv) => run('git', argv, 'git', { cwd });
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function waitFor(label, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Native review gate interrupted');
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP connection closed')); }
    pending.clear();
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown') void appendFile(join(output, 'webview-errors.log'), `${JSON.stringify(message)}\n`);
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
        void appendFile(join(output, 'webview-errors.log'), `${JSON.stringify(message)}\n`);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}
async function evaluate(code) {
  const value = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { const {repo, workspaces, workspaceReview} = window.__strand ?? {}; ${code} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
const quote = JSON.stringify;
async function visible(label, text) {
  await waitFor(label, () => evaluate(`
    const text = (root) => (root.innerText ?? root.textContent ?? '') + [...root.querySelectorAll('*')]
      .filter(el => el.shadowRoot).map(el => text(el.shadowRoot)).join(' ');
    return text(document.body).includes(${quote(text)});
  `));
}
async function click(selector) {
  await waitFor(`enabled ${selector}`, () => evaluate(`const el = document.querySelector(${quote(selector)}); return !!el && !el.disabled && el.getBoundingClientRect().height > 0;`));
  await evaluate(`document.querySelector(${quote(selector)}).click();`);
}
async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(data, 'base64'));
}
async function passed(name) { checks.push(name); await log(`PASS ${name}`); }
async function persistenceEvidence() {
  return evaluate(`return {
    activePath: repo?.getState().activePath, baseline: repo?.getState().baseline,
    notes: repo?.getState().reviewNotes, branch: repo?.getState().meta?.branch,
    stored: await window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
      db: 'sqlite:strand.db', values: [],
      query: "SELECT key, value FROM settings WHERE key LIKE 'baseline:%' OR key LIKE 'review-notes:%' OR key = 'session.tabs'",
    }),
  };`);
}

const vitePort = await port();
const debugPort = await port();
const profile = join(scratch, 'webview');
const config = JSON.parse(await readFile(join(root, 'crates/strand-tauri/tauri.conf.json'), 'utf8'));
const override = {
  identifier,
  build: { devUrl: `http://127.0.0.1:${vitePort}` },
  app: { windows: [{ ...config.app.windows[0], width: 1280, height: 800, additionalBrowserArgs: `--remote-debugging-port=${debugPort}` }] },
};
const binary = join(scratch, 'strand-review-test.exe');
async function launch() {
  app = start(binary, [], 'strand', { env: { ...env, WEBVIEW2_USER_DATA_FOLDER: profile } });
  const target = await waitFor('native WebView2 page', async () => {
    assert(app.exitCode === null, 'Strand exited before its webview was ready');
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
    return targets.find((target) => target.type === 'page' && target.url.startsWith(override.build.devUrl));
  }, 60000);
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // CDP advertises the pending URL before WebView2 commits navigation; that
  // initial opaque document cannot access localStorage yet.
  await waitFor('committed frontend document', () => evaluate(`return location.href.startsWith(${quote(override.build.devUrl)}) && document.readyState !== 'loading' && !!document.getElementById('root');`), 60000);
  if (!await evaluate('return !!window.__strand;')) {
    await evaluate("localStorage.setItem('strand:perf', '1');");
    await cdp.send('Page.reload');
  }
  await waitFor('React stores and workspace persistence', () => evaluate('return !!repo && workspaces.getState().loaded && document.querySelectorAll("#root > *").length > 0;'));
  // Inspect real feedback rendering without writing the user's system clipboard.
  await evaluate('Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__reviewFeedback = text; } } });');
}
async function initRepo(path, committed = true) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Native review test'], ['user.email', 'native-review@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', join(scratch, 'empty-hooks')]]) await git(path, 'config', key, value);
  if (committed) {
    await writeFile(join(path, 'agent.ts'), 'export const value = "before";\n');
    await writeFile(join(path, 'partial.ts'), 'export const partial = "before";\n');
    await writeFile(join(path, 'staged.ts'), 'export const staged = "before";\n');
    await git(path, 'add', '-A');
    await git(path, 'commit', '-qm', 'Initial fixture');
  }
}
async function open(path) {
  await evaluate(`await workspaces.getState().openRepoInActive(${quote(path)}); repo.getState().setView('review'); await repo.getState().refreshReviewDiffs();`);
}
async function select(file) {
  await evaluate(`repo.getState().selectReviewFile(${quote(file)});`);
  await waitFor(`rendered ${file}`, () => evaluate(`return document.querySelector('.rv-file-head .path')?.textContent === ${quote(file)};`));
}
async function scenario(round) {
  const main = join(scratch, `review-${round}`);
  const second = join(scratch, `other-${round}`);
  const unborn = join(scratch, `unborn-${round}`);
  await initRepo(main); await initRepo(second); await initRepo(unborn, false);
  await evaluate(`const id = await workspaces.getState().create('Native review ${round}', []); await workspaces.getState().openWorkspace(id);`);
  await open(main);
  // External agent writes, including a staged-only file and separate index/disk bytes.
  await writeFile(join(main, 'agent.ts'), 'export const value = "reviewed-agent-value";\n');
  await writeFile(join(main, 'partial.ts'), 'export const partial = "staged-value";\n');
  await writeFile(join(main, 'staged.ts'), 'export const staged = "fully-staged-value";\n');
  await git(main, 'add', 'partial.ts', 'staged.ts');
  await writeFile(join(main, 'partial.ts'), 'export const partial = "working-value";\n');
  await evaluate("await repo.getState().refreshLocalChanges(); await repo.getState().refreshReviewDiffs();");
  await select('agent.ts');
  await visible('painted agent change', 'reviewed-agent-value');
  await click('.rv-file-head button[title="Mark reviewed (Space)"]');
  await waitFor('reviewed verdict', () => evaluate('return document.querySelector(".rv-file-head .rv-check")?.getAttribute("aria-pressed") === "true";'));
  await evaluate("await repo.getState().stageReviewed();");
  assert.equal(await git(main, 'show', ':agent.ts'), 'export const value = "reviewed-agent-value";');
  assert.equal(await git(main, 'show', ':partial.ts'), 'export const partial = "staged-value";');
  await evaluate("repo.getState().addReviewNote('agent.ts', 'Keep this original value in the feedback.', 1, 'new');");
  await visible('visible saved feedback', 'Keep this original value');
  const anchor = await evaluate("return repo.getState().reviewNotes['agent.ts'][0].anchor;");
  assert(anchor.excerpt.includes('reviewed-agent-value'));
  await evaluate("await repo.getState().commit('Reviewed agent changes', '', false);");
  assert.equal(await git(main, 'show', 'HEAD:agent.ts'), 'export const value = "reviewed-agent-value";');
  await writeFile(join(main, 'agent.ts'), '// inserted after review\nexport const value = "agent-followup-value";\n');
  await evaluate("await repo.getState().refreshReviewDiffs();");
  await select('agent.ts');
  await visible('outdated line note', 'Outdated');
  assert.deepEqual(await evaluate("return repo.getState().reviewNotes['agent.ts'][0].anchor;"), anchor);
  await click('button[title="Copy every note as one Markdown prompt for the agent"]');
  const feedback = await waitFor('feedback export', () => evaluate('return window.__reviewFeedback;'));
  assert(feedback.includes('reviewed-agent-value'));
  assert(feedback.toLowerCase().includes('outdated'));
  await writeFile(join(output, `feedback-${round}.md`), feedback);
  await screenshot(`review-followup-${round}`);
  await passed(`${round}: agent edit, reviewed staging, commit and anchored re-review`);
  // Controlled interleaving: the agent writes after the mark, before staging.
  await click('.rv-file-head button[title="Mark reviewed (Space)"]');
  await writeFile(join(main, 'agent.ts'), '// newer than the reviewed patch\nexport const value = "unreviewed-later-value";\n');
  await evaluate('await repo.getState().stageReviewed();');
  assert.equal(await git(main, 'show', ':agent.ts'), 'export const value = "reviewed-agent-value";');
  await select('agent.ts');
  await visible('subsequent agent write paints', 'unreviewed-later-value');
  await waitFor('stale review mark', () => evaluate('return document.querySelector(".rv-file-head .rv-check")?.getAttribute("aria-pressed") === "false";'));
  await passed(`${round}: edits after review are not staged as reviewed`);

  // Verify both views show complete inbox content after staging.
  await writeFile(join(main, 'staged.ts'), 'export const staged = "staged-again";\n');
  await git(main, 'add', 'staged.ts');
  await evaluate("repo.getState().setView('workspace-review'); await workspaceReview.getState().refreshAll();");
  const member = await evaluate('return workspaceReview.getState().members.find(m => m.path === repo.getState().activePath);');
  assert(member.diffs.some((d) => d.path === 'staged.ts'));
  assert(member.diffs.some((d) => d.path === 'partial.ts'));
  await evaluate("workspaceReview.getState().select({repo: repo.getState().activePath, file: 'staged.ts'});");
  await visible('workspace staged content paints', 'staged-again');
  await screenshot(`workspace-review-${round}`);
  await passed(`${round}: Workspace Review includes staged and partially staged files`);

  await open(main);
  const baseline = await git(main, 'rev-parse', 'HEAD');
  const noteCreated = await evaluate(`await repo.getState().setBaseline(${quote(baseline)}); repo.getState().addReviewNote('agent.ts', 'Persist across native restart', null); return repo.getState().reviewNotes['agent.ts']?.some(n => n.text === 'Persist across native restart');`);
  assert(noteCreated, 'File notes must be accepted while the pinned comparison loads');
  await open(second); await open(main);
  await waitFor('repository note persistence', () => evaluate("return repo.getState().reviewNotes['agent.ts']?.some(n => n.text === 'Persist across native restart');"));
  await writeFile(join(output, `persistence-before-restart-${round}.json`), JSON.stringify(await persistenceEvidence(), null, 2));
  const savedPath = await evaluate('return repo.getState().activePath;');
  cdp.close(); await stop(app); await launch();
  await waitFor('automatic native session restore', () => evaluate(`return repo.getState().activePath === ${quote(savedPath)} && repo.getState().baseline?.oid === ${quote(baseline)} && repo.getState().reviewNotes['agent.ts']?.some(n => n.text === 'Persist across native restart');`));
  await evaluate("repo.getState().setView('review'); await repo.getState().refreshReviewDiffs();");
  assert.equal(await evaluate('return repo.getState().baseline?.oid;'), baseline);
  assert(await evaluate("return repo.getState().reviewNotes['agent.ts']?.some(n => n.text === 'Persist across native restart');"));
  await select('agent.ts'); await visible('persisted note is visible', 'Persist across native restart');
  await passed(`${round}: repository switching and native restart preserve review state`);

  const invalid = '1111111111111111111111111111111111111111';
  await evaluate(`await repo.getState().setBaseline(${quote(invalid)});`);
  assert.equal(await evaluate('return repo.getState().baseline?.oid;'), invalid);
  assert(await evaluate('return !!repo.getState().reviewDiffsError;'));
  await visible('explicit comparison failure', 'Retry');
  await screenshot(`baseline-error-${round}`);
  await evaluate('await repo.getState().clearBaseline();');
  await passed(`${round}: missing pinned baseline remains an explicit retryable error`);

  await writeFile(join(unborn, 'scaffold.ts'), 'export const scaffold = "before-first-commit";\n');
  await open(unborn); await select('scaffold.ts'); await visible('unborn addition paints', 'before-first-commit');
  await git(unborn, 'add', '-A');
  await evaluate('await repo.getState().refreshLocalChanges(); await repo.getState().refreshReviewDiffs();');
  await select('scaffold.ts'); await visible('staged unborn addition paints', 'before-first-commit');
  await evaluate("await repo.getState().commit('Initial scaffold', '', false); await repo.getState().refreshReviewDiffs();");
  await visible('empty review only after first commit', 'No uncommitted changes');
  await passed(`${round}: review before first commit survives staging and committing`);

  await open(main);
  const worktree = join(scratch, `worktree-${round}`);
  await git(main, 'worktree', 'add', '-b', `recovery-${round}`, worktree);
  await writeFile(join(worktree, 'agent.ts'), 'index-only recovery bytes\n');
  await git(worktree, 'add', 'agent.ts');
  const index = await git(worktree, 'write-tree');
  await writeFile(join(worktree, 'agent.ts'), 'disk-only recovery bytes\n');
  await writeFile(join(worktree, '.gitattributes'), 'agent.ts filter=native-test-failure\n');
  await git(worktree, 'config', 'filter.native-test-failure.clean', 'strand-native-test-missing-filter');
  await git(worktree, 'config', 'filter.native-test-failure.required', 'true');
  const error = await evaluate(`try { await repo.getState().removeWorktree(${quote(worktree)}, true); return null; } catch(e) { return typeof e === 'string' ? e : e.message ?? JSON.stringify(e); }`);
  await writeFile(join(output, `recovery-refusal-${round}.txt`), error ?? 'Removal unexpectedly succeeded');
  assert(error?.includes('recovery archive failed'), error);
  assert.equal(await readFile(join(worktree, 'agent.ts'), 'utf8'), 'disk-only recovery bytes\n');
  assert.equal(await git(worktree, 'write-tree'), index);
  assert((await git(main, 'worktree', 'list', '--porcelain')).includes(`recovery-${round}`));
  await passed(`${round}: native archive failure refuses forced removal and retains index/disk data`);

  const paged = join(scratch, `paged-${round}`);
  await initRepo(paged);
  await Promise.all(Array.from({ length: 70 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return writeFile(join(paged, `paged-${suffix}.ts`), `export const item = "native-lazy-token-${suffix}";\n`);
  }));
  await open(paged);
  await evaluate("repo.getState().selectLocalFile(null); repo.getState().setView('local');");
  await visible('first Local Changes patch paints', 'native-lazy-token-000');
  const initial = await evaluate('return { total: repo.getState().unstagedDiffs.length, loaded: repo.getState().unstagedDiffs.filter(d => d.patchLoaded !== false).length };');
  assert.equal(initial.total, 70);
  assert(initial.loaded > 0 && initial.loaded < 35, JSON.stringify(initial));
  await screenshot(`local-viewport-${round}`);
  await evaluate("[...document.querySelectorAll('.lc-hunkfile .path')].find(el => el.textContent === 'paged-069.ts').scrollIntoView({ block: 'center' });");
  await visible('distant Local Changes patch paints after scrolling', 'native-lazy-token-069');
  const unloaded = await evaluate('return repo.getState().unstagedDiffs.find(d => d.patchLoaded === false)?.path;');
  assert(unloaded, 'Viewport browsing must leave distant patches unloaded');
  const token = `native-lazy-token-${unloaded.match(/(\d{3})/)[1]}`;
  await evaluate(`window.__searchStates = []; window.__searchObserver = new MutationObserver(() => {
    const value = document.querySelector('.diff-search-bar .ds-count')?.textContent;
    if (value && window.__searchStates.at(-1) !== value) window.__searchStates.push(value);
  }); window.__searchObserver.observe(document.body, { subtree: true, childList: true, characterData: true });`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 });
  await waitFor('focused in-diff search', () => evaluate('return document.activeElement?.matches(".diff-search-bar input");'));
  await cdp.send('Input.insertText', { text: token });
  await waitFor('search across all 70 patches', () => evaluate('return document.querySelector(".diff-search-bar .ds-count")?.textContent === "1 found";'));
  await click('.diff-search-bar button[aria-label="Next match"]');
  await waitFor('search navigates to previously unloaded file', () => evaluate(`return repo.getState().localSelection?.file === ${quote(unloaded)};`));
  const searched = await evaluate('window.__searchObserver.disconnect(); return { states: window.__searchStates, loaded: repo.getState().unstagedDiffs.filter(d => d.patchLoaded !== false).length };');
  assert.equal(searched.loaded, 70);
  assert(searched.states.some((value) => value.startsWith('Loading ') && value.includes('/70')), JSON.stringify(searched));
  await screenshot(`local-search-${round}`);
  await writeFile(join(output, `local-paging-${round}.json`), JSON.stringify({ initial, unloaded, token, searched }, null, 2));
  await passed(`${round}: Local Changes loads visible patches and searches all 70 files on demand`);
}

try {
  await log(`Isolated identity ${identifier}; evidence ${output}`);
  const vite = start(process.execPath, [join(root, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], 'vite', { cwd: join(root, 'ui'), env: { ...env, STRAND_NO_HMR: '1' } });
  await waitFor('isolated Vite server', async () => vite.exitCode === null && (await fetch(override.build.devUrl, { signal: AbortSignal.timeout(1000) })).ok);
  configuredBuild = true;
  await run('cargo', ['build', '-p', 'strand-tauri', '--no-default-features'], 'build-native', { env: { ...env, TAURI_CONFIG: JSON.stringify(override) } });
  await copyFile(join(root, 'target/debug/strand.exe'), binary);
  await launch();
  for (let round = 1; round <= repeats; round++) await scenario(round);
} catch (error) {
  failed = true;
  await log(error.stack ?? String(error));
  if (cdp) {
    await screenshot('failure').catch(() => {});
    const state = await evaluate(`return {
      url: location.href, ready: document.readyState, text: document.body?.innerText,
      view: repo?.getState().view, baseline: repo?.getState().baseline, reviewError: repo?.getState().reviewDiffsError,
      workspaceSelection: workspaceReview?.getState().selection,
      workspaceMembers: workspaceReview?.getState().members.map(m => ({ path: m.path, error: m.error,
        diffs: m.diffs.map(d => ({ path: d.path, loaded: d.patchLoaded, error: d.patchError })) })),
    };`).catch((error) => ({ error: String(error) }));
    await writeFile(join(output, 'failure-state.json'), JSON.stringify(state, null, 2));
    const persistence = await persistenceEvidence().catch((error) => ({ error: String(error) }));
    await writeFile(join(output, 'failure-persistence.json'), JSON.stringify(persistence, null, 2));
  }
} finally {
  cdp?.close();
  for (const child of [...children]) await stop(child).catch((error) => log(`Cleanup: ${error.message}`));
  // Never leave the ordinary developer binary compiled with a debug port or
  // the test identity, even after a failed scenario.
  if (configuredBuild) {
    const normalEnv = { ...process.env };
    await run('cargo', ['build', '-p', 'strand-tauri', '--no-default-features'], 'restore-native-build', { env: normalEnv }).catch(async (error) => { failed = true; await log(error.message); });
  }
  for (const { base, path } of appDirs) {
    assert.equal(dirname(path), base); assert.equal(relative(base, path), identifier);
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(async (error) => { failed = true; await log(`Cleanup: ${error.message}`); });
  }
  assert(relative(output, scratch).startsWith('fixture-') && !relative(output, scratch).includes(sep));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(async (error) => { failed = true; await log(`Cleanup: ${error.message}`); });
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: !failed, repeats, checks }, null, 2));
}
await log(`${failed ? 'FAIL' : 'PASS'} native review gate: ${checks.length} scenario checks`);
process.exitCode = failed ? 1 : 0;
