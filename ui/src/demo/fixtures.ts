/**
 * The sample repository the web demo runs against: `acme-api`, a small
 * TypeScript service with a couple of agent-authored feature branches, a
 * merged fix, linked worktrees in every state the Worktrees dashboard
 * distinguishes, and a handful of GitHub pull requests.
 */

import type { PullRequest, PullRequestRepository } from '../lib/types';
import { DemoRepo, fakeOid, now, type Author, type Tree } from './git';
import { unifiedPatch } from './textdiff';

export const DEMO_ROOT = '/Users/dana/code';
export const MAIN_PATH = `${DEMO_ROOT}/acme-api`;
export const PATH_RETRY_B = `${DEMO_ROOT}/acme-api-auth-retry-b`;
export const PATH_MAIN_WT = `${DEMO_ROOT}/acme-api-main`;
export const PATH_TOKEN_CACHE = `${DEMO_ROOT}/acme-api-token-cache`;

export const dana: Author = { name: 'Dana Whitfield', email: 'dana@acme.dev' };
const priya: Author = { name: 'Priya Raman', email: 'priya@acme.dev' };
const marco: Author = { name: 'Marco Lindqvist', email: 'marco@acme.dev' };

const CLAUDE = 'Co-authored-by: Claude <noreply@anthropic.com>';
const CODEX = 'Co-authored-by: Codex <noreply@openai.com>';

const T0 = now();
const min = (n: number) => T0 - n * 60;
const hours = (n: number) => min(n * 60);
const days = (n: number) => hours(n * 24);

// ---- file contents ----------------------------------------------------------

const README_V1 = `# acme-api

Backend for the Acme dashboard. TypeScript, no framework, boring on purpose.

## Development

\`\`\`sh
pnpm install
pnpm dev
\`\`\`
`;

const README_V2 = `${README_V1}
## Layout

- \`src/api\` — HTTP client and response types
- \`src/auth\` — session handling
- \`tests\` — vitest suites
`;

const PACKAGE_V1 = `{
  "name": "acme-api",
  "version": "1.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "undici": "^6.19.2"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
`;

const PACKAGE_V2 = PACKAGE_V1.replace('"version": "1.4.0"', '"version": "1.5.0"');
const PACKAGE_V3 = PACKAGE_V2.replace('"undici": "^6.19.2"', '"undici": "^6.21.0"');

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
`;

const GITIGNORE = `node_modules/
dist/
.env
coverage/
`;

const WORKTREEINCLUDE = `# Copied into every new worktree Strand creates (gitignored, but needed to run).
.env
`;

const INDEX_TS = `import { createClient } from './api/client';
import { loadConfig } from './config';

const config = loadConfig();
const client = createClient({ baseUrl: config.baseUrl });

