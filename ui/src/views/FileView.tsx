import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { File as PierreFile } from '@pierre/diffs/react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { Diff } from '../components/Diff';
import { FileSearchBar, focusFileSearchInput } from '../components/FileSearchBar';
import { Icon, type IconName } from '../components/Icon';
import { ImageDiff, ImagePreview, useBlob } from '../components/ImageDiff';
import { imageMime, isImagePath } from '../lib/image';
import { renderMarkdown } from '../lib/markdown';
import { isPreviewablePath, isSvgPath } from '../lib/preview';
import { repoFamilyName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import { tokenizeFile, type HlToken, type HlTheme } from '../lib/highlight';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import type { BlameLine, FileContent, FileDiff, FileHistoryEntry } from '../lib/types';

type Tab = 'content' | 'preview' | 'history' | 'compare' | 'blame';

/** Sentinel "revision" for the working-tree (uncommitted) entry in History.
 *  Any non-hex string works — it never reaches git (the working-tree branch
 *  calls `repoDiffWorkdirFile`), it only needs to differ from real OIDs. */
const WORKING = 'working-tree';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'content', label: 'Content', icon: 'content' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'compare', label: 'Compare', icon: 'compare' },
  { id: 'blame',   label: 'Blame',   icon: 'blame' },
];

/**
 * Tabbed file view (PRD §6.5), wired to `strand-core`:
 * - **Content** — the working-tree file or selected revision,
 *   syntax-highlighted via Pierre's `<File>`.
 * - **Preview** — rendered form of a renderable text file (SVG as an image,
 *   markdown as a document); the tab only shows for those files.
 * - **History** — `git log --follow` for the path; selecting a commit shows
 *   this file's change there, double-click jumps to it in the graph.
 * - **Compare** — diff this file between two of its revisions.
 * - **Blame** — per-line authorship; click a line to jump to its commit.
 *
 * Opened from the Files sidebar tab or the command palette (`selectFile`).
 */
