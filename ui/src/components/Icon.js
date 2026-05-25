import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Strand icon set — single-stroke 16×16 line icons, ported from the
 * Claude Design prototype. Color comes from `currentColor`, weight from
 * `stroke`. Add new glyphs here, not as one-off SVGs in components.
 */
export function Icon({ name, size = 14, stroke = 1.5, ...rest }) {
    const p = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...rest,
    };
    switch (name) {
        case 'edit': return _jsx("svg", { ...p, children: _jsx("path", { d: "M2.5 11.5v2h2L13 5l-2-2L2.5 11.5Z" }) });
        case 'graph': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "4", cy: "3.5", r: "1.6" }), _jsx("circle", { cx: "4", cy: "12.5", r: "1.6" }), _jsx("circle", { cx: "12", cy: "8", r: "1.6" }), _jsx("path", { d: "M4 5.1V11M5.4 12L10.6 8.7M5.6 4.3l5 2.9" })] });
        case 'branch': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "4", cy: "3.5", r: "1.6" }), _jsx("circle", { cx: "4", cy: "12.5", r: "1.6" }), _jsx("circle", { cx: "12", cy: "6", r: "1.6" }), _jsx("path", { d: "M4 5.1v6M4.4 11.6c0-3 7.6-2 7.6-4" })] });
        case 'tag': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M8 1.5H2v6l6.5 6.5a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4L8 1.5Z" }), _jsx("circle", { cx: "5", cy: "5", r: "0.6", fill: "currentColor" })] });
        case 'stash': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "1.5", y: "6", width: "13", height: "8", rx: "1.5" }), _jsx("path", { d: "M3 4h10M4.5 2h7" })] });
        case 'remote': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "8", cy: "8", r: "6" }), _jsx("path", { d: "M2 8h12M8 2c2 1.7 3 4 3 6s-1 4.3-3 6c-2-1.7-3-4-3-6s1-4.3 3-6Z" })] });
        case 'submodule': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "2", y: "2", width: "12", height: "12", rx: "1.5" }), _jsx("rect", { x: "5", y: "5", width: "6", height: "6", rx: "0.5" })] });
        case 'file': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M3 1.5h7l3 3v10H3v-13Z" }), _jsx("path", { d: "M10 1.5v3h3" })] });
        case 'folder': return _jsx("svg", { ...p, children: _jsx("path", { d: "M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" }) });
        case 'folder-open': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v1.5H1.5V4Z" }), _jsx("path", { d: "M1.5 6h13l-1.2 6.6a1 1 0 0 1-1 .9H3.7a1 1 0 0 1-1-.9L1.5 6Z" })] });
        case 'changes': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "8", cy: "8", r: "6.2" }), _jsx("path", { d: "M5 8h6M8 5v6" })] });
        case 'search': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "7", cy: "7", r: "4.5" }), _jsx("path", { d: "M10.4 10.4l3.1 3.1" })] });
        case 'command': return _jsx("svg", { ...p, children: _jsx("path", { d: "M4.5 2A2 2 0 1 0 4.5 6h2v4h-2A2 2 0 1 0 4.5 14V12M6.5 6h3v4M11.5 6A2 2 0 1 0 11.5 2v4M11.5 10A2 2 0 1 1 11.5 14v-4" }) });
        case 'arrow-down': return _jsx("svg", { ...p, children: _jsx("path", { d: "M8 2v12M3.5 9.5L8 14l4.5-4.5" }) });
        case 'arrow-up': return _jsx("svg", { ...p, children: _jsx("path", { d: "M8 14V2M3.5 6.5L8 2l4.5 4.5" }) });
        case 'refresh': return _jsx("svg", { ...p, children: _jsx("path", { d: "M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4M12 2v3h-3M4 14v-3h3" }) });
        case 'sync': return _jsx("svg", { ...p, children: _jsx("path", { d: "M2.5 7a5.5 5.5 0 0 1 9.5-3.5L14 5M13.5 9a5.5 5.5 0 0 1-9.5 3.5L2 11M14 2v3h-3M2 14v-3h3" }) });
        case 'plus': return _jsx("svg", { ...p, children: _jsx("path", { d: "M8 3v10M3 8h10" }) });
        case 'x': return _jsx("svg", { ...p, children: _jsx("path", { d: "M3.5 3.5l9 9M12.5 3.5l-9 9" }) });
        case 'check': return _jsx("svg", { ...p, children: _jsx("path", { d: "M3 8.5l3 3 7-7" }) });
        case 'chev-down': return _jsx("svg", { ...p, children: _jsx("path", { d: "M3.5 5.5L8 10l4.5-4.5" }) });
        case 'chev-right': return _jsx("svg", { ...p, children: _jsx("path", { d: "M5.5 3.5L10 8l-4.5 4.5" }) });
        case 'chev-up': return _jsx("svg", { ...p, children: _jsx("path", { d: "M3.5 10.5L8 6l4.5 4.5" }) });
        case 'dot': return _jsx("svg", { ...p, fill: "currentColor", stroke: "none", children: _jsx("circle", { cx: "8", cy: "8", r: "2" }) });
        case 'more': return _jsxs("svg", { ...p, fill: "currentColor", stroke: "none", children: [_jsx("circle", { cx: "3.5", cy: "8", r: "1.2" }), _jsx("circle", { cx: "8", cy: "8", r: "1.2" }), _jsx("circle", { cx: "12.5", cy: "8", r: "1.2" })] });
        case 'history': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M2 8a6 6 0 1 1 6 6" }), _jsx("path", { d: "M2 14v-3h3M8 4v4l3 2" })] });
        case 'compare': return _jsx("svg", { ...p, children: _jsx("path", { d: "M4 2v9M4 11l-2-2M4 11l2-2M12 14V5M12 5l-2 2M12 5l2 2" }) });
        case 'blame': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "8", cy: "5", r: "2.5" }), _jsx("path", { d: "M2.5 14c.5-3 2.8-4.5 5.5-4.5s5 1.5 5.5 4.5" })] });
        case 'content': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "2", y: "2", width: "12", height: "12", rx: "1" }), _jsx("path", { d: "M5 6h6M5 8.5h6M5 11h4" })] });
        case 'terminal': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "1.5", y: "3", width: "13", height: "10", rx: "1" }), _jsx("path", { d: "M4 6.5l2 1.5-2 1.5M8 10.5h3" })] });
        case 'external': return _jsx("svg", { ...p, children: _jsx("path", { d: "M9 2h5v5M14 2l-7 7M7 3H3v10h10V9" }) });
        case 'eye': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5Z" }), _jsx("circle", { cx: "8", cy: "8", r: "2" })] });
        case 'split': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "2", y: "2.5", width: "12", height: "11", rx: "1" }), _jsx("path", { d: "M8 2.5v11" })] });
        case 'unified': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "2", y: "2.5", width: "12", height: "11", rx: "1" }), _jsx("path", { d: "M2 8h12" })] });
        case 'rebase': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "4", cy: "3.5", r: "1.5" }), _jsx("circle", { cx: "4", cy: "8", r: "1.5" }), _jsx("circle", { cx: "4", cy: "12.5", r: "1.5" }), _jsx("circle", { cx: "12", cy: "8", r: "1.5" }), _jsx("path", { d: "M4 5v1.5M4 9.5V11M5.5 8h5" })] });
        case 'circle': return _jsx("svg", { ...p, children: _jsx("circle", { cx: "8", cy: "8", r: "3" }) });
        case 'lock': return _jsxs("svg", { ...p, children: [_jsx("rect", { x: "3", y: "7", width: "10", height: "7", rx: "1" }), _jsx("path", { d: "M5 7V5a3 3 0 1 1 6 0v2" })] });
        case 'star': return _jsx("svg", { ...p, children: _jsx("path", { d: "M8 2l1.8 3.8 4.2.6-3 2.9.7 4.1L8 11.5 4.3 13.4 5 9.3 2 6.4l4.2-.6L8 2Z" }) });
        case 'gpg': return _jsxs("svg", { ...p, children: [_jsx("path", { d: "M3 7V5a5 5 0 0 1 10 0v2" }), _jsx("rect", { x: "2.5", y: "7", width: "11", height: "6.5", rx: "1" }), _jsx("circle", { cx: "8", cy: "10", r: "1" })] });
        case 'settings': return _jsxs("svg", { ...p, children: [_jsx("circle", { cx: "8", cy: "8", r: "2.2" }), _jsx("path", { d: "M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" })] });
        case 'win-min': return _jsx("svg", { ...p, viewBox: "0 0 10 10", strokeWidth: 1, children: _jsx("path", { d: "M1 5h8" }) });
        case 'win-max': return _jsx("svg", { ...p, viewBox: "0 0 10 10", strokeWidth: 1, children: _jsx("rect", { x: "1.5", y: "1.5", width: "7", height: "7" }) });
        case 'win-close': return _jsx("svg", { ...p, viewBox: "0 0 10 10", strokeWidth: 1, children: _jsx("path", { d: "M1 1l8 8M9 1l-8 8" }) });
    }
}
