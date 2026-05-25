import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useSettings } from '../stores/settings';
export function CommandPalette({ actions, onClose }) {
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);
    const platform = useSettings((s) => s.platform);
    const cmdKey = platform === 'mac' ? '⌘' : 'Ctrl ';
    const listRef = useRef(null);
    const filtered = q
        ? actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()))
        : actions;
    // Reset selection whenever the visible list changes so we never point at
    // a stale index.
    useEffect(() => { setSel(0); }, [q, filtered.length]);
    // Keep the selected row in view as the user navigates with the keyboard.
    useEffect(() => {
        const list = listRef.current;
        if (!list)
            return;
        const node = list.children.item(sel);
        node?.scrollIntoView({ block: 'nearest' });
    }, [sel]);
    return (_jsx("div", { className: "palette-backdrop", onClick: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { className: "palette", children: [_jsxs("div", { className: "palette-input", children: [_jsx(Icon, { name: "search", size: 16 }), _jsx("input", { autoFocus: true, value: q, onChange: (e) => setQ(e.target.value), placeholder: "Type a command, branch, or file\u2026", onKeyDown: (e) => {
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSel((s) => Math.min(Math.max(filtered.length - 1, 0), s + 1));
                                }
                                else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSel((s) => Math.max(0, s - 1));
                                }
                                else if (e.key === 'Enter') {
                                    const item = filtered[sel];
                                    if (item) {
                                        item.run();
                                        onClose();
                                    }
                                }
                            } })] }), _jsxs("div", { className: "palette-list", ref: listRef, children: [filtered.length === 0 && (_jsx("div", { className: "palette-sect", children: "No matches" })), filtered.map((a, i) => (_jsxs("div", { className: 'palette-item' + (i === sel ? ' active' : ''), onMouseMove: () => { if (i !== sel)
                                setSel(i); }, onClick: () => { a.run(); onClose(); }, children: [_jsx("span", { className: "ico", children: _jsx(Icon, { name: "command", size: 14 }) }), _jsx("span", { className: "label", children: a.label }), a.shortcut && _jsx("span", { className: "kbd", children: a.shortcut })] }, a.id)))] }), _jsxs("div", { className: "palette-foot", children: [_jsxs("div", { className: "grp", children: [_jsx("span", { className: "kbd", children: "\u2191\u2193" }), " navigate"] }), _jsxs("div", { className: "grp", children: [_jsx("span", { className: "kbd", children: "\u21B5" }), " run"] }), _jsxs("div", { className: "grp", children: [_jsxs("span", { className: "kbd", children: [cmdKey, "K"] }), " toggle"] }), _jsxs("div", { className: "grp right", children: [_jsx("span", { className: "kbd", children: "esc" }), " close"] })] })] }) }));
}
