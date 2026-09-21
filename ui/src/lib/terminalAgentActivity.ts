/** Agent busy vs turn-idle for Workbench terminal tabs.
 *
 * Claude Code and Codex CLI already emit OSC 0/2 titles (and sometimes
 * OSC 9;4 progress) on the existing PTY stream. Strand does not add a
 * second IPC path: parse those sequences from output bytes, and keep
 * unknown CLIs on lifecycle-only dots. False "busy" is worse than green.
 */

import type { TerminalAgentActivity, TerminalLifecycle } from './workTabs';

export type { TerminalAgentActivity };

export type AgentActivityUpdate = {
  activity: TerminalAgentActivity | null;
};

const ESC = 0x1b;
const BEL = 0x07;
const OSC_INTRODUCER = 0x5d; // ]
const ST_FINAL = 0x5c; // \
const MAX_LEFTOVER = 1_024;
const MAX_PAYLOAD = 512;

/** Braille-pattern block used as the working spinner prefix (CC + Codex). */
const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28FF;

/** Asterisk-family idle markers Claude Code prefixes onto OSC titles. */
const IDLE_MARKERS = new Set([0x2731, 0x2733, 0x273b, 0x273d]);

const BUSY_STATUS = /^(Starting|Thinking|Working|Waiting|Undoing)\.\.\.$/;
const NAMED_AGENT = /^(?:claude(?:\s+code)?|codex)(?:$|[\s—\-:])/i;
const SHELL_TITLE = /^[\w.-]+@[\w.-]+:/;

type Detector = {
  leftover: Uint8Array;
  recognized: boolean;
  activity: TerminalAgentActivity | null;
};

const streams = new Map<string, Detector>();

export function resetTerminalAgentStream(tabId: string): void {
  streams.delete(tabId);
}

export function consumeTerminalAgentOutput(
  tabId: string,
  bytes: Uint8Array,
): AgentActivityUpdate | null {
  if (bytes.length === 0) return null;
  const detector = streams.get(tabId) ?? {
    leftover: new Uint8Array(0),
    recognized: false,
    activity: null,
  };
  const before = detector.activity;

  if (detector.leftover.length === 0 && bytes.indexOf(ESC) < 0) {
    return null;
  }

  const { leftover, commands } = parseOscSequences(concat(detector.leftover, bytes));
  detector.leftover = leftover;
  for (const command of commands) applyOsc(detector, command);
  streams.set(tabId, detector);

  if (detector.activity === before) return null;
  return { activity: detector.activity };
}

export function terminalIndicatorClass(
  lifecycle: TerminalLifecycle,
  activity: TerminalAgentActivity | null,
  exitCode: number | null = null,
): string {
  const parts = ['work-terminal-state', lifecycle];
  if (lifecycle === 'running' && activity === 'busy') parts.push('agent-busy');
  if (lifecycle === 'running' && activity === 'idle') parts.push('agent-idle');
  if (lifecycle === 'exited' && (exitCode ?? 0) !== 0) parts.push('failed');
  return parts.join(' ');
}

function applyOsc(detector: Detector, command: OscCommand): void {
  if (command.kind === 'progress') {
    if (!detector.recognized) return;
    if (command.state === 1 || command.state === 3) detector.activity = 'busy';
    else detector.activity = 'idle';
    return;
  }
  applyTitle(detector, command.text);
}

function applyTitle(detector: Detector, raw: string): void {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return;

  const first = title.codePointAt(0);
  if (first != null && first >= BRAILLE_MIN && first <= BRAILLE_MAX) {
    detector.recognized = true;
    detector.activity = 'busy';
    return;
  }

  const rest = stripIdleMarker(title);
  if (BUSY_STATUS.test(rest) && (detector.recognized || NAMED_AGENT.test(rest))) {
    detector.recognized = true;
    detector.activity = 'busy';
    return;
  }

  if (first != null && IDLE_MARKERS.has(first)) {
    detector.recognized = true;
    detector.activity = 'idle';
    return;
  }

  if (NAMED_AGENT.test(title) || NAMED_AGENT.test(rest)) {
    detector.recognized = true;
    detector.activity = BUSY_STATUS.test(rest) ? 'busy' : 'idle';
    return;
  }

  if (SHELL_TITLE.test(title)) {
    detector.recognized = false;
    detector.activity = null;
    return;
  }

  if (detector.recognized) detector.activity = 'idle';
}

function stripIdleMarker(title: string): string {
  const first = title.codePointAt(0);
  if (first == null) return title;
  if (!IDLE_MARKERS.has(first) && (first < BRAILLE_MIN || first > BRAILLE_MAX)) return title;
  return title.slice(String.fromCodePoint(first).length).trim();
}

type OscCommand =
  | { kind: 'title'; text: string }
  | { kind: 'progress'; state: number };

function parseOscSequences(input: Uint8Array): { leftover: Uint8Array; commands: OscCommand[] } {
  const commands: OscCommand[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] !== ESC) {
      i += 1;
      continue;
    }
    if (i + 1 >= input.length) {
      return { leftover: capLeftover(input.subarray(i)), commands };
    }
    if (input[i + 1] !== OSC_INTRODUCER) {
      i += 1;
      continue;
    }
    let j = i + 2;
    let terminator = -1;
    let next = -1;
    while (j < input.length) {
      if (input[j] === BEL) {
        terminator = j;
        next = j + 1;
        break;
      }
      if (input[j] === ESC && j + 1 < input.length && input[j + 1] === ST_FINAL) {
        terminator = j;
        next = j + 2;
        break;
      }
      if (j - (i + 2) > MAX_PAYLOAD) break;
      j += 1;
    }
    if (terminator < 0) {
      if (input.length - i > MAX_LEFTOVER) {
        i += 1;
        continue;
      }
      return { leftover: capLeftover(input.subarray(i)), commands };
    }
    const command = classifyOsc(input.subarray(i + 2, terminator));
    if (command) commands.push(command);
    i = next;
  }
  return { leftover: new Uint8Array(0), commands };
}

function classifyOsc(payloadBytes: Uint8Array): OscCommand | null {
  if (payloadBytes.length === 0) return null;
  let payload: string;
  try {
    payload = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    return null;
  }
  if (payload.startsWith('0;') || payload.startsWith('1;') || payload.startsWith('2;')) {
    return { kind: 'title', text: payload.slice(2) };
  }
  if (payload.startsWith('9;4;')) {
    const state = Number.parseInt(payload.slice(4), 10);
    if (state === 0 || state === 1 || state === 2 || state === 3 || state === 4) {
      return { kind: 'progress', state };
    }
  }
  return null;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const next = new Uint8Array(left.length + right.length);
  next.set(left, 0);
  next.set(right, left.length);
  return next;
}

function capLeftover(bytes: Uint8Array): Uint8Array {
  return bytes.length > MAX_LEFTOVER ? new Uint8Array(0) : bytes.slice();
}
