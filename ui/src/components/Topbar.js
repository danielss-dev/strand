import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { isTauri } from '../lib/tauri';
import { useSettings } from '../stores/settings';
import { useRepo } from '../stores/repo';
export function Topbar({ onOpenPalette, onOpenRepo, onOpenRecent, onSync, onPull, onPush, syncing, pulling, pushing, onToast, }) {
    const platform = useSettings((s) => s.platform);
    const tabs = useRepo((s) => s.tabs);
    const activeTabPath = useRepo((s) => s.activeTabPath);
    const setActiveTab = useRepo((s) => s.setActiveTab);
    const closeTab = useRepo((s) => s.closeTab);
    const meta = useRepo((s) => s.meta);
    const recents = useRepo((s) => s.recents);
    const forgetRecent = useRepo((s) => s.forgetRecent);
    const branch = meta?.branch ?? 'no repo';
    const ahead = meta?.ahead ?? 0;
    const behind = meta?.behind ?? 0;
    // In Tauri the host window draws real macOS traffic lights / Win11 controls.
    // The HTML fakes are only for browser-only preview (`pnpm dev`).
    const showFakeChrome = !isTauri();
    return (_jsxs("div", { className: "topbar", "data-native-chrome": !showFakeChrome ? platform : undefined, children: [showFakeChrome && platform === 'mac' && (_jsxs("div", { className: "traffic", children: [_jsx("div", { className: "dot close" }), _jsx("div", { className: "dot min" }), _jsx("div", { className: "dot max" })] })), _jsxs("div", { className: "repo-tabs", children: [tabs.map((t) => (_jsxs("div", { className: 'repo-tab' + (t.path === activeTabPath ? ' active' : ''), title: t.path, onClick: () => { void setActiveTab(t.path); }, children: [_jsx("div", { className: "repo-dot", style: { background: 'var(--b-1)' } }), _jsx("div", { className: "repo-name", children: t.meta.name }), _jsx("div", { className: "repo-x", title: "Close repository", onClick: (e) => { e.stopPropagation(); closeTab(t.path); }, children: _jsx(Icon, { name: "x", size: 9, stroke: 2 }) })] }, t.path))), _jsx(RepoSwitcherButton, { onOpenRepo: onOpenRepo, onOpenRecent: onOpenRecent, recents: recents, onForget: forgetRecent })] }), _jsx("div", { className: "topbar-spacer" }), _jsxs("div", { className: "sync-group", children: [_jsx("button", { className: "sync-btn", onClick: onSync, title: "Fetch", disabled: !meta || syncing, children: _jsx(Icon, { name: "refresh", size: 13, className: syncing ? 'spin' : '' }) }), _jsxs("button", { className: "sync-btn", onClick: onPull, title: behind > 0 ? `Pull (${behind} behind)` : 'Pull', disabled: !meta || pulling, children: [_jsx(Icon, { name: "arrow-down", size: 13, className: pulling ? 'spin' : '' }), _jsx("span", { className: "count", children: behind })] }), _jsxs("button", { className: "sync-btn", onClick: onPush, title: ahead > 0 ? `Push (${ahead} ahead)` : 'Push', disabled: !meta || pushing, children: [_jsx(Icon, { name: "arrow-up", size: 13, className: pushing ? 'spin' : '' }), _jsx("span", { className: "count", children: ahead })] })] }), _jsx(BranchSwitcherButton, { branch: branch, hasRepo: !!meta, onToast: onToast }), _jsxs("div", { className: "cmd-pill", onClick: onOpenPalette, children: [_jsx(Icon, { name: "search", size: 13 }), _jsx("span", { children: "Quick Launch" }), _jsx("kbd", { children: platform === 'mac' ? '⌘K' : 'Ctrl K' })] }), showFakeChrome && platform === 'win11' && (_jsxs("div", { className: "win-controls", children: [_jsx("div", { className: "wc", children: _jsx(Icon, { name: "win-min", size: 10, stroke: 1 }) }), _jsx("div", { className: "wc", children: _jsx(Icon, { name: "win-max", size: 10, stroke: 1 }) }), _jsx("div", { className: "wc close", children: _jsx(Icon, { name: "win-close", size: 10, stroke: 1.2 }) })] }))] }));
}
/**
 * `+` button in the tab strip — opens a dropdown with "Open…" + recents.
 *
 * The menu is rendered via a portal because the tab strip uses
 * `overflow: hidden` to clip long lists of tabs; an in-tree absolute
 * positioned menu would be invisible.
 */
