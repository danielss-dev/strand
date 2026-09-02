/**
 * A scripted shell for the demo's Workbench terminal. It is not a process:
 * it echoes a prompt, understands a handful of commands against the demo
 * repository, and streams a canned Claude Code session for `claude`.
 */

import type { TerminalEvent } from '../lib/types';
import type { DemoRepo, DemoWorktree } from './git';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${RESET}`;
const bold = (s: string) => `${ESC}1m${s}${RESET}`;
const green = (s: string) => `${ESC}32m${s}${RESET}`;
const yellow = (s: string) => `${ESC}33m${s}${RESET}`;
const blue = (s: string) => `${ESC}34m${s}${RESET}`;
const red = (s: string) => `${ESC}31m${s}${RESET}`;

export class DemoTerminal {
  private line = '';
  private busy = false;
  private closed = false;

  constructor(
    private readonly repo: DemoRepo,
    private readonly wt: DemoWorktree,
    private readonly emit: (event: TerminalEvent) => void,
  ) {
    setTimeout(() => {
      this.write(`${dim('Strand web demo — a scripted shell, not a real process. Try: ls, git status, git log, cat <file>, claude, help')}\r\n`);
      this.prompt();
    }, 60);
  }

  /** The PTY bridge ships raw bytes as base64; Work.tsx decodes before xterm. */
  private write(data: string): void {
    if (this.closed) return;
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    this.emit({ type: 'output', data: btoa(binary) });
  }

  private prompt(): void {
    const dir = this.wt.path.replace(/^\/Users\/dana/, '~');
    this.write(`${green('dana@demo')} ${blue(dir)} ${yellow(`(${this.wt.branch ?? 'HEAD'})`)} $ `);
  }

  input(data: string): void {
    if (this.busy) {
      if (data === '\x03') { this.busy = false; this.write(`^C\r\n`); this.prompt(); }
      return;
    }
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];
      if (ch === '\x1b') {
        // Skip CSI sequences (arrow keys etc.).
        const rest = data.slice(i + 1);
        const m = rest.match(/^\[[0-9;]*[A-Za-z~]/);
        if (m) i += m[0].length;
        continue;
      }
      if (ch === '\r') {
        this.write('\r\n');
        const cmd = this.line;
        this.line = '';
        void this.run(cmd.trim());
        return;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) { this.line = this.line.slice(0, -1); this.write('\b \b'); }
        continue;
      }
      if (ch === '\x03') { this.line = ''; this.write('^C\r\n'); this.prompt(); continue; }
      if (ch === '\x0c') { this.write(`${ESC}2J${ESC}H`); this.prompt(); continue; }
      if (ch >= ' ') { this.line += ch; this.write(ch); }
    }
  }

  close(): void {
    this.closed = true;
  }

  private async run(cmd: string): Promise<void> {
    if (cmd === '') { this.prompt(); return; }
    const [name, ...args] = cmd.split(/\s+/);
    const out = (s: string) => this.write(`${s.replace(/\n/g, '\r\n')}\r\n`);
    switch (name) {
      case 'help':
        out(`${bold('demo shell')}\n  ls [dir]        list files\n  cat <file>      print a file\n  pwd             working directory\n  git status|log|branch|diff --stat\n  claude          run a scripted Claude Code turn\n  clear`);
        break;
      case 'pwd': out(this.wt.path); break;
      case 'clear': this.write(`${ESC}2J${ESC}H`); break;
      case 'echo': out(args.join(' ')); break;
      case 'ls': out(this.ls(args[0] ?? '')); break;
      case 'cat': {
        const text = args[0] ? this.wt.workdir.get(args[0]) ?? this.wt.ignored.get(args[0]) : undefined;
        out(text == null ? red(`cat: ${args[0] ?? ''}: No such file or directory`) : text.replace(/\n$/, ''));
        break;
      }
      case 'git': out(this.git(args)); break;
      case 'pnpm':
      case 'npm':
        if (args[0] === 'test') { await this.stream(TEST_RUN); break; }
        out(dim(`${name} ${args.join(' ')} — not available in the web demo`));
        break;
      case 'claude': await this.stream(CLAUDE_SESSION); break;
      case 'exit': this.emit({ type: 'exit', code: 0 }); this.closed = true; return;
      default: out(red(`zsh: command not found: ${name}`));
    }
    this.prompt();
  }

  private ls(dir: string): string {
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const names = new Set<string>();
    for (const path of [...this.wt.workdir.keys(), ...this.wt.ignored.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash === -1 ? rest : blue(`${rest.slice(0, slash)}/`));
    }
    return [...names].sort().join('  ');
  }

  private git(args: string[]): string {
    const status = this.repo.status(this.wt);
    switch (args[0]) {
      case 'status': {
        const staged = status.filter((s) => s.staged);
        const unstaged = status.filter((s) => !s.staged && s.kind !== 'UNTRACKED');
        const untracked = status.filter((s) => s.kind === 'UNTRACKED');
        const lines = [`On branch ${this.wt.branch ?? 'HEAD (detached)'}`];
        if (staged.length) lines.push('', 'Changes to be committed:', ...staged.map((s) => green(`\t${s.kind.toLowerCase()}:   ${s.path}`)));
        if (unstaged.length) lines.push('', 'Changes not staged for commit:', ...unstaged.map((s) => red(`\t${s.kind.toLowerCase()}:   ${s.path}`)));
        if (untracked.length) lines.push('', 'Untracked files:', ...untracked.map((s) => red(`\t${s.path}`)));
        if (!status.length) lines.push('', 'nothing to commit, working tree clean');
        return lines.join('\n');
      }
      case 'log':
        return this.repo.log(this.wt, 12, true)
          .map((c) => `${yellow(c.short_hash)} ${c.subject} ${dim(`(${c.author_name})`)}`).join('\n');
      case 'branch':
        return [...this.repo.branches.keys()].sort()
          .map((b) => (b === this.wt.branch ? green(`* ${b}`) : `  ${b}`)).join('\n');
      case 'diff': {
        const diffs = this.repo.diffUnstaged(this.wt);
        if (args[1] === '--stat') {
          return [...diffs.map((d) => ` ${d.path} | ${d.adds + d.dels} ${green('+'.repeat(Math.min(d.adds, 30)))}${red('-'.repeat(Math.min(d.dels, 30)))}`),
            ` ${diffs.length} files changed`].join('\n');
        }
        return diffs.map((d) => d.patch).join('').replace(/\n$/, '') || dim('(no unstaged changes)');
      }
      default:
        return dim(`git ${args.join(' ')} — this shell only scripts status, log, branch and diff. Use Strand for the rest.`);
    }
  }

  private async stream(script: Array<[number, string]>): Promise<void> {
    this.busy = true;
    for (const [delay, text] of script) {
      if (!this.busy || this.closed) return;
      await new Promise((r) => setTimeout(r, delay));
      this.write(text.replace(/\n/g, '\r\n'));
    }
    this.busy = false;
  }
}

const TEST_RUN: Array<[number, string]> = [
  [200, `${dim('> acme-api@1.5.0 test')}\n${dim('> vitest run')}\n\n`],
  [500, ` ${green('✓')} tests/session.test.ts ${dim('(3 tests) 12ms')}\n`],
  [350, ` ${green('✓')} tests/retry.test.ts ${dim('(3 tests) 41ms')}\n\n`],
  [120, ` Test Files  ${green('2 passed')} (2)\n      Tests  ${green('6 passed')} (6)\n   Duration  ${dim('412ms')}\n\n`],
];

const CLAUDE_SESSION: Array<[number, string]> = [
  [300, `${bold('╭─ Claude Code')} ${dim('v1.0 · claude-sonnet-4-5 · ~/code/acme-api')}\n`],
  [400, `${dim('│')} ${bold('>')} Add a maxDelayMs cap to the retry policy and cover it in tests\n\n`],
  [900, `${dim('│')} ${yellow('●')} Reading ${dim('src/auth/retry.ts')}\n`],
  [700, `${dim('│')} ${yellow('●')} Reading ${dim('tests/retry.test.ts')}\n`],
  [1200, `${dim('│')} ${green('●')} Edited ${dim('src/auth/retry.ts')} ${dim('(+9 −4)')}\n`],
  [900, `${dim('│')} ${green('●')} Created ${dim('src/auth/backoff.ts')} ${dim('(+9)')}\n`],
  [800, `${dim('│')} ${green('●')} Edited ${dim('tests/retry.test.ts')} ${dim('(+6)')}\n`],
  [1000, `${dim('│')} ${green('●')} Ran ${dim('pnpm test')} → 6 passed\n\n`],
  [600, `${dim('│')} I added a \`maxDelayMs\` field (default 4 s) and moved the delay math into\n${dim('│')} \`backoffDelay()\` so it can be unit-tested without timers. The exhausted\n${dim('│')} path now throws \`RetryExhaustedError\` with the last error as \`cause\`.\n${dim('│')}\n${dim('│')} Review the changes in Strand's Review view — nothing is committed yet.\n${dim('╰─')} ${dim('4 files changed · 2m 14s')}\n\n`],
];
