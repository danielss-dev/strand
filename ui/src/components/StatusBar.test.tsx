import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, value); },
};
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('window', { localStorage: storage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });

const { StatusBar, StatusBarFileEncoding } = await import('./StatusBar');
const { detectFromFileContent } = await import('../lib/fileEncoding');
const { t } = await import('../lib/i18n');
const { useRepo } = await import('../stores/repo');

const original = useRepo.getState();

afterEach(() => {
  useRepo.setState(original, true);
});

describe('StatusBar', () => {
  it('renders no encoding label when no file is selected', () => {
    useRepo.setState({ selectedFile: null, selectedFileIsDirectory: false });
    const html = renderToStaticMarkup(<StatusBar onOpenSettings={() => {}} />);
    expect(html).not.toContain('UTF-8');
    expect(html).not.toContain('LF');
    expect(html).not.toContain('CRLF');
  });

  it('does not claim LF while selected-file content has not been detected', () => {
    useRepo.setState({
      selectedFile: 'win.txt',
      selectedFileIsDirectory: false,
      activePath: '/repo',
    });
    const html = renderToStaticMarkup(<StatusBar onOpenSettings={() => {}} />);
    expect(html).not.toContain('UTF-8');
    expect(html).not.toContain('LF');
    expect(html).not.toContain('CRLF');
  });

  it('renders CRLF for CRLF file content', () => {
    const info = detectFromFileContent({
      text: 'one\r\ntwo\r\n',
      binary: false,
      editable: true,
      truncated: false,
    });
    const html = renderToStaticMarkup(<StatusBarFileEncoding info={info} />);
    expect(html).toContain(t('status.lineEnding.crlf'));
    expect(html).toContain(t('status.encoding.utf8'));
    expect(html).not.toContain('UTF-8 · LF');
  });
});
