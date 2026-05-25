import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRepo } from '../stores/repo';
/** Placeholder commit graph — table only, no SVG lanes yet. PRD §6.2. */
export function Commits() {
    const commits = useRepo((s) => s.commits);
    return (_jsxs("div", { className: "graph-wrap", children: [_jsx("div", { className: "graph-toolbar", children: _jsx("div", { className: "graph-search", children: _jsx("input", { placeholder: "Search commits\u2026" }) }) }), _jsx("div", { className: "graph-split", children: _jsx("div", { className: "graph-main", children: _jsxs("table", { className: "graph-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { width: 40 } }), _jsx("th", { children: "Message" }), _jsx("th", { style: { width: 160 }, children: "Author" }), _jsx("th", { style: { width: 100 }, children: "Date" }), _jsx("th", { style: { width: 80 }, children: "Hash" })] }) }), _jsx("tbody", { children: commits.map((c) => (_jsxs("tr", { children: [_jsx("td", { className: "graph-col" }), _jsx("td", { className: "msg", children: _jsx("span", { className: "msg-text", children: c.subject }) }), _jsx("td", { className: "author", children: c.author_name }), _jsx("td", { className: "date", children: relativeDate(c.time_unix) }), _jsx("td", { className: "hash", children: c.short_hash })] }, c.hash))) })] }) }) })] }));
}
function relativeDate(unix) {
    const delta = Date.now() / 1000 - unix;
    if (delta < 60)
        return `${Math.round(delta)}s`;
    if (delta < 3600)
        return `${Math.round(delta / 60)}m`;
    if (delta < 86400)
        return `${Math.round(delta / 3600)}h`;
    return `${Math.round(delta / 86400)}d`;
}
