import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Icon } from './Icon';
import { useRepo } from '../stores/repo';
export function StatusBar() {
    const meta = useRepo((s) => s.meta);
    const status = useRepo((s) => s.status);
    const modified = status.filter((s) => !s.staged).length;
    const staged = status.filter((s) => s.staged).length;
    return (_jsxs("div", { className: "statusbar", children: [_jsxs("div", { className: "sb-item", children: [_jsx(Icon, { name: "branch", size: 11 }), _jsx("span", { className: "branch", children: meta?.branch ?? '—' })] }), meta && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "sb-item", children: [_jsxs("span", { style: { color: 'var(--add)' }, children: [meta.ahead, "\u2191"] }), _jsxs("span", { style: { color: 'var(--del)' }, children: [meta.behind, "\u2193"] })] }), _jsx("span", { className: "sep", children: "\u00B7" })] })), _jsxs("div", { className: "sb-item", children: [_jsx(Icon, { name: "sync", size: 11 }), _jsx("span", { children: meta ? 'Up to date' : 'No repo' })] }), _jsxs("div", { className: "right", children: [_jsxs("div", { className: "sb-item", children: [modified, " modified \u00B7 ", staged, " staged"] }), _jsx("span", { className: "sep", children: "\u00B7" }), _jsx("div", { className: "sb-item", children: "UTF-8 \u00B7 LF" })] })] }));
}
