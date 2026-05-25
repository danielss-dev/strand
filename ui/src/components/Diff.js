import { jsx as _jsx } from "react/jsx-runtime";
import { PatchDiff } from '@pierre/diffs/react';
export function Diff({ patch, layout = 'unified', className, style }) {
    return (_jsx(PatchDiff, { patch: patch, options: {
            diffStyle: layout,
            // Pierre ships matching light/dark themes. Strand is currently dark-only
            // (theme management lands in 0.5); switch to a ThemesType object once
            // light theme is wired.
            theme: 'pierre-dark',
            disableBackground: true,
        }, className: className, style: style }));
}