function RepoSwitcherButton({ onOpenRepo, onOpenRecent, recents, onForget, }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);
    const menuRef = useRef(null);
    const [pos, setPos] = useState(null);
    useLayoutEffect(() => {
        if (!open || !wrapRef.current)
            return;
        const r = wrapRef.current.getBoundingClientRect();
        setPos({ top: r.bottom + 6, left: r.left });
    }, [open]);
    useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));
    return (_jsxs("div", { ref: wrapRef, className: "tab-add-wrap", children: [_jsx("div", { className: "tab-add", title: "Open repository", onClick: () => setOpen((o) => !o), children: _jsx(Icon, { name: "plus", size: 12 }) }), open && pos && createPortal(_jsxs("div", { ref: menuRef, className: "repo-menu", role: "menu", style: { position: 'fixed', top: pos.top, left: pos.left }, children: [_jsxs("div", { className: "repo-menu-item", role: "menuitem", onClick: () => { setOpen(false); onOpenRepo(); }, children: [_jsx("span", { className: "ico", children: _jsx(Icon, { name: "folder-open", size: 13 }) }), _jsx("span", { className: "label", children: "Open repository\u2026" }), _jsx("span", { className: "meta", children: "\u2318O" })] }), _jsx("div", { className: "repo-menu-divider" }), recents.length === 0 ? (_jsx("div", { className: "repo-menu-empty", children: "No recent repositories yet." })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "repo-menu-sect", children: "Recent" }), recents.map((r) => (_jsxs("div", { className: "repo-menu-item", role: "menuitem", title: r.path, onClick: () => { setOpen(false); onOpenRecent(r.path); }, children: [_jsx("span", { className: "ico", children: _jsx(Icon, { name: "folder", size: 13 }) }), _jsx("span", { className: "label", children: r.name }), _jsx("span", { className: "meta", children: r.path }), _jsx("span", { className: "x", title: "Remove from recents", onClick: (e) => { e.stopPropagation(); void onForget(r.path); }, children: _jsx(Icon, { name: "x", size: 9, stroke: 2 }) })] }, r.path)))] }))] }), document.body)] }));
}
/** Topbar branch button — opens a dropdown with branches + create. */
function BranchSwitcherButton({ branch, hasRepo, onToast, }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);
    const menuRef = useRef(null);
    const [pos, setPos] = useState(null);
    useLayoutEffect(() => {
        if (!open || !wrapRef.current)
            return;
        const r = wrapRef.current.getBoundingClientRect();
        setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }, [open]);
    useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));
    return (_jsxs("div", { ref: wrapRef, style: { position: 'relative' }, children: [_jsxs("div", { className: "branch-btn", title: hasRepo ? 'Switch branch' : 'No repository open', onClick: () => { if (hasRepo)
                    setOpen((o) => !o); }, style: hasRepo ? undefined : { opacity: 0.5, cursor: 'default' }, children: [_jsx(Icon, { name: "branch", size: 13 }), _jsx("span", { className: "branch-name", children: branch }), _jsx(Icon, { name: "chev-down", size: 11, className: "chev" })] }), open && hasRepo && pos && createPortal(_jsxs("div", { ref: menuRef, className: "repo-menu", role: "menu", style: { position: 'fixed', top: pos.top, right: pos.right, minWidth: 240 }, children: [_jsx("div", { className: "repo-menu-sect", children: "On this repo" }), _jsxs("div", { className: "repo-menu-item", role: "menuitem", "aria-disabled": true, children: [_jsx("span", { className: "ico", children: _jsx(Icon, { name: "branch", size: 13 }) }), _jsx("span", { className: "label", children: branch }), _jsx("span", { className: "meta", children: "current" })] }), _jsx("div", { className: "repo-menu-empty", children: "Other branches will list here once branch reads land (task #3)." }), _jsx("div", { className: "repo-menu-divider" }), _jsxs("div", { className: "repo-menu-item", role: "menuitem", onClick: () => { setOpen(false); onToast('Create branch — wired in task #4'); }, children: [_jsx("span", { className: "ico", children: _jsx(Icon, { name: "plus", size: 13 }) }), _jsx("span", { className: "label", children: "Create branch\u2026" })] })] }), document.body)] }));
}
/**
 * Close a popover on outside mousedown or Escape, while `active` is true.
 * Accepts multiple refs because portal-rendered menus live outside their
 * trigger's DOM subtree.
 */
function useOutsideClose(refs, active, close) {
    useEffect(() => {
        if (!active)
            return;
        const onDown = (e) => {
            const target = e.target;
            if (refs.some((r) => r.current?.contains(target)))
                return;
            close();
        };
        const onKey = (e) => {
            if (e.key === 'Escape')
                close();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [refs, active, close]);
}
