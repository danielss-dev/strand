/**
 * VS Code `.code-workspace` parsing for the workspace importer.
 *
 * The format is JSONC — JSON that tolerates `//` and `/* *\/` comments and
 * trailing commas — with a `folders` array of `{ path }` (local) or `{ uri }`
 * (remote) entries; relative paths resolve against the file's directory.
 * Parsing is pure string work here (unit-tested); file reading and repo
 * validation happen elsewhere.
 */

/** Strip `//` and `/* *\/` comments, string-aware (a `//` inside a quoted
 *  value — `"http://x"` — survives). */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop commas whose next non-whitespace char closes the container — the
 *  trailing commas JSONC allows and `JSON.parse` doesn't. String-aware. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export interface CodeWorkspaceFolders {
  /** The local folder paths (`path` entries), still unresolved. */
  folders: string[];
  /** Entries with no usable local path (remote `uri` folders, malformed). */
  ignored: number;
}

/** Parse a `.code-workspace` document into its local folder paths. Throws on
 *  unparseable JSON; a missing/empty `folders` array is just zero folders. */
export function parseCodeWorkspace(text: string): CodeWorkspaceFolders {
  let doc: unknown;
  try {
    doc = JSON.parse(stripTrailingCommas(stripComments(text)));
  } catch {
    throw new Error('not a valid .code-workspace file (unparseable JSON)');
  }
  const folders = (doc as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(folders)) return { folders: [], ignored: 0 };
  const out: string[] = [];
  let ignored = 0;
  for (const f of folders) {
    const path = typeof f === 'object' && f !== null ? (f as { path?: unknown }).path : undefined;
    if (typeof path === 'string' && path.trim()) out.push(path.trim());
    else ignored++;
  }
  return { folders: out, ignored };
}

const isAbsolute = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');

/**
 * Resolve a folder entry against the workspace file's directory. Only a
 * join — no canonicalization (`repoOpen` canonicalizes on the Rust side,
 * and its `meta.path` is what gets stored; fabricating a re-spelled path
 * here is the Windows duplicate-tab trap).
 */
export function resolveWorkspaceFolder(fileDir: string, folder: string): string {
  if (isAbsolute(folder)) return folder;
  const base = fileDir.replace(/[\\/]+$/, '');
  if (folder === '.') return base;
  const sep = base.includes('\\') ? '\\' : '/';
  let rel = folder.replace(/^\.\//, '');
  if (sep === '\\') rel = rel.replace(/\//g, '\\');
  return `${base}${sep}${rel}`;
}

/** The directory holding `filePath` (both separators; no trailing slash). */
export function dirnameOf(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return i > 0 ? filePath.slice(0, i) : filePath;
}

/** Workspace display name: the file's basename minus the extension. */
export function workspaceNameFromFile(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const base = filePath.slice(i + 1);
  return base.replace(/\.code-workspace$/i, '').trim() || 'Workspace';
}
