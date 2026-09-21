import { afterEach, describe, expect, it } from 'vitest';

import {
  consumeTerminalAgentOutput,
  resetTerminalAgentStream,
  terminalIndicatorClass,
} from './terminalAgentActivity';

const encoder = new TextEncoder();

afterEach(() => {
  resetTerminalAgentStream('tab');
});

function osc(payload: string, terminator: 'bel' | 'st' = 'bel'): Uint8Array {
  const end = terminator === 'bel' ? '\x07' : '\x1b\\';
  return encoder.encode(`\x1b]${payload}${end}`);
}

function title(text: string, terminator: 'bel' | 'st' = 'bel'): Uint8Array {
  return osc(`0;${text}`, terminator);
}

function feed(bytes: Uint8Array, tabId = 'tab') {
  return consumeTerminalAgentOutput(tabId, bytes);
}

describe('terminal agent activity from PTY OSC', () => {
  it('leaves ordinary shells on lifecycle-only state', () => {
    expect(feed(encoder.encode('user@host:~/src$ ls\r\n'))).toBeNull();
    expect(feed(title('user@host:~/project'))).toBeNull();
    expect(feed(title('src/codex/README.md'))).toBeNull();
    expect(feed(osc('9;4;1;40'))).toBeNull();
  });

  it('marks Claude Code busy on a braille OSC title and idle on the asterisk marker', () => {
    expect(feed(title('⠂ read the files'))).toEqual({ activity: 'busy' });
    expect(feed(title('⠄ still working'))).toBeNull();
    expect(feed(title('✳ Claude'))).toEqual({ activity: 'idle' });
    expect(feed(title('✱ ready'))).toBeNull();
  });

  it('treats Codex spinner titles as busy and the project-only follow-up as idle', () => {
    expect(feed(title('⠋ strand'))).toEqual({ activity: 'busy' });
    expect(feed(title('strand'))).toEqual({ activity: 'idle' });
  });

  it('recognizes a named Claude title as idle until a busy status arrives', () => {
    expect(feed(title('Claude Code'))).toEqual({ activity: 'idle' });
    expect(feed(title('Thinking...'))).toEqual({ activity: 'busy' });
    expect(feed(title('Ready'))).toEqual({ activity: 'idle' });
  });

  it('recognizes a named Codex title as idle', () => {
    expect(feed(title('codex'), 'codex-tab')).toEqual({ activity: 'idle' });
    resetTerminalAgentStream('codex-tab');
  });

  it('does not treat a lone Working... title as an agent', () => {
    expect(feed(title('Working...'))).toBeNull();
  });

  it('ignores OSC 9;4 until the session is a recognized agent', () => {
    expect(feed(osc('9;4;3'))).toBeNull();
    expect(feed(title('codex'))).toEqual({ activity: 'idle' });
    expect(feed(osc('9;4;1;12'))).toEqual({ activity: 'busy' });
    expect(feed(osc('9;4;0'))).toEqual({ activity: 'idle' });
  });

  it('reassembles an OSC title split across PTY chunks', () => {
    const bytes = title('⠋ home', 'st');
    expect(feed(bytes.subarray(0, 6))).toBeNull();
    expect(feed(bytes.subarray(6))).toEqual({ activity: 'busy' });
  });

  it('drops agent overlay when a shell title returns after the CLI exits', () => {
    expect(feed(title('⠋ strand'))).toEqual({ activity: 'busy' });
    expect(feed(title('user@host:~/strand'))).toEqual({ activity: null });
    expect(feed(title('user@host:~/strand'))).toBeNull();
  });

  it('resets stream state so a relaunched tab cannot inherit busy', () => {
    expect(feed(title('⠋ strand'))).toEqual({ activity: 'busy' });
    resetTerminalAgentStream('tab');
    expect(feed(title('user@host:~'))).toBeNull();
  });
});

describe('terminalIndicatorClass', () => {
  it('keeps lifecycle classes for plain shells', () => {
    expect(terminalIndicatorClass('running', null)).toBe('work-terminal-state running');
    expect(terminalIndicatorClass('dormant', null)).toBe('work-terminal-state dormant');
    expect(terminalIndicatorClass('starting', 'busy')).toBe('work-terminal-state starting');
    expect(terminalIndicatorClass('exited', null)).toBe('work-terminal-state exited');
    expect(terminalIndicatorClass('exited', null, 0)).toBe('work-terminal-state exited');
    expect(terminalIndicatorClass('error', null)).toBe('work-terminal-state error');
  });

  it('overlays agent-busy and agent-idle only while the PTY is running', () => {
    expect(terminalIndicatorClass('running', 'busy')).toBe('work-terminal-state running agent-busy');
    expect(terminalIndicatorClass('running', 'idle')).toBe('work-terminal-state running agent-idle');
  });

  it('marks non-zero exits as failed', () => {
    expect(terminalIndicatorClass('exited', null, 1)).toBe('work-terminal-state exited failed');
    expect(terminalIndicatorClass('exited', 'idle', 130)).toBe('work-terminal-state exited failed');
  });
});
