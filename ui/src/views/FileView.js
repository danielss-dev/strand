import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Icon } from '../components/Icon';
const TABS = [
    { id: 'content', label: 'Content', icon: 'content' },
    { id: 'history', label: 'History', icon: 'history' },
    { id: 'compare', label: 'Compare', icon: 'compare' },
    { id: 'blame', label: 'Blame', icon: 'blame' },
];
/** Placeholder four-tab file view. PRD §6.5. */
export function FileView({ path }) {
    const [tab, setTab] = useState('content');
    return (_jsxs("div", { className: "main", children: [_jsx("div", { className: "main-header", children: _jsx("div", { className: "crumb", children: _jsx("span", { className: "leaf", style: { fontFamily: 'var(--font-mono)', fontSize: 11.5 }, children: path }) }) }), _jsx("div", { className: "tab-strip", children: TABS.map((t) => (_jsxs("div", { className: 'tab' + (tab === t.id ? ' active' : ''), onClick: () => setTab(t.id), children: [_jsx(Icon, { name: t.icon, size: 13, className: "tab-ico" }), _jsx("span", { children: t.label })] }, t.id))) }), _jsx("div", { className: "fv-body", children: _jsxs("div", { className: "lc-empty", style: { margin: 'auto' }, children: [_jsxs("strong", { children: [tab[0].toUpperCase() + tab.slice(1), " view"] }), "Wire up to ", _jsx("code", { children: "strand-core" }), "."] }) })] }));
}
