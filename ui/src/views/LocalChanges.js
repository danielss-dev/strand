import { createElement as _createElement } from "react";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
/**
 * The staging workspace described in PRD §5: a left column with two file
 * trees (unstaged on top, staged on the bottom), a diff pane on the right,
 * and the commit form pinned to the bottom.
 *
 * Per-row Stage / Unstage shows on hover. Discard lives in the right-click
 * menu (to be wired) so it can't be hit by accident. Clicking a file
 * selects it; ⌘↵ in the subject field commits.
 */
export function LocalChanges() {
    const unstaged = useRepo((s) => s.unstagedDiffs);
    const staged = useRepo((s) => s.stagedDiffs);
    const selection = useRepo((s) => s.localSelection);
    const stage = useRepo((s) => s.stage);
    const unstage = useRepo((s) => s.unstage);
    const stageAll = useRepo((s) => s.stageAll);
    const unstageAll = useRepo((s) => s.unstageAll);
    const selectLocalFile = useRepo((s) => s.selectLocalFile);
    // Auto-select first file when the previous selection disappears so the
    // diff pane stays populated between operations.
    useEffect(() => {
        if (selection)
            return;
        const first = unstaged[0] != null
            ? { file: unstaged[0].path, staged: false }
            : staged[0] != null
                ? { file: staged[0].path, staged: true }
                : null;
        if (first)
            selectLocalFile(first);
    }, [selection, unstaged, staged, selectLocalFile]);
    const selectedDiff = useMemo(() => {
        if (!selection)
            return null;
        const pool = selection.staged ? staged : unstaged;
        return pool.find((d) => d.path === selection.file) ?? null;
    }, [selection, unstaged, staged]);
    return (_jsxs("div", { className: "lc-stack", children: [_jsx("div", { className: "lc-main", children: _jsxs(PanelGroup, { direction: "horizontal", autoSaveId: "strand:lc-main", children: [_jsx(Panel, { defaultSize: 28, minSize: 15, maxSize: 60, children: _jsx("div", { className: "lc-files", children: _jsxs(PanelGroup, { direction: "vertical", autoSaveId: "strand:lc-files", children: [_jsx(Panel, { defaultSize: 50, minSize: 10, children: _jsx(FileSection, { title: "Unstaged", files: unstaged, staged: false, selection: selection, onSelect: selectLocalFile, onAction: (f) => void stage(f), actionLabel: "Stage", onBulk: () => void stageAll(), bulkLabel: "Stage all" }) }), _jsx(PanelResizeHandle, { className: "rs-handle horiz" }), _jsx(Panel, { defaultSize: 50, minSize: 10, children: _jsx(FileSection, { title: "Staged", files: staged, staged: true, selection: selection, onSelect: selectLocalFile, onAction: (f) => void unstage(f), actionLabel: "Unstage", onBulk: () => void unstageAll(), bulkLabel: "Unstage all" }) })] }) }) }), _jsx(PanelResizeHandle, { className: "rs-handle vert" }), _jsx(Panel, { minSize: 30, children: _jsx(DiffPane, { diff: selectedDiff }) })] }) }), _jsx(CommitBar, { canCommit: staged.length > 0 })] }));
}
function FileSection({ title, files, staged, selection, onSelect, onAction, actionLabel, onBulk, bulkLabel, }) {
    return (_jsxs("div", { className: "lc-files-section", children: [_jsxs("div", { className: "lc-col-head", children: [title, _jsx("span", { className: "count", children: files.length }), _jsx("div", { className: "h-actions", children: files.length > 0 && (_jsx("span", { className: "h-link", onClick: onBulk, role: "button", children: bulkLabel })) })] }), files.length > 0 && (_jsx(FileTree, { files: files, staged: staged, selection: selection, onSelect: onSelect, onAction: onAction, actionLabel: actionLabel }))] }));
}
/**
 * Group a flat list of `FileDiff`s into a folder tree. Single-child folders
 * collapse into their parent (`crates/strand-core/src` → one row) so we
 * don't waste rows on long unique prefixes.
 */