export function FileView({ path }: { path: string }) {
  const activePath = useRepo((s) => s.activePath);
  const revision = useRepo((s) => s.selectedFileRevision);
  const meta = useRepo((s) => s.meta);
  const repoName = repoFamilyName(meta);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  // Tab + jump live in the store so a blame/history → commit jump can return
  // here (Back bar) at the same tab.
  const tab = useRepo((s) => s.fileTab);
  const setTab = useRepo((s) => s.setFileTab);
  const jumpToCommit = useRepo((s) => s.jumpFromFile);
  const diffSearchSignal = useRepo((s) => s.diffSearchSignal);
  const clearDiffSearch = useRepo((s) => s.clearDiffSearch);
  const [searchOpen, setSearchOpen] = useState(false);

  const close = () => { setView('local'); selectFile(null); };

  const previewable = isPreviewablePath(path);
  const tabs = previewable ? TABS : TABS.filter((t) => t.id !== 'preview');
  // Defensive: the store can only hold 'preview' while a previewable file is
  // open (selectFile only picks it for previewable paths), but fall back
  // rather than render an empty body if that ever changes.
  const active = tab === 'preview' && !previewable ? 'content' : tab;

  const openSearch = useCallback(() => {
    if (active !== 'content') setTab('content');
    setSearchOpen(true);
    focusFileSearchInput();
  }, [active, setTab]);

  useEffect(() => {
    if (!diffSearchSignal) return;
    openSearch();
    clearDiffSearch();
  }, [diffSearchSignal, openSearch, clearDiffSearch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="combobox"], .palette-backdrop')) return;
      e.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  return (
    <div className="main">
      <div className="main-header">
        <div className="crumb">
          <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {repoName}
          </span>
          <span className="sep"><Icon name="chev-right" size={10} /></span>
          <span className="leaf" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} title={path}>
            {path}
          </span>
          {revision && <span className="ref-chip head">{revision.slice(0, 7)}</span>}
        </div>
        <div className="h-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            title="Close file"
            aria-label="Close file"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div className="tab-strip" role="tablist">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={'tab' + (active === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={13} className="tab-ico" />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="fv-body">
        {/* `key={path}` resets each tab's internal load state when the file changes. */}
        {active === 'content' && (
          <ContentTab
            key={path}
            path={path}
            repoPath={activePath}
            revision={revision}
            searchOpen={searchOpen}
            onCloseSearch={() => setSearchOpen(false)}
          />
        )}
        {active === 'preview' && (
          <PreviewTab key={path} path={path} repoPath={activePath} revision={revision} />
        )}
        {active === 'history' && <HistoryTab key={path} path={path} repoPath={activePath} onJump={jumpToCommit} />}
        {active === 'compare' && <CompareTab key={path} path={path} repoPath={activePath} />}
        {active === 'blame' && <BlameTab key={path} path={path} repoPath={activePath} onJump={jumpToCommit} />}
      </div>
    </div>
  );
}

function FvEmpty({ children }: { children: React.ReactNode }) {
  return <div className="fv-empty">{children}</div>;
}

// ─── Content ──────────────────────────────────────────────────────────────

function ContentTab({
  path,
  repoPath,
  revision,
  searchOpen,
  onCloseSearch,
}: {
  path: string;
  repoPath: string | null;
  revision: string | null;
  searchOpen: boolean;
  onCloseSearch: () => void;
}) {
  const pierreTheme = useSettings((s) => s.resolvedTheme) === 'light' ? 'pierre-light' : 'pierre-dark';
  const [data, setData] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectLine = useCallback((line: number | null) => setSelectedLine(line), []);

  useEffect(() => {
    if (selectedLine == null || !data) return;
    let attempts = 0;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = () => {
      if (cancelled) return;
      const host = scrollRef.current;
      if (!host) return;
      const container = host.querySelector('diffs-container');
      const row = container?.shadowRoot?.querySelector<HTMLElement>(
        `[data-line][data-line-index="${selectedLine - 1}"]`,
      );
      if (row) {
        const rr = row.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        host.scrollTo({ top: host.scrollTop + rr.top - hr.top - (host.clientHeight - rr.height) / 2 });
        return;
      }
      const total = Math.max(1, data.text.split('\n').length);
      host.scrollTo({ top: ((selectedLine - 0.5) / total) * host.scrollHeight - host.clientHeight / 2 });
      if (++attempts < 12) timer = window.setTimeout(attempt, 120);
    };
    const frame = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [selectedLine, data]);

  const closeSearch = useCallback(() => {
    setSelectedLine(null);
    onCloseSearch();
  }, [onCloseSearch]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    tauri
      .repoFileContent(repoPath, path, revision)
      .then((c) => { if (!cancelled) setData(c); })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, path, revision]);

  if (loading) return <FvEmpty>Loading…</FvEmpty>;
  if (error) return <FvEmpty>{error}</FvEmpty>;
  if (!data) return <FvEmpty>No content.</FvEmpty>;
  if (data.binary) {
    // Images get a checkerboard preview of the working-tree file; other
    // binaries stay a note.
    return isImagePath(path) ? (
      <div className="fv-tab">
        <ImagePreview path={path} src={{ rev: revision }} />
      </div>
    ) : (
      <FvEmpty>Binary file — no preview.</FvEmpty>
    );
  }

  // `disableBackground` keeps Pierre's surface on our tokens (honored at
  // runtime; not in `FileOptions`' type, so we build the object outside the
  // JSX to skip the excess-property check — same as MergeResolver).
  const opts = { theme: pierreTheme, disableBackground: true, disableFileHeader: true };
  return (
    <div className="fv-tab diff-search-host">
      {data.truncated && (
        <div className="fv-banner">Large file — showing the first part only.</div>
      )}
      {searchOpen && (
        <FileSearchBar text={data.text} onSelect={selectLine} onClose={closeSearch} />
      )}
      <div className="fv-pierre" ref={scrollRef}>
        <PierreFile
          file={{ name: path, contents: data.text }}
          options={opts}
          selectedLines={selectedLine == null ? null : { start: selectedLine, end: selectedLine }}
        />
      </div>
    </div>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────

/**
 * Rendered preview for renderable text files. SVG reuses the image pipeline
 * (a data-URL'd SVG in an `<img>` never executes scripts); markdown renders
 * through `lib/markdown` (React elements only — repo content can't inject
 * HTML into the webview).
 */
function PreviewTab({
  path,
  repoPath,
  revision,
}: {
  path: string;
  repoPath: string | null;
  revision: string | null;
}) {
  if (isSvgPath(path)) {
    return (
      <div className="fv-tab">
        <ImagePreview path={path} src={{ rev: revision }} />
      </div>
    );
  }
  return <MarkdownPreview path={path} repoPath={repoPath} revision={revision} />;
}

function MarkdownPreview({
  path,
  repoPath,
  revision,
}: {
  path: string;
  repoPath: string | null;
  revision: string | null;
}) {
  const selectFile = useRepo((s) => s.selectFile);
  const setFileTab = useRepo((s) => s.setFileTab);
  // Re-fetch when the watcher refreshes — the agent-review loop edits docs
  // under us, and a stale preview defeats its purpose.
  const diffsTick = useRepo((s) => s.diffsTick);
  const refetchKey = revision ? 0 : diffsTick;
  const [data, setData] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    // Keep the previous render while revalidating; only the first load (data
    // still null) shows the placeholder.
    tauri
      .repoFileContent(repoPath, path, revision)
      .then((c) => { if (!cancelled) { setData(c); setError(null); } })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [repoPath, path, revision, refetchKey]);

  const dir = useMemo(() => {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
  }, [path]);

  const rendered = useMemo(() => {
    if (!data || data.binary) return null;
    return renderMarkdown(data.text, {
      onLinkClick: (href) => {
        if (/^(https?:|mailto:)/i.test(href)) { void shellOpen(href); return; }
        if (href.startsWith('#')) return; // in-document anchors: no heading ids in v1
        const target = resolveRelative(dir, href);
        if (!target) return;
        selectFile(target, revision);
        // Stay in reading mode across doc → doc links even when the
        // `fileOpenTab` setting opens files on the raw source.
        if (isPreviewablePath(target)) setFileTab('preview');
      },
      renderImage: (src, alt, key) => {
        if (/^(https?:|data:image\/)/i.test(src)) {
          return <img key={key} className="md-img" src={src} alt={alt} loading="lazy" />;
        }
        const target = resolveRelative(dir, src);
        return target && isImagePath(target) ? (
          <RepoImage key={key} path={target} alt={alt} revision={revision} />
        ) : (
          <span key={key} className="md-img-fallback">{alt || src}</span>
        );
      },
      renderMermaid: (code, key) => <Mermaid key={key} code={code} />,
    });
  }, [data, dir, revision, selectFile, setFileTab]);

  if (error && !data) return <FvEmpty>{error}</FvEmpty>;
  if (!data) return <FvEmpty>Loading…</FvEmpty>;
  if (data.binary) return <FvEmpty>Binary file — no preview.</FvEmpty>;

  return (
    <div className="fv-tab">
      {data.truncated && (
        <div className="fv-banner">Large file — previewing the first part only.</div>
      )}
      <div className="fv-md">
        <div className="md-render">{rendered}</div>
      </div>
    </div>
  );
}

/** Repo-relative image referenced from a markdown file, read at its revision. */
function RepoImage({ path, alt, revision }: { path: string; alt: string; revision: string | null }) {
  const state = useBlob(path, { rev: revision });
  if (state.kind === 'loading') return null;
  if (state.kind !== 'ok' || state.blob.too_large) {
    return <span className="md-img-fallback" title={path}>{alt || basename(path)}</span>;
  }
  return (
    <img
      className="md-img"
      src={`data:${imageMime(path)};base64,${state.blob.base64}`}
      alt={alt}
    />
  );
}

/**
 * Renders a ```mermaid fence as an SVG diagram. Mermaid is heavy (its own
 * parser + d3) and most docs carry no diagrams, so it's dynamically imported
 * the first time one renders and never weighs on the main bundle. Rendered
 * under `securityLevel: 'strict'` — mermaid runs the output through DOMPurify,
 * so injecting its SVG is safe even though the source is untrusted repo
 * content (this is the one sanctioned exception to the renderer's
 * no-HTML-strings rule). Re-renders on theme flips so the diagram tracks
 * light/dark; a parse error falls back to the raw source, never a blank box.
 */
function Mermaid({ code }: { code: string }) {
  const theme = useSettings((s) => s.resolvedTheme);
  // mermaid's internal temp-node id is fed to querySelector, so it must be a
  // valid token — useId()'s colons aren't, strip them.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        const out = await mermaid.render(id, code);
        if (!cancelled) setSvg(out.svg);
      })
      .catch((e) => {
        if (!cancelled) { setSvg(null); setError(errMessage(e)); }
      });
    return () => { cancelled = true; };
  }, [code, theme, id]);

  if (error != null) {
    return (
      <pre className="md-pre md-mermaid-error" data-lang="mermaid" title={error}>
        <code>{code}</code>
      </pre>
    );
  }
  if (svg == null) return <div className="md-mermaid" aria-busy="true" />;
  // eslint-disable-next-line react/no-danger -- DOMPurify-sanitized by mermaid's strict mode.
  return <div className="md-mermaid" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Resolve a markdown-relative href/src against the file's directory into a
 * repo-relative path. Returns null for empty targets or ones that escape the
 * repo root (the backend's canonicalize guard would reject them anyway).
 */
function resolveRelative(fromDir: string, href: string): string | null {
  let target = href.split(/[?#]/)[0];
  if (!target) return null;
  try { target = decodeURI(target); } catch { /* keep the raw form */ }
  target = target.replace(/\\/g, '/');
  // A leading slash means repo-root-relative (the GitHub convention).
  const parts = target.startsWith('/') ? [] : fromDir ? fromDir.split('/') : [];
  for (const seg of target.replace(/^\//, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? parts.join('/') : null;
}

// ─── Blame ──────────────────────────────────────────────────────────────

function BlameTab({
  path,
  repoPath,
  onJump,
}: {
  path: string;
  repoPath: string | null;
  onJump: (hash: string) => void;
}) {
  const [lines, setLines] = useState<BlameLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLines(null);
    tauri
      .repoBlame(repoPath, path)
      .then((b) => { if (!cancelled) setLines(b); })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, path]);

  if (loading) return <FvEmpty>Computing blame…</FvEmpty>;
  if (error) return <FvEmpty>{error}</FvEmpty>;
  if (!lines || lines.length === 0) return <FvEmpty>No blame information.</FvEmpty>;

  return <BlameList lines={lines} path={path} onJump={onJump} />;
}

/**
 * Fixed-height virtual list for blame. Rows are exactly `ROW`px tall (matching
 * `.blame-line` line-height in features.css), so we mount only the slice near
 * the viewport (plus overscan) regardless of file size — blame can be up to
 * 50k lines server-side, and rendering that many interactive rows would freeze
 * the main thread and flood Tab navigation with focusables.
 */
const ROW = 18;
const OVERSCAN = 24;

function BlameList({
  lines,
  path,
  onJump,
}: {
  lines: BlameLine[];
  path: string;
  onJump: (hash: string) => void;
}) {
  const hlTheme: HlTheme =
    useSettings((s) => s.resolvedTheme) === 'light' ? 'pierre-light' : 'pierre-dark';
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [tokens, setTokens] = useState<HlToken[][] | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tokenize the file once (rows index into the per-line tokens). Reconstructed
  // from the blame line contents, so token line `i` aligns with `lines[i]`.
  const code = useMemo(() => lines.map((l) => l.content).join('\n'), [lines]);
  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    void tokenizeFile(code, path, hlTheme).then((t) => { if (!cancelled) setTokens(t); });
    return () => { cancelled = true; };
  }, [code, path, hlTheme]);

  const total = lines.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + (viewH || ROW * 40)) / ROW) + OVERSCAN);

  const rows = [];
  for (let i = start; i < end; i++) {
    const l = lines[i];
    // Hide the blame gutter on a run of consecutive lines from one commit.
    const cont = i > 0 && l.commit !== '' && lines[i - 1].commit === l.commit;
    const interactive = l.commit !== '';
    const lineTokens = tokens?.[i];
    rows.push(
      <div
        key={l.line_no}
        className={'blame-line' + (cont ? ' continuation' : '')}
        onClick={interactive ? () => onJump(l.commit) : undefined}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onJump(l.commit);
                }
              }
            : undefined
        }
        title={interactive ? `${l.short} - ${l.author} - ${l.summary}` : undefined}
      >
        <div className="blame">
          <span className="avatar" style={{ background: avatarBg(l.author_email || l.author) }}>
            {initials(l.author)}
          </span>
          <span className="author">{l.author}</span>
          <span className="hash">{l.short}</span>
        </div>
        <span className="ln">{l.line_no}</span>
        <span className="code">
          {lineTokens && lineTokens.length > 0
            ? lineTokens.map((t, j) => (
                <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>
              ))
            : l.content || ' '}
        </span>
      </div>,
    );
  }

  // Top/bottom spacer rows in normal flow (rather than absolute positioning)
  // so a long `white-space: pre` code line still expands its row and drives
  // horizontal scroll, exactly as the non-virtualized list did.
  return (
    <div className="fv-tab">
      <div
        className="fv-content"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: start * ROW }} aria-hidden />
        {rows}
        <div style={{ height: (total - end) * ROW }} aria-hidden />
      </div>
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────

