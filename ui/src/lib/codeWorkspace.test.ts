import { describe, expect, it } from 'vitest';

import {
  dirnameOf,
  parseCodeWorkspace,
  resolveWorkspaceFolder,
  workspaceNameFromFile,
} from './codeWorkspace';

describe('parseCodeWorkspace', () => {
  it('reads folder paths from a plain document', () => {
    const r = parseCodeWorkspace('{"folders":[{"path":"api"},{"path":"../web"}]}');
    expect(r).toEqual({ folders: ['api', '../web'], ignored: 0 });
  });

  it('tolerates JSONC: comments and trailing commas', () => {
    const text = `{
      // the repos behind the product
      "folders": [
        { "path": "api" }, /* main service */
        { "path": "web", },
      ],
      "settings": {},
    }`;
    expect(parseCodeWorkspace(text).folders).toEqual(['api', 'web']);
  });

  it('does not treat // inside strings as a comment', () => {
    const text = '{"folders":[{"path":"api","name":"http://example.com"}]}';
    expect(parseCodeWorkspace(text).folders).toEqual(['api']);
  });

  it('counts uri-only (remote) and malformed entries as ignored', () => {
    const text =
      '{"folders":[{"uri":"vscode-remote://ssh/x"},{"path":"api"},{"name":"no path"},42]}';
    const r = parseCodeWorkspace(text);
    expect(r.folders).toEqual(['api']);
    expect(r.ignored).toBe(3);
  });

  it('handles a missing or non-array folders key as zero folders', () => {
    expect(parseCodeWorkspace('{}')).toEqual({ folders: [], ignored: 0 });
    expect(parseCodeWorkspace('{"folders":"nope"}')).toEqual({ folders: [], ignored: 0 });
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseCodeWorkspace('{folders:')).toThrow(/valid .code-workspace/);
  });

  it('survives escaped quotes inside strings', () => {
    const text = '{"folders":[{"path":"api","name":"say \\"hi\\" // not a comment"}]}';
    expect(parseCodeWorkspace(text).folders).toEqual(['api']);
  });
});

describe('resolveWorkspaceFolder', () => {
  it('passes absolute paths through untouched', () => {
    expect(resolveWorkspaceFolder('D:\\proj', 'C:\\other\\repo')).toBe('C:\\other\\repo');
    expect(resolveWorkspaceFolder('/home/me', '/srv/repo')).toBe('/srv/repo');
    expect(resolveWorkspaceFolder('D:\\proj', '\\\\server\\share')).toBe('\\\\server\\share');
  });

  it('joins relative paths with the base directory separator style', () => {
    expect(resolveWorkspaceFolder('D:\\proj', 'api')).toBe('D:\\proj\\api');
    expect(resolveWorkspaceFolder('D:\\proj', './api')).toBe('D:\\proj\\api');
    expect(resolveWorkspaceFolder('D:\\proj', 'apps/web')).toBe('D:\\proj\\apps\\web');
    expect(resolveWorkspaceFolder('/home/me/proj', 'api')).toBe('/home/me/proj/api');
  });

  it('resolves "." to the file directory itself', () => {
    expect(resolveWorkspaceFolder('D:\\proj\\', '.')).toBe('D:\\proj');
  });

  it('keeps ".." segments for the OS to resolve', () => {
    expect(resolveWorkspaceFolder('D:\\proj\\meta', '../api')).toBe('D:\\proj\\meta\\..\\api');
  });
});

describe('file-path helpers', () => {
  it('dirnameOf handles both separators', () => {
    expect(dirnameOf('D:\\proj\\acme.code-workspace')).toBe('D:\\proj');
    expect(dirnameOf('/home/me/acme.code-workspace')).toBe('/home/me');
  });

  it('workspaceNameFromFile strips the extension case-insensitively', () => {
    expect(workspaceNameFromFile('D:\\proj\\acme.code-workspace')).toBe('acme');
    expect(workspaceNameFromFile('/x/Client Stack.CODE-WORKSPACE')).toBe('Client Stack');
    expect(workspaceNameFromFile('/x/.code-workspace')).toBe('Workspace');
  });
});