function buildTree(files) {
    const root = { name: '', path: '', children: new Map() };
    for (const diff of files) {
        const parts = diff.path.split('/');
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            let next = cur.children.get(part);
            if (!next) {
                next = {
                    name: part,
                    path: parts.slice(0, i + 1).join('/'),
                    children: new Map(),
                };
                cur.children.set(part, next);
            }
            cur = next;
        }
        const fname = parts[parts.length - 1];
        cur.children.set(fname, { name: fname, path: diff.path, children: new Map(), file: diff });
    }
    function build(node) {
        if (node.file && node.children.size === 0) {
            return { kind: 'file', name: node.name, path: node.path, diff: node.file };
        }
        let children = Array.from(node.children.values()).map(build);
        // Sort: folders first, then files; alphabetical within each.
        children.sort((a, b) => {
            if (a.kind !== b.kind)
                return a.kind === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return {
            kind: 'folder',
            name: node.name,
            path: node.path,
            children,
            count: countLeaves(children),
        };
    }
    function countLeaves(nodes) {
        let n = 0;
        for (const c of nodes)
            n += c.kind === 'file' ? 1 : c.count;
        return n;
    }
    const top = Array.from(root.children.values()).map(build);
    top.sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return top;
}
function FileTree({ files, staged, selection, onSelect, onAction, actionLabel }) {
    const tree = useMemo(() => buildTree(files), [files]);
    // Default: all folders expanded. Collapsed-state is per-section, lives in
    // memory only for now (per-repo persistence comes with A7).
    const [collapsed, setCollapsed] = useState(() => new Set());
    function toggle(path) {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(path))
                next.delete(path);
            else
                next.add(path);
            return next;
        });
    }
    return (_jsx("div", { className: "lc-tree", children: tree.map((node) => (_jsx(TreeRow, { node: node, depth: 0, staged: staged, collapsed: collapsed, onToggle: toggle, selection: selection, onSelect: onSelect, onAction: onAction, actionLabel: actionLabel }, node.path))) }));
}
function TreeRow(props) {
    const { node, depth, staged, collapsed, onToggle } = props;
    const indent = { '--depth': depth };
    if (node.kind === 'folder') {
        const open = !collapsed.has(node.path);
        return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "lc-tree-row folder", style: indent, onClick: () => onToggle(node.path), role: "button", children: [_jsx("span", { className: "chev", children: _jsx(Icon, { name: open ? 'chev-down' : 'chev-right', size: 11 }) }), _jsx("span", { className: "ftype", children: _jsx(Icon, { name: open ? 'folder-open' : 'folder', size: 13 }) }), _jsx("span", {}), _jsx("span", { className: "fname", children: node.name }), _jsx("span", { className: "folder-count", children: node.count })] }), open &&
                    node.children.map((child) => (_createElement(TreeRow, { ...props, key: child.path, node: child, depth: depth + 1 })))] }));
    }
    const selected = props.selection?.file === node.path && props.selection.staged === staged;
    const code = statusCode(node.diff.status);
    return (_jsxs("div", { className: `lc-tree-row${selected ? ' active' : ''}`, style: indent, onClick: () => props.onSelect({ file: node.path, staged }), role: "button", tabIndex: 0, children: [_jsx("span", {}), _jsx("span", { className: `badge ${code}`, children: code }), _jsx("span", { className: "ftype", children: _jsx(Icon, { name: "file", size: 13 }) }), _jsx("span", { className: "fname", children: node.name }), _jsx("span", { className: "lc-action", onClick: (e) => {
                    e.stopPropagation();
                    props.onAction(node.path);
                }, role: "button", children: props.actionLabel })] }));
}
function statusCode(status) {
    switch (status) {
        case 'added':
            return 'A';
        case 'modified':
            return 'M';
        case 'deleted':
            return 'D';
        case 'renamed':
            return 'R';
        case 'copied':
            return 'C';
        case 'typechange':
            return 'T';
    }
}
// ─── Diff pane ──────────────────────────────────────────────────────────────
function DiffPane({ diff }) {
    // The unified/split toggle lives in the main header (App.tsx → MainHeader)
    // and writes to `useSettings.diffMode`. Pierre talks 'unified' | 'split',
    // our setting is 'stacked' | 'split' — map at the boundary.
    const diffMode = useSettings((s) => s.diffMode);
    const layout = diffMode === 'split' ? 'split' : 'unified';
    return (_jsx("div", { className: "lc-diff", children: _jsx("div", { className: "lc-diff-scroll", children: _jsx(DiffBody, { diff: diff, layout: layout }) }) }));
}
function DiffBody({ diff, layout }) {
    if (!diff) {
        return (_jsxs("div", { className: "lc-empty", children: [_jsx("strong", { children: "Select a file" }), "Pick something on the left to see its diff."] }));
    }
    if (diff.binary || diff.patch.length === 0) {
        return (_jsxs("div", { className: "lc-empty", children: [_jsx("strong", { children: diff.binary ? 'Binary file' : 'No textual diff' }), diff.binary
                    ? 'Strand does not render binary file diffs yet.'
                    : 'Nothing to show — the file may have been moved or its content is identical.'] }));
    }
    return _jsx(Diff, { patch: diff.patch, layout: layout });
}
// ─── Commit bar ─────────────────────────────────────────────────────────────
function CommitBar({ canCommit }) {
    const commit = useRepo((s) => s.commit);
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [amend, setAmend] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    async function submit() {
        const trimmed = subject.trim();
        if (!trimmed || submitting)
            return;
        if (!canCommit && !amend)
            return;
        setSubmitting(true);
        try {
            await commit(trimmed, body.trim() || null, amend);
            setSubject('');
            setBody('');
            setAmend(false);
        }
        catch (e) {
            console.error('commit failed', e);
        }
        finally {
            setSubmitting(false);
        }
    }
    const disabled = submitting || !subject.trim() || (!canCommit && !amend);
    return (_jsxs("div", { className: "lc-commit-bar", children: [_jsxs("div", { className: "cb-top", children: [_jsx("div", { className: "subject-row", children: _jsx("input", { className: "subject", placeholder: "Commit subject", value: subject, onChange: (e) => setSubject(e.target.value), onKeyDown: (e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    e.preventDefault();
                                    void submit();
                                }
                            } }) }), _jsxs("label", { className: "amend", children: [_jsx("input", { type: "checkbox", checked: amend, onChange: (e) => setAmend(e.target.checked) }), ' ', _jsx("span", { children: "Amend" })] }), _jsxs("button", { className: "btn primary cb-commit", disabled: disabled, onClick: () => void submit(), children: [amend ? 'Amend' : 'Commit', _jsx("span", { className: "kbd-inline", children: "\u2318\u21B5" })] })] }), _jsx("textarea", { className: "cb-body", placeholder: "Description (optional)", value: body, onChange: (e) => setBody(e.target.value) })] }));
}
