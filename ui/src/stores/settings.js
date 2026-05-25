import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const FONTS = {
    ui: {
        geist: "'Geist', -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        inter: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        iaq: "'IBM Plex Sans', sans-serif",
        system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    },
    mono: {
        jetbrains: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        geist: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        plex: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        commit: "'Commit Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        sfmono: "ui-monospace, 'SF Mono', Menlo, monospace",
    },
};
export const useSettings = create()(persist((set) => ({
    theme: 'dark',
    platform: 'mac',
    density: 'default',
    diffMode: 'stacked',
    graphStyle: 'classic',
    uiFont: 'geist',
    monoFont: 'jetbrains',
    set: (key, value) => set({ [key]: value }),
}), { name: 'strand.settings' }));