const health = await client.get('/health');
console.log(\`acme-api ready (\${health.status})\`);
`;

const INDEX_TS_V0 = `import { createClient } from './api/client';

const client = createClient({ baseUrl: process.env.ACME_API_URL ?? 'http://localhost:4000' });

const health = await client.get('/health');
console.log(\`acme-api ready (\${health.status})\`);
`;

const TYPES_V1 = `export interface ClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}
`;

const TYPES_V2 = `export interface ClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Abort requests that take longer than this (milliseconds). */
  timeoutMs?: number;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}
`;

const CLIENT_V1 = `import type { ApiResponse, ClientOptions } from './types';

const cache = new Map<string, ApiResponse<unknown>>();

export function createClient(options: ClientOptions) {
  const headers = { accept: 'application/json', ...options.headers };

  async function get<T>(path: string): Promise<ApiResponse<T>> {
    const cached = cache.get(path);
    if (cached) return cached as ApiResponse<T>;
    const res = await fetch(options.baseUrl + path, { headers });
    const body = { status: res.status, data: (await res.json()) as T };
    cache.set(path, body);
    return body;
  }

  return { get };
}
`;

const CLIENT_V2 = `import type { ApiResponse, ClientOptions } from './types';

const cache = new Map<string, ApiResponse<unknown>>();

export function createClient(options: ClientOptions) {
  const headers = { accept: 'application/json', ...options.headers };

  async function get<T>(path: string): Promise<ApiResponse<T>> {
    const cached = cache.get(path);
    if (cached) return cached as ApiResponse<T>;
    const res = await fetch(options.baseUrl + path, { headers });
    const body = { status: res.status, data: (await res.json()) as T };
    // Never cache auth failures: the next call may carry a fresh token.
    if (res.status !== 401) cache.set(path, body);
    return body;
  }

  return { get };
}
`;

const CLIENT_V3 = `import type { ApiResponse, ClientOptions } from './types';

const cache = new Map<string, ApiResponse<unknown>>();

export function createClient(options: ClientOptions) {
  const headers = { accept: 'application/json', ...options.headers };

  async function get<T>(path: string): Promise<ApiResponse<T>> {
    const cached = cache.get(path);
    if (cached) return cached as ApiResponse<T>;
    const controller = new AbortController();
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
    try {
      const res = await fetch(options.baseUrl + path, { headers, signal: controller.signal });
      const body = { status: res.status, data: (await res.json()) as T };
      // Never cache auth failures: the next call may carry a fresh token.
      if (res.status !== 401) cache.set(path, body);
      return body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { get };
}
`;

// Working-copy edit on feature/auth-retry: thread the retry policy through.
const CLIENT_WIP = CLIENT_V3
  .replace(
    "import type { ApiResponse, ClientOptions } from './types';",
    "import type { ApiResponse, ClientOptions } from './types';\nimport { withRetry, type RetryPolicy } from '../auth/retry';",
  )
  .replace(
    'export function createClient(options: ClientOptions) {',
    'export function createClient(options: ClientOptions & { retry?: RetryPolicy }) {',
  )
  .replace(
    '      const res = await fetch(options.baseUrl + path, { headers, signal: controller.signal });',
    '      const res = await withRetry(\n        () => fetch(options.baseUrl + path, { headers, signal: controller.signal }),\n        options.retry,\n      );',
  );

// Alternative approach on feature/auth-retry-b: an interceptor chain.
const CLIENT_B = CLIENT_V3
  .replace(
    "import type { ApiResponse, ClientOptions } from './types';",
    "import type { ApiResponse, ClientOptions } from './types';\nimport { retryInterceptor } from '../auth/retry';",
  )
  .replace(
    "  const headers = { accept: 'application/json', ...options.headers };",
    "  const headers = { accept: 'application/json', ...options.headers };\n  const send = retryInterceptor(fetch, { attempts: 3 });",
  )
  .replace(
    '      const res = await fetch(options.baseUrl + path, { headers, signal: controller.signal });',
    '      const res = await send(options.baseUrl + path, { headers, signal: controller.signal });',
  );

const CLIENT_B_WIP = CLIENT_B.replace('{ attempts: 3 }', '{ attempts: 3, retryOn: [502, 503, 504] }');

const CONFIG_TS = `export interface Config {
  baseUrl: string;
  logLevel: 'debug' | 'info' | 'warn';
}

export function loadConfig(): Config {
  return {
    baseUrl: process.env.ACME_API_URL ?? 'http://localhost:4000',
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  };
}
`;

const ERRORS_V1 = `export class SessionExpiredError extends Error {
  constructor(public readonly expiredAt: number) {
    super(\`session expired at \${new Date(expiredAt * 1000).toISOString()}\`);
    this.name = 'SessionExpiredError';
  }
}
`;

const ERRORS_V2 = `${ERRORS_V1}
export class RetryExhaustedError extends Error {
  constructor(public readonly attempts: number, public readonly cause: unknown) {
    super(\`gave up after \${attempts} attempts\`);
    this.name = 'RetryExhaustedError';
  }
}
`;

const SESSION_V1 = `import { SessionExpiredError } from './errors';

export interface Session {
  token: string;
  expiresAt: number;
}

let current: Session | null = null;

export function setSession(session: Session): void {
  current = session;
}

export function requireSession(nowUnix = Math.floor(Date.now() / 1000)): Session {
  if (!current) throw new Error('not signed in');
  if (current.expiresAt <= nowUnix) throw new SessionExpiredError(current.expiresAt);
  return current;
}
`;

const SESSION_V2 = `import { SessionExpiredError } from './errors';

export interface Session {
  token: string;
  expiresAt: number;
}

const STORAGE_KEY = 'acme.session';
let current: Session | null = load();

function load(): Session | null {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

function persist(session: Session | null): void {
  if (session) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
  else globalThis.localStorage?.removeItem(STORAGE_KEY);
}

export function setSession(session: Session): void {
  current = session;
  persist(session);
}

export function requireSession(nowUnix = Math.floor(Date.now() / 1000)): Session {
  if (!current) throw new Error('not signed in');
  if (current.expiresAt <= nowUnix) throw new SessionExpiredError(current.expiresAt);
  return current;
}
`;

const SESSION_V3 = SESSION_V2.replace(
  `export function requireSession(nowUnix = Math.floor(Date.now() / 1000)): Session {
  if (!current) throw new Error('not signed in');
  if (current.expiresAt <= nowUnix) throw new SessionExpiredError(current.expiresAt);
  return current;
}`,
  `/** Tolerate a little clock skew between the browser and the API. */
const SKEW_SECONDS = 30;

export function requireSession(nowUnix = Math.floor(Date.now() / 1000)): Session {
  if (!current) throw new Error('not signed in');
  if (current.expiresAt + SKEW_SECONDS <= nowUnix) throw new SessionExpiredError(current.expiresAt);
  return current;
}`,
);

const SESSION_V4 = `${SESSION_V3}
export function clearSession(): void {
  current = null;
  persist(null);
}
`;

const SESSION_RETRY = SESSION_V4.replace(
  "import { SessionExpiredError } from './errors';",
  "import { SessionExpiredError } from './errors';\nimport { withRetry } from './retry';",
).replace(
  `export function clearSession(): void {`,
  `export async function refreshSession(fetchToken: () => Promise<Session>): Promise<Session> {
  const next = await withRetry(fetchToken, { attempts: 3, baseDelayMs: 200 });
  setSession(next);
  return next;
}

export function clearSession(): void {`,
);

const RETRY_V1 = `export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
}

const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 250 };

function isTransient(error: unknown): boolean {
  if (error instanceof Response) return error.status >= 500 || error.status === 429;
  return error instanceof TypeError; // network failure
}

export async function withRetry<T>(run: () => Promise<T>, policy: Partial<RetryPolicy> = {}): Promise<T> {
  const { attempts, baseDelayMs } = { ...DEFAULT_POLICY, ...policy };
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts - 1) break;
      const jitter = Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt + jitter));
    }
  }
  throw lastError;
}
`;

const RETRY_WIP = `import { RetryExhaustedError } from './errors';
import { backoffDelay } from './backoff';

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  /** Upper bound for a single wait, so attempt 5 doesn't sleep for a minute. */
  maxDelayMs: number;
}

const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

function isTransient(error: unknown): boolean {
  if (error instanceof Response) return error.status >= 500 || error.status === 429;
  return error instanceof TypeError; // network failure
}

export async function withRetry<T>(run: () => Promise<T>, policy: Partial<RetryPolicy> = {}): Promise<T> {
  const resolved = { ...DEFAULT_POLICY, ...policy };
  let lastError: unknown;
  for (let attempt = 0; attempt < resolved.attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === resolved.attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, resolved)));
    }
  }
  throw new RetryExhaustedError(resolved.attempts, lastError);
}
`;

const BACKOFF_NEW = `import type { RetryPolicy } from './retry';

/** Exponential backoff with full jitter, capped at \`maxDelayMs\`. */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.random() * capped;
}
`;

const RETRY_B = `type Fetch = typeof fetch;

export interface InterceptorOptions {
  attempts: number;
  retryOn?: number[];
}

export function retryInterceptor(next: Fetch, options: InterceptorOptions): Fetch {
  const retryOn = new Set(options.retryOn ?? [500, 502, 503, 504]);
  return async (input, init) => {
    let last: Response | null = null;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      last = await next(input, init);
      if (!retryOn.has(last.status)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    return last!;
  };
}
`;

const SESSION_TEST_V1 = `import { describe, expect, it } from 'vitest';
import { requireSession, setSession } from '../src/auth/session';

describe('requireSession', () => {
  it('returns the active session', () => {
    setSession({ token: 't', expiresAt: 2_000 });
    expect(requireSession(1_000).token).toBe('t');
  });

  it('throws once expired', () => {
    setSession({ token: 't', expiresAt: 1_000 });
    expect(() => requireSession(1_000)).toThrow(/expired/);
  });
});
`;

const SESSION_TEST_V2 = SESSION_TEST_V1.replace(
  `  it('throws once expired', () => {
    setSession({ token: 't', expiresAt: 1_000 });
    expect(() => requireSession(1_000)).toThrow(/expired/);
  });`,
  `  it('tolerates 30s of clock skew', () => {
    setSession({ token: 't', expiresAt: 1_000 });
    expect(requireSession(1_020).token).toBe('t');
  });

  it('throws once expired past the skew window', () => {
    setSession({ token: 't', expiresAt: 1_000 });
    expect(() => requireSession(1_031)).toThrow(/expired/);
  });`,
);

const RETRY_TEST_V1 = `import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/auth/retry';

describe('withRetry', () => {
  it('retries transient failures', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(run, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(withRetry(run, { attempts: 2, baseDelayMs: 0 })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
`;

const RETRY_TEST_WIP = RETRY_TEST_V1.replace(
  `    expect(run).toHaveBeenCalledTimes(2);
  });
});`,
  `    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const run = vi.fn().mockRejectedValue(new Response(null, { status: 404 }));
    await expect(withRetry(run, { baseDelayMs: 0 })).rejects.toBeInstanceOf(Response);
    expect(run).toHaveBeenCalledTimes(1);
  });
});`,
);

const RETRY_TEST_B = `import { describe, expect, it, vi } from 'vitest';
import { retryInterceptor } from '../src/auth/retry';

describe('retryInterceptor', () => {
  it('retries 503s', async () => {
    const next = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('ok'));
    const send = retryInterceptor(next, { attempts: 2 });
    expect((await send('/x')).status).toBe(200);
  });
});
`;

const RETRY_TEST_B_WIP = RETRY_TEST_B.replace(
  `    expect((await send('/x')).status).toBe(200);
  });
});`,
  `    expect((await send('/x')).status).toBe(200);
  });

  it('passes 4xx straight through', async () => {
    const next = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const send = retryInterceptor(next, { attempts: 3 });
    expect((await send('/x')).status).toBe(404);
    expect(next).toHaveBeenCalledTimes(1);
  });
});`,
);

const DOCS_AUTH_V1 = `# Authentication

Sessions are short-lived bearer tokens. \`requireSession()\` throws
\`SessionExpiredError\` once a token is past its \`expiresAt\`.

## Refresh

Callers are expected to catch \`SessionExpiredError\` and re-authenticate.
`;

const DOCS_AUTH_V2 = `${DOCS_AUTH_V1}
## Retry policy

Transient failures (network errors, 429, 5xx) are retried with exponential
backoff and full jitter. The default budget is three attempts starting at
250 ms. Pass a \`RetryPolicy\` to \`withRetry\` to tune it per call.
`;

const DOCS_AUTH_WIP = DOCS_AUTH_V2.replace(
  '250 ms. Pass a `RetryPolicy` to `withRetry` to tune it per call.',
  '250 ms, capped at 4 s per wait. Pass a `RetryPolicy` to `withRetry` to tune\nit per call. When the budget is exhausted, `RetryExhaustedError` carries the\nlast underlying error as `cause`.',
);

const ENV_FILE = `ACME_API_URL=http://localhost:4000
LOG_LEVEL=debug
`;

// ---- history ----------------------------------------------------------------

export interface DemoWorld {
  repo: DemoRepo;
  pullRequests: PullRequest[];
  prRepository: PullRequestRepository;
  prDiffs: Map<number, () => string>;
}

export function buildWorld(): DemoWorld {
  const repo = new DemoRepo('acme-api', `${MAIN_PATH}/.git`);
  let tree: Tree = new Map();
  const set = (changes: Record<string, string | null>) => {
    tree = new Map(tree);
    for (const [path, text] of Object.entries(changes)) {
      if (text == null) tree.delete(path);
      else tree.set(path, text);
    }
  };
  const commit = (parents: string[], author: Author, time: number, subject: string, body = '', signed = false) =>
    repo.createCommit(parents, tree, subject, body, author, time, signed).hash;

  set({ 'README.md': README_V1, 'package.json': PACKAGE_V1, 'tsconfig.json': TSCONFIG, '.gitignore': GITIGNORE });
  const c1 = commit([], dana, days(62), 'Initial commit', '', true);
  set({ 'src/api/client.ts': CLIENT_V1, 'src/api/types.ts': TYPES_V1, 'src/index.ts': INDEX_TS_V0 });
  const c2 = commit([c1], dana, days(60), 'feat: HTTP client with typed responses', '', true);
  set({ 'src/auth/session.ts': SESSION_V1, 'src/auth/errors.ts': ERRORS_V1 });
  const c3 = commit([c2], priya, days(55), 'feat: in-memory session store');
  set({ 'tests/session.test.ts': SESSION_TEST_V1 });
  const c4 = commit([c3], priya, days(54), 'test: session expiry');
  set({ 'src/config.ts': CONFIG_TS, 'src/index.ts': INDEX_TS });
  const c5 = commit([c4], marco, days(48), 'chore: config loader', 'Reads ACME_API_URL and LOG_LEVEL from the environment.');
  set({ 'docs/auth.md': DOCS_AUTH_V1, 'README.md': README_V2 });
  const c6 = commit([c5], dana, days(45), 'docs: auth overview and repo layout', '', true);
  set({ 'src/api/client.ts': CLIENT_V2 });
  const c7 = commit([c6], marco, days(40), "fix: don't cache 401 responses", 'A stale 401 stuck in the cache made every retry fail until restart.\n\nFixes #212');
  set({ 'src/api/client.ts': CLIENT_V3, 'src/api/types.ts': TYPES_V2 });
  const c8 = commit([c7], dana, days(30), 'feat: request timeout option', '', true);
  set({ 'src/auth/session.ts': SESSION_V2 });
  const c9 = commit([c8], priya, days(21), 'refactor: persist sessions in localStorage');
  set({ '.worktreeinclude': WORKTREEINCLUDE });
  const c10 = commit([c9], dana, days(14), 'chore: .worktreeinclude for local env', 'Strand copies .env into new worktrees so they run out of the box.', true);
  set({ 'src/auth/session.ts': SESSION_V3, 'tests/session.test.ts': SESSION_TEST_V2, 'package.json': PACKAGE_V2 });
  const c11 = commit([c10], marco, days(9), 'fix: tolerate clock skew when checking expiry', 'Release 1.5.0.');

  set({ 'src/auth/session.ts': SESSION_V4 });
  const f1 = commit([c11], priya, days(6), 'fix: invalidate token cache on logout', 'clearSession() drops the persisted copy too.\n\nCloses #244');
  const c12 = commit([c11, f1], dana, days(5), "Merge pull request #244 from acme/fix/token-cache", 'fix: invalidate token cache on logout', true);
  set({ 'package.json': PACKAGE_V3 });
  const c13 = commit([c12], marco, days(3), 'chore(deps): bump undici to 6.21', '');

  // origin/main has moved on by one commit the local branch hasn't pulled.
  const ciTree = tree;
  set({ '.github/workflows/ci.yml': `name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n` });
  const c14 = commit([c13], priya, days(1), 'ci: run the suite on every push');
  tree = ciTree;

  // Stale spike from a month ago (no worktree, never pushed).
  const spikeBase = tree;
  tree = repo.commit(c8).tree;
  set({ 'src/edge.ts': `export default {\n  async fetch(request: Request): Promise<Response> {\n    return new Response('edge hello');\n  },\n};\n` });
  const s1 = commit([c8], marco, days(33), 'spike: edge runtime entrypoint', 'Exploration only — do not merge.');
  tree = spikeBase;

  // Agent branch A (Claude): backoff helper threaded through the client.
  set({ 'src/auth/retry.ts': RETRY_V1, 'src/auth/session.ts': SESSION_RETRY });
  const a1 = commit([c13], dana, hours(26), 'feat(auth): retry transient failures with backoff', `Wraps token refresh in withRetry() so a flaky network doesn't sign users out.\n\n${CLAUDE}`);
  set({ 'tests/retry.test.ts': RETRY_TEST_V1 });
  const a2 = commit([a1], dana, hours(25), 'test(auth): cover retry budget and transient detection', CLAUDE);
  set({ 'docs/auth.md': DOCS_AUTH_V2 });
  const a3 = commit([a2], dana, hours(24), 'docs(auth): document the retry policy', CLAUDE);

  // Agent branch B (Codex): same goal, interceptor approach.
  tree = repo.commit(c13).tree;
  set({ 'src/auth/retry.ts': RETRY_B, 'src/api/client.ts': CLIENT_B });
  const b1 = commit([c13], dana, hours(20), 'feat(auth): retry via fetch interceptor', `Alternative to #248: keep retry out of the session module.\n\n${CODEX}`);
  set({ 'tests/retry.test.ts': RETRY_TEST_B });
  const b2 = commit([b1], dana, hours(19), 'test: interceptor retries 5xx', CODEX);

  repo.branches.set('main', c13);
  repo.branches.set('feature/auth-retry', a3);
  repo.branches.set('feature/auth-retry-b', b2);
  repo.branches.set('fix/token-cache', f1);
  repo.branches.set('spike/edge-runtime', s1);
  repo.upstreams.set('main', 'origin/main');
  repo.upstreams.set('feature/auth-retry', 'origin/feature/auth-retry');
  repo.upstreams.set('fix/token-cache', 'origin/fix/token-cache');
  repo.remoteBranches.set('origin/main', c14);
  repo.remoteBranches.set('origin/feature/auth-retry', a1);
  repo.remoteBranches.set('origin/fix/token-cache', f1);
  repo.remoteBranches.set('origin/docs/onboarding', c13);
  repo.remotes.push({
    name: 'origin', url: 'git@github.com:acme/acme-api.git', push_url: null,
    fetch_refspecs: ['+refs/heads/*:refs/remotes/origin/*'], push_refspecs: [], is_default: true,
  });
  repo.tags.push(
    { name: 'v1.4.0', full_name: 'refs/tags/v1.4.0', target: c7, annotated: true, message: 'Release 1.4.0' },
    { name: 'v1.5.0', full_name: 'refs/tags/v1.5.0', target: c11, annotated: true, message: 'Release 1.5.0' },
  );

  // ---- worktrees ----------------------------------------------------------

  const main = repo.addWorktree({
    path: MAIN_PATH, branch: 'feature/auth-retry', detachedHead: null, isMain: true, lastActivityUnix: min(4), diskBytes: 41_300_000,
  });
  main.ignored.set('.env', ENV_FILE);
  for (const dep of ['undici', 'tsx', 'typescript', 'vitest']) {
    main.ignored.set(`node_modules/${dep}/package.json`, `{ "name": "${dep}" }\n`);
  }
  main.ignored.set('node_modules/.pnpm/lock.yaml', '');
  // The agent is mid-task: one file staged, the rest still in the working tree.
  main.workdir.set('src/auth/retry.ts', RETRY_WIP);
  main.workdir.set('src/auth/backoff.ts', BACKOFF_NEW);
  main.workdir.set('src/auth/errors.ts', ERRORS_V2);
  main.workdir.set('src/api/client.ts', CLIENT_WIP);
  main.workdir.set('tests/retry.test.ts', RETRY_TEST_WIP);
  main.workdir.set('docs/auth.md', DOCS_AUTH_WIP);
  repo.stage(main, 'src/auth/errors.ts');

  const retryB = repo.addWorktree({
    path: PATH_RETRY_B, branch: 'feature/auth-retry-b', detachedHead: null, isMain: false, lastActivityUnix: hours(2), diskBytes: 39_800_000,
  });
  retryB.ignored.set('.env', ENV_FILE);
  retryB.workdir.set('src/api/client.ts', CLIENT_B_WIP);
  retryB.workdir.set('tests/retry.test.ts', RETRY_TEST_B_WIP);

  repo.addWorktree({
    path: PATH_MAIN_WT, branch: 'main', detachedHead: null, isMain: false, lastActivityUnix: days(3), diskBytes: 38_900_000,
  }).ignored.set('.env', ENV_FILE);

  repo.addWorktree({
    path: PATH_TOKEN_CACHE, branch: 'fix/token-cache', detachedHead: null, isMain: false, lastActivityUnix: days(6), diskBytes: 38_600_000,
    locked: true, lockReason: 'keeping for the 1.5.1 backport',
  });

  // A stash on the current branch: an abandoned README rewrite.
  main.workdir.set('README.md', README_V2.replace('Backend for the Acme dashboard. TypeScript, no framework, boring on purpose.', 'Backend for the Acme dashboard.'));
  repo.stashSave(main, 'shorter README intro', false, false, false, ['README.md']);
  repo.stashes[0].time_unix = hours(30);

  // An archived worktree from the spike, restorable from the dashboard.
  repo.archives.push({
    ref_name: `refs/strand/archive/spike-edge-runtime/${days(28)}`,
    name: 'spike-edge-runtime', oid: s1, time_unix: days(28),
    subject: 'Strand archive of spike/edge-runtime', branch: 'spike/edge-runtime',
    path: `${DEMO_ROOT}/acme-api-spike`, tree: repo.commit(s1).tree,
  });

  // ---- pull requests ------------------------------------------------------

  const iso = (unix: number) => new Date(unix * 1000).toISOString();
  const prUrl = (id: number) => `https://github.com/acme/acme-api/pull/${id}`;
  const prRepository: PullRequestRepository = { provider: 'git_hub', remote: 'origin', label: 'acme/acme-api', viewer: 'dana' };

  const basePr = (over: Partial<PullRequest> & Pick<PullRequest, 'id' | 'title' | 'state' | 'author' | 'source_branch' | 'target_branch' | 'created_at' | 'updated_at'>): PullRequest => ({
    is_draft: false, can_mark_ready: false, source_commit: '', completed_at: null, url: prUrl(over.id), description: '',
    merge_status: 'CLEAN', review_status: 'REVIEW_REQUIRED', comment_count: 0, commit_count: 1,
    additions: null, deletions: null, changed_files: null, labels: [], reviewers: [], checks: [], checks_complete: true,
    comments: [], review_threads: [], reviews: [], authored_by_viewer: over.author === 'dana', commits: [],
    ...over,
  });

  const commitsOf = (tip: string, base: string) => {
    const baseSet = repo.ancestors(base);
    return [...repo.ancestors(tip)].filter((h) => !baseSet.has(h)).map((h) => repo.commit(h))
      .sort((a, b) => a.time_unix - b.time_unix)
      .map((c) => ({ id: c.hash, title: c.subject, author: c.author_name, avatar_url: null, committed_at: iso(c.time_unix), url: `https://github.com/acme/acme-api/commit/${c.hash}` }));
  };
  const statsOf = (patch: string) => {
    let additions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git')) files += 1;
      else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    return { additions, deletions, changed_files: files };
  };

  const prDiffs = new Map<number, () => string>();
  prDiffs.set(248, () => repo.branchPatch('feature/auth-retry', 'main'));
  prDiffs.set(249, () => repo.branchPatch('feature/auth-retry-b', 'main'));
  prDiffs.set(244, () => repo.diffCommit(main, f1).map((d) => d.patch).join(''));
  prDiffs.set(241, () => repo.diffCommit(main, c13).map((d) => d.patch).join(''));
  prDiffs.set(236, () => repo.diffCommit(main, s1).map((d) => d.patch).join(''));
  const onboarding = `# Onboarding\n\nWelcome to acme-api. Start with \`docs/auth.md\`, then run the suite:\n\n\`\`\`sh\npnpm install\npnpm test\n\`\`\`\n\nOpen a pull request against \`main\`; CI runs on every push.\n`;
  prDiffs.set(250, () => unifiedPatch('', onboarding, { oldPath: null, newPath: 'docs/onboarding.md' }));

  const pullRequests: PullRequest[] = [
    basePr({
      id: 250, title: 'docs: onboarding guide', state: 'open', author: 'priya',
      source_branch: 'docs/onboarding', target_branch: 'main', source_commit: fakeOid('pr250'),
      created_at: iso(hours(6)), updated_at: iso(min(40)),
      description: 'A short page for new hires. Follows the structure we agreed on in #232.',
      review_status: 'CHANGES_REQUESTED', comment_count: 3, labels: ['docs'],
      reviewers: [{ name: 'dana', status: 'CHANGES_REQUESTED', required: true }],
      checks: [{ name: 'ci / test', status: 'SUCCESS' }, { name: 'lint', status: 'SUCCESS' }],
      ...statsOf(prDiffs.get(250)!()),
      comments: [
        { id: 'c250-1', author: 'dana', avatar_url: null, body: 'Could we link the retry policy section once #248 lands?', created_at: iso(hours(3)), url: `${prUrl(250)}#issuecomment-1`, is_system: false, path: null },
        { id: 'c250-2', author: 'priya', avatar_url: null, body: 'Sure — will add a TODO and follow up after the merge.', created_at: iso(hours(2)), url: `${prUrl(250)}#issuecomment-2`, is_system: false, path: null },
      ],
      review_threads: [{
        id: 't250-1', path: 'docs/onboarding.md', start_line: 3, end_line: 3, side: 'additions', is_resolved: false, is_outdated: false,
        can_reply: true, can_resolve: true, can_unresolve: false,
        comments: [{ id: 'rc250-1', author: 'dana', avatar_url: null, body: 'Mention the `.worktreeinclude` file here — new hires always miss the `.env` step.', created_at: iso(hours(3)), url: `${prUrl(250)}#discussion_r1`, is_system: false, path: 'docs/onboarding.md' }],
      }],
      reviews: [{ id: 'r250-1', author: 'dana', avatar_url: null, state: 'CHANGES_REQUESTED', body: 'One small addition and this is good to go.', submitted_at: iso(hours(3)), url: `${prUrl(250)}#pullrequestreview-1`, can_update: true, can_dismiss: true }],
      commits: [{ id: fakeOid('pr250'), title: 'docs: onboarding guide', author: 'Priya Raman', avatar_url: null, committed_at: iso(hours(6)), url: null }],
    }),
    basePr({
      id: 249, title: 'feat(auth): retry via fetch interceptor (alternative to #248)', state: 'open', is_draft: true, can_mark_ready: true,
      author: 'dana', source_branch: 'feature/auth-retry-b', target_branch: 'main', source_commit: b2,
      created_at: iso(hours(19)), updated_at: iso(hours(2)),
      description: 'Codex\'s take on the same problem: keep retries in an interceptor so the session module stays unaware of transport.\n\nOpening as a draft so we can compare against #248 side by side in Worktrees.',
      merge_status: 'CLEAN', review_status: 'REVIEW_REQUIRED', commit_count: 2, labels: ['auth', 'agent:codex'],
      checks: [{ name: 'ci / test', status: 'SUCCESS' }, { name: 'lint', status: 'PENDING' }],
      ...statsOf(prDiffs.get(249)!()),
      commits: commitsOf(b2, c13),
    }),
    basePr({
      id: 248, title: 'feat(auth): retry transient failures with backoff', state: 'open',
      author: 'dana', source_branch: 'feature/auth-retry', target_branch: 'main', source_commit: a3,
      created_at: iso(hours(26)), updated_at: iso(hours(1)),
      description: 'Token refresh now retries transient failures (network errors, 429, 5xx) with exponential backoff and full jitter.\n\n- `withRetry()` helper with a small `RetryPolicy`\n- session refresh uses it with a 3-attempt budget\n- tests for the budget and transient detection\n\nGenerated with Claude Code, reviewed in Strand.',
      merge_status: 'BEHIND', review_status: 'REVIEW_REQUIRED', comment_count: 2, commit_count: 3, labels: ['auth', 'agent:claude'],
      reviewers: [{ name: 'priya', status: 'REQUESTED', required: true }, { name: 'marco', status: 'APPROVED', required: false }],
      checks: [{ name: 'ci / test', status: 'SUCCESS' }, { name: 'lint', status: 'SUCCESS' }, { name: 'e2e', status: 'PENDING' }],
      ...statsOf(prDiffs.get(248)!()),
      comments: [
        { id: 'c248-1', author: 'marco', avatar_url: null, body: 'Nice. Should we cap the per-attempt delay? Attempt 5 at 250ms base is already 4s.', created_at: iso(hours(5)), url: `${prUrl(248)}#issuecomment-1`, is_system: false, path: null },
        { id: 'c248-2', author: 'dana', avatar_url: null, body: 'Good call — adding `maxDelayMs` now, will push shortly.', created_at: iso(hours(4)), url: `${prUrl(248)}#issuecomment-2`, is_system: false, path: null },
      ],
      review_threads: [{
        id: 't248-1', path: 'src/auth/retry.ts', start_line: 9, end_line: 11, side: 'additions', is_resolved: false, is_outdated: false,
        can_reply: true, can_resolve: true, can_unresolve: false,
        comments: [{ id: 'rc248-1', author: 'marco', avatar_url: null, body: 'A 429 with `Retry-After` should probably honour the header instead of the backoff curve.', created_at: iso(hours(5)), url: `${prUrl(248)}#discussion_r1`, is_system: false, path: 'src/auth/retry.ts' }],
      }],
      reviews: [{ id: 'r248-1', author: 'marco', avatar_url: null, state: 'APPROVED', body: 'LGTM once the cap is in.', submitted_at: iso(hours(5)), url: `${prUrl(248)}#pullrequestreview-1`, can_update: false, can_dismiss: true }],
      commits: commitsOf(a3, c13),
    }),
    basePr({
      id: 244, title: 'fix: invalidate token cache on logout', state: 'merged', author: 'priya',
      source_branch: 'fix/token-cache', target_branch: 'main', source_commit: f1,
      created_at: iso(days(6)), updated_at: iso(days(5)), completed_at: iso(days(5)),
      description: '`clearSession()` also drops the persisted copy. Fixes the "logged out but still logged in after reload" report.',
      review_status: 'APPROVED', comment_count: 1, labels: ['bug'],
      reviewers: [{ name: 'dana', status: 'APPROVED', required: true }],
      checks: [{ name: 'ci / test', status: 'SUCCESS' }, { name: 'lint', status: 'SUCCESS' }],
      ...statsOf(prDiffs.get(244)!()),
      reviews: [{ id: 'r244-1', author: 'dana', avatar_url: null, state: 'APPROVED', body: '', submitted_at: iso(days(5)), url: `${prUrl(244)}#pullrequestreview-1`, can_update: true, can_dismiss: false }],
      commits: commitsOf(f1, c11),
    }),
    basePr({
      id: 241, title: 'chore(deps): bump undici to 6.21', state: 'merged', author: 'marco',
      source_branch: 'chore/undici-6.21', target_branch: 'main', source_commit: c13,
      created_at: iso(days(4)), updated_at: iso(days(3)), completed_at: iso(days(3)),
      description: 'Security release; no API changes.', review_status: 'APPROVED', labels: ['dependencies'],
      reviewers: [{ name: 'dana', status: 'APPROVED', required: true }],
      checks: [{ name: 'ci / test', status: 'SUCCESS' }],
      ...statsOf(prDiffs.get(241)!()),
      commits: commitsOf(c13, c12),
    }),
    basePr({
      id: 236, title: 'spike: edge runtime entrypoint', state: 'closed', author: 'marco',
      source_branch: 'spike/edge-runtime', target_branch: 'main', source_commit: s1,
      created_at: iso(days(33)), updated_at: iso(days(28)), completed_at: iso(days(28)),
      description: 'Exploration only. Closing — we are staying on Node for 1.x.', review_status: 'REVIEW_REQUIRED', labels: ['spike'],
      ...statsOf(prDiffs.get(236)!()),
      commits: commitsOf(s1, c8),
    }),
  ];

  return { repo, pullRequests, prRepository, prDiffs };
}