function HistoryTab({
  path,
  repoPath,
  onJump,
}: {
  path: string;
  repoPath: string | null;
  onJump: (hash: string) => void;
}) {
  const status = useRepo((s) => s.status);
  // The file has uncommitted changes if it appears in the working-tree status.
  const hasLocal = useMemo(() => status.some((s) => s.path === path), [status, path]);
  const [entries, setEntries] = useState<FileHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries(null);
    setSelected(null);
    tauri
      .repoFileHistory(repoPath, path)
      .then((h) => {
        if (cancelled) return;
        setEntries(h);
        // Default to the uncommitted changes when there are any, else the
        // newest commit. Read status off the store (not a dep) so a later
        // status tick doesn't reset the user's selection.
        const localNow = useRepo.getState().status.some((s) => s.path === path);
        setSelected(localNow ? WORKING : h[0]?.hash ?? null);
      })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, path]);

  if (loading) return <FvEmpty>Loading history…</FvEmpty>;
  if (error) return <FvEmpty>{error}</FvEmpty>;
  if (entries && entries.length === 0 && !hasLocal) {
    return <FvEmpty>No history for this file.</FvEmpty>;
  }

  return (
    <div className="fv-tab fv-history">
      <div className="hist-list">
        {hasLocal && (
          <div
            className={'hist-row working' + (selected === WORKING ? ' active' : '')}
            onClick={() => setSelected(WORKING)}
            title="Uncommitted changes in your working tree"
          >
            <div className="gnode"><span className="dot" /></div>
            <div className="body">
              <div className="subj">Uncommitted changes</div>
              <div className="meta">
                <span className="author">Working tree</span>
                <span>not committed</span>
              </div>
            </div>
            <div className="stats" />
          </div>
        )}
        {(entries ?? []).map((e) => (
          <div
            key={e.hash}
            className={'hist-row' + (selected === e.hash ? ' active' : '')}
            onClick={() => setSelected(e.hash)}
            onDoubleClick={() => onJump(e.hash)}
            title="Click to view the change, double-click to open in the graph"
          >
            <div className="gnode"><span className="dot" /></div>
            <div className="body">
              <div className="subj">{e.subject || '(no message)'}</div>
              <div className="meta">
                <span className="author">{e.author_name}</span>
                <span>{relDate(e.time_unix)}</span>
                <span>{e.short_hash}</span>
              </div>
            </div>
            <div className="stats">
              <span className="add">+{e.adds}</span> <span className="del">−{e.dels}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="fv-history-diff">
        {selected ? (
          <HistoryDiff repoPath={repoPath} path={path} oid={selected} onJump={onJump} />
        ) : (
          <FvEmpty>Select a revision to see this file&apos;s change.</FvEmpty>
        )}
      </div>
    </div>
  );
}

function HistoryDiff({
  repoPath,
  path,
  oid,
  onJump,
}: {
  repoPath: string | null;
  path: string;
  oid: string;
  onJump: (hash: string) => void;
}) {
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isWorking = oid === WORKING;
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setDiffs(null);
    setError(null);
    const req = isWorking
      ? tauri.repoDiffWorkdirFile(repoPath, path)
      : tauri.repoDiffCommitFile(repoPath, oid, path);
    req
      .then((d) => { if (!cancelled) setDiffs(d); })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [repoPath, oid, path, isWorking]);

  if (error) return <FvEmpty>{error}</FvEmpty>;
  if (!diffs) return <FvEmpty>Loading…</FvEmpty>;
  const file = diffs[0] ?? null;
  if (!file) {
    return isWorking ? (
      <FvEmpty>No uncommitted changes to this file.</FvEmpty>
    ) : (
      <FvEmpty>
        This commit doesn&apos;t change {basename(path)} (it may predate a rename).{' '}
        <button type="button" className="link-btn" onClick={() => onJump(oid)}>Open commit</button>
      </FvEmpty>
    );
  }
  if (file.binary) {
    // Before = this file at the parent commit (or HEAD for the working-tree
    // entry); After = the version at this commit (or the worktree). An added
    // file has no before, a deleted one no after.
    return isImagePath(path) ? (
      <div className="fv-pierre">
        <ImageDiff
          path={path}
          oldSrc={file.status === 'added' ? null : { rev: isWorking ? 'HEAD' : `${oid}^` }}
          newSrc={
            file.status === 'deleted' ? null : isWorking ? { rev: null } : { rev: oid }
          }
        />
      </div>
    ) : (
      <FvEmpty>Binary file — no textual diff.</FvEmpty>
    );
  }
  if (file.patch.length === 0) {
    return <FvEmpty>No textual diff.</FvEmpty>;
  }
  return (
    <div className="fv-pierre">
      <Diff patch={file.patch} layout={layout} />
    </div>
  );
}

// ─── Compare ──────────────────────────────────────────────────────────────

function CompareTab({ path, repoPath }: { path: string; repoPath: string | null }) {
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';
  const [entries, setEntries] = useState<FileHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined); // undefined = idle/loading
  const [diffError, setDiffError] = useState<string | null>(null);

  // Load the file's revisions to populate the two pickers.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    tauri
      .repoFileHistory(repoPath, path)
      .then((h) => {
        if (cancelled) return;
        setEntries(h);
        // Default: compare the previous revision (base) against the latest.
        setFrom(h[1]?.hash ?? '');
        setTo(h[0]?.hash ?? '');
      })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [repoPath, path]);

  // Fetch the file's diff between the two chosen revisions.
  useEffect(() => {
    if (!repoPath || !from || !to || from === to) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    setDiff(undefined);
    setDiffError(null);
    tauri
      .repoDiffBetween(repoPath, from, to)
      .then((diffs) => {
        if (cancelled) return;
        const f = diffs.find((d) => d.path === path || d.old_path === path) ?? null;
        setDiff(f);
      })
      .catch((e) => { if (!cancelled) setDiffError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [repoPath, from, to, path]);

  if (error) return <FvEmpty>{error}</FvEmpty>;
  if (!entries) return <FvEmpty>Loading revisions…</FvEmpty>;
  if (entries.length < 2) return <FvEmpty>Need at least two revisions of this file to compare.</FvEmpty>;

  const option = (e: FileHistoryEntry) => (
    <option key={e.hash} value={e.hash}>
      {e.short_hash} — {e.subject || '(no message)'}
    </option>
  );

  return (
    <div className="fv-tab">
      <div className="cmp-picker">
        <label className="ref">
          <span className="lbl">Base</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Base revision">
            {entries.map(option)}
          </select>
        </label>
        <span className="arrow"><Icon name="chev-right" size={12} /></span>
        <label className="ref">
          <span className="lbl">Compare</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Compare revision">
            {entries.map(option)}
          </select>
        </label>
      </div>
      <div className="fv-pierre">
        {from === to ? (
          <FvEmpty>Pick two different revisions.</FvEmpty>
        ) : diffError ? (
          <FvEmpty>{diffError}</FvEmpty>
        ) : diff === undefined ? (
          <FvEmpty>Loading diff…</FvEmpty>
        ) : diff === null ? (
          <FvEmpty>No change to this file between the selected revisions.</FvEmpty>
        ) : diff.binary ? (
          isImagePath(path) ? (
            // Before = the file at the base revision, After = at the compare
            // revision; a side is absent when the file didn't exist there.
            <ImageDiff
              path={path}
              oldSrc={diff.status === 'added' ? null : { rev: from }}
              newSrc={diff.status === 'deleted' ? null : { rev: to }}
            />
          ) : (
            <FvEmpty>Binary file — no textual diff.</FvEmpty>
          )
        ) : diff.patch.length === 0 ? (
          <FvEmpty>No textual diff.</FvEmpty>
        ) : (
          <Diff patch={diff.patch} layout={layout} />
        )}
      </div>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic light-ish avatar background hue from a seed (email/name). */
function avatarBg(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `oklch(0.78 0.11 ${h})`;
}

function relDate(unix: number): string {
  const delta = Date.now() / 1000 - unix;
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.round(delta / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
