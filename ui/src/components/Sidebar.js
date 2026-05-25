import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Icon } from './Icon';
import { useRepo } from '../stores/repo';
function SideRow({ icon, label, badge, active, onClick }) {
    return (_jsxs("div", { className: 'side-row' + (active ? ' active' : ''), onClick: onClick, children: [icon && _jsx("span", { className: "ico", children: _jsx(Icon, { name: icon, size: 14 }) }), _jsx("span", { className: "label", children: label }), badge != null && badge !== 0 && _jsx("span", { className: "badge", children: badge })] }));
}
function SideSection({ label, collapsed, onToggle, count }) {
    return (_jsxs("div", { className: 'side-section' + (collapsed ? ' collapsed' : ''), onClick: onToggle, children: [_jsx(Icon, { name: "chev-down", size: 8, stroke: 2, className: "chev" }), _jsx("span", { children: label }), count != null && _jsx("span", { className: "count", children: count })] }));
}
export function Sidebar({ onOpenRepo, onOpenRecent }) {
    const view = useRepo((s) => s.view);
    const setView = useRepo((s) => s.setView);
    const selectFile = useRepo((s) => s.selectFile);
    const status = useRepo((s) => s.status);
    const meta = useRepo((s) => s.meta);
    const recents = useRepo((s) => s.recents);
    const forgetRecent = useRepo((s) => s.forgetRecent);
    const [tab, setTab] = useState('git');
    const [filter, setFilter] = useState('');
    const [sections, setSections] = useState({
        branches: true, remotes: true, tags: false, stashes: true, submods: false,
    });
    const unstaged = status.filter((s) => !s.staged).length;
    const toggle = (k) => setSections((s) => ({ ...s, [k]: !s[k] }));
    return (_jsxs("div", { className: "sidebar", children: [_jsxs("div", { className: "side-primary", children: [_jsx(SideRow, { icon: "changes", label: "Local Changes", badge: unstaged || undefined, active: view === 'local', onClick: () => { setView('local'); selectFile(null); } }), _jsx(SideRow, { icon: "graph", label: "All Commits", active: view === 'commits', onClick: () => { setView('commits'); selectFile(null); } })] }), _jsxs("div", { className: "side-tabs", children: [_jsxs("button", { className: 'side-tab' + (tab === 'git' ? ' on' : ''), onClick: () => setTab('git'), children: [_jsx(Icon, { name: "branch", size: 12 }), _jsx("span", { children: "Git" })] }), _jsxs("button", { className: 'side-tab' + (tab === 'files' ? ' on' : ''), onClick: () => setTab('files'), children: [_jsx(Icon, { name: "folder", size: 12 }), _jsx("span", { children: "Files" })] })] }), _jsxs("div", { className: "side-filter", children: [_jsx(Icon, { name: "search", size: 11 }), _jsx("input", { value: filter, onChange: (e) => setFilter(e.target.value), placeholder: tab === 'git' ? 'Filter branches, tags…' : 'Filter files' })] }), _jsx("div", { className: "side-scroll", children: !meta ? (_jsx(EmptyRepoState, { recents: recents, onOpenRepo: onOpenRepo, onOpenRecent: onOpenRecent, onForget: forgetRecent })) : tab === 'git' ? (_jsxs(_Fragment, { children: [_jsx(SideSection, { label: "Branches", collapsed: !sections.branches, onToggle: () => toggle('branches'), count: 0 }), _jsx(SideSection, { label: "Remotes", collapsed: !sections.remotes, onToggle: () => toggle('remotes'), count: 0 }), _jsx(SideSection, { label: "Tags", collapsed: !sections.tags, onToggle: () => toggle('tags'), count: 0 }), _jsx(SideSection, { label: "Stashes", collapsed: !sections.stashes, onToggle: () => toggle('stashes'), count: 0 }), _jsx(SideSection, { label: "Submodules", collapsed: !sections.submods, onToggle: () => toggle('submods'), count: 0 })] })) : (_jsx("div", { className: "lc-empty", style: { padding: '16px 12px', fontSize: 11 }, children: "File tree \u2014 coming soon." })) })] }));
}
function EmptyRepoState({ recents, onOpenRepo, onOpenRecent, onForget }) {
    return (_jsxs("div", { className: "lc-empty", style: { padding: '16px 12px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 12 }, children: [_jsxs("div", { children: ["No repository open. Use ", _jsx("kbd", { children: "\u2318O" }), ", drop a folder onto the window, or:"] }), _jsx("button", { onClick: onOpenRepo, style: {
                    padding: '6px 10px', borderRadius: 6,
                    background: 'var(--bg-elev)', color: 'var(--text-1)',
                    border: '1px solid var(--border)', fontSize: 11, cursor: 'pointer',
                    textAlign: 'left',
                }, children: "Open repository\u2026" }), recents.length > 0 && (_jsxs("div", { children: [_jsx("div", { style: { color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10, margin: '4px 0 6px' }, children: "Recent" }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 2 }, children: recents.map((r) => (_jsxs("div", { onClick: () => onOpenRecent(r.path), title: r.path, style: {
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                                color: 'var(--text-1)',
                            }, onMouseEnter: (e) => (e.currentTarget.style.background = 'var(--bg-elev)'), onMouseLeave: (e) => (e.currentTarget.style.background = 'transparent'), children: [_jsx("span", { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: r.name }), _jsx("span", { onClick: (e) => { e.stopPropagation(); void onForget(r.path); }, title: "Remove from recents", style: { color: 'var(--text-dim)', padding: 2 }, children: _jsx(Icon, { name: "x", size: 9, stroke: 2 }) })] }, r.path))) })] }))] }));
}
