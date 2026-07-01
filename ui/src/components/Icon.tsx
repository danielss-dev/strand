import type { SVGProps } from 'react';

export type IconName =
  | 'edit' | 'graph' | 'branch' | 'tag' | 'stash' | 'remote' | 'submodule' | 'worktree'
  | 'file' | 'folder' | 'folder-open' | 'changes' | 'search' | 'command'
  | 'arrow-down' | 'arrow-up' | 'refresh' | 'sync' | 'plus' | 'minus' | 'x' | 'check'
  | 'chev-down' | 'chev-right' | 'chev-up' | 'chev-left' | 'expand-all' | 'collapse-all' | 'dot' | 'more'
  | 'history' | 'compare' | 'blame' | 'content' | 'terminal' | 'external' | 'eye' | 'sparkle'
  | 'split' | 'unified' | 'rebase' | 'circle' | 'lock' | 'star' | 'gpg' | 'settings'
  | 'trash'
  | 'win-min' | 'win-max' | 'win-restore' | 'win-close';

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name' | 'stroke'> {
  name: IconName;
  size?: number;
  stroke?: number;
}

/**
 * Strand icon set — single-stroke 16×16 line icons, ported from the
 * Claude Design prototype. Color comes from `currentColor`, weight from
 * `stroke`. Add new glyphs here, not as one-off SVGs in components.
 */
export function Icon({ name, size = 14, stroke = 1.5, ...rest }: Props) {
  const p: SVGProps<SVGSVGElement> = {
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
    case 'edit':        return <svg {...p}><path d="M2.5 11.5v2h2L13 5l-2-2L2.5 11.5Z"/></svg>;
    case 'graph':       return <svg {...p}><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.1V11M5.4 12L10.6 8.7M5.6 4.3l5 2.9"/></svg>;
    case 'branch':      return <svg {...p}><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v6M4.4 11.6c0-3 7.6-2 7.6-4"/></svg>;
    case 'tag':         return <svg {...p}><path d="M8 1.5H2v6l6.5 6.5a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4L8 1.5Z"/><circle cx="5" cy="5" r="0.6" fill="currentColor"/></svg>;
    case 'stash':       return <svg {...p}><rect x="1.5" y="6" width="13" height="8" rx="1.5"/><path d="M3 4h10M4.5 2h7"/></svg>;
    case 'remote':      return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 1.7 3 4 3 6s-1 4.3-3 6c-2-1.7-3-4-3-6s1-4.3 3-6Z"/></svg>;
    case 'submodule':   return <svg {...p}><rect x="2" y="2" width="12" height="12" rx="1.5"/><rect x="5" y="5" width="6" height="6" rx="0.5"/></svg>;
    case 'worktree':    return <svg {...p}><circle cx="4" cy="3.5" r="1.6"/><path d="M4 5.1v4.4M4 9.5c0 1.6 2.2 1.5 4 1.5"/><rect x="8" y="8.5" width="6" height="5" rx="1"/></svg>;
    case 'file':        return <svg {...p}><path d="M3 1.5h7l3 3v10H3v-13Z"/><path d="M10 1.5v3h3"/></svg>;
    case 'folder':      return <svg {...p}><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"/></svg>;
    case 'folder-open': return <svg {...p}><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v1.5H1.5V4Z"/><path d="M1.5 6h13l-1.2 6.6a1 1 0 0 1-1 .9H3.7a1 1 0 0 1-1-.9L1.5 6Z"/></svg>;
    case 'changes':     return <svg {...p}><circle cx="8" cy="8" r="6.2"/><path d="M5 8h6M8 5v6"/></svg>;
    case 'search':      return <svg {...p}><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4l3.1 3.1"/></svg>;
    case 'command':     return <svg {...p}><path d="M4.5 2A2 2 0 1 0 4.5 6h2v4h-2A2 2 0 1 0 4.5 14V12M6.5 6h3v4M11.5 6A2 2 0 1 0 11.5 2v4M11.5 10A2 2 0 1 1 11.5 14v-4"/></svg>;
    case 'arrow-down':  return <svg {...p}><path d="M8 2v12M3.5 9.5L8 14l4.5-4.5"/></svg>;
    case 'arrow-up':    return <svg {...p}><path d="M8 14V2M3.5 6.5L8 2l4.5 4.5"/></svg>;
    case 'refresh':     return <svg {...p}><path d="M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4M12 2v3h-3M4 14v-3h3"/></svg>;
    case 'sync':        return <svg {...p}><path d="M2.5 7a5.5 5.5 0 0 1 9.5-3.5L14 5M13.5 9a5.5 5.5 0 0 1-9.5 3.5L2 11M14 2v3h-3M2 14v-3h3"/></svg>;
    case 'plus':        return <svg {...p}><path d="M8 3v10M3 8h10"/></svg>;
    case 'minus':       return <svg {...p}><path d="M3 8h10"/></svg>;
    case 'x':           return <svg {...p}><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>;
    case 'trash':       return <svg {...p}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.2a1 1 0 0 0 1 .8h4.4a1 1 0 0 0 1-.8L12 4M6.5 6.5v5M9.5 6.5v5"/></svg>;
    case 'check':       return <svg {...p}><path d="M3 8.5l3 3 7-7"/></svg>;
    case 'chev-down':   return <svg {...p}><path d="M3.5 5.5L8 10l4.5-4.5"/></svg>;
    case 'chev-right':  return <svg {...p}><path d="M5.5 3.5L10 8l-4.5 4.5"/></svg>;
    case 'chev-left':   return <svg {...p}><path d="M10.5 3.5L6 8l4.5 4.5"/></svg>;
    case 'chev-up':     return <svg {...p}><path d="M3.5 10.5L8 6l4.5 4.5"/></svg>;
    case 'expand-all':  return <svg {...p}><path d="M4.5 6.5L8 3l3.5 3.5M4.5 9.5L8 13l3.5-3.5"/></svg>;
    case 'collapse-all':return <svg {...p}><path d="M4.5 3.5L8 7l3.5-3.5M4.5 12.5L8 9l3.5 3.5"/></svg>;
    case 'dot':         return <svg {...p} fill="currentColor" stroke="none"><circle cx="8" cy="8" r="2"/></svg>;
    case 'more':        return <svg {...p} fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>;
    case 'history':     return <svg {...p}><path d="M2 8a6 6 0 1 1 6 6"/><path d="M2 14v-3h3M8 4v4l3 2"/></svg>;
    case 'compare':     return <svg {...p}><path d="M4 2v9M4 11l-2-2M4 11l2-2M12 14V5M12 5l-2 2M12 5l2 2"/></svg>;
    case 'blame':       return <svg {...p}><circle cx="8" cy="5" r="2.5"/><path d="M2.5 14c.5-3 2.8-4.5 5.5-4.5s5 1.5 5.5 4.5"/></svg>;
    case 'content':     return <svg {...p}><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M5 6h6M5 8.5h6M5 11h4"/></svg>;
    case 'terminal':    return <svg {...p}><rect x="1.5" y="3" width="13" height="10" rx="1"/><path d="M4 6.5l2 1.5-2 1.5M8 10.5h3"/></svg>;
    case 'external':    return <svg {...p}><path d="M9 2h5v5M14 2l-7 7M7 3H3v10h10V9"/></svg>;
    case 'eye':         return <svg {...p}><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5Z"/><circle cx="8" cy="8" r="2"/></svg>;
    case 'sparkle':     return <svg {...p}><path d="M8 1.5l.8 2.6L11.5 5l-2.7.9L8 8.5 6.2 5.9 3.5 5l2.7-.9L8 1.5Z"/><path d="M12.5 9l.5 1.5L14.5 11l-1.5.5L12.5 13l-.5-1.5L10.5 11l1.5-.5.5-1.5Z"/></svg>;
    case 'split':       return <svg {...p}><rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M8 2.5v11"/></svg>;
    case 'unified':     return <svg {...p}><rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 8h12"/></svg>;
    case 'rebase':      return <svg {...p}><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="8" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M4 5v1.5M4 9.5V11M5.5 8h5"/></svg>;
    case 'circle':      return <svg {...p}><circle cx="8" cy="8" r="3"/></svg>;
    case 'lock':        return <svg {...p}><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 1 1 6 0v2"/></svg>;
    case 'star':        return <svg {...p}><path d="M8 2l1.8 3.8 4.2.6-3 2.9.7 4.1L8 11.5 4.3 13.4 5 9.3 2 6.4l4.2-.6L8 2Z"/></svg>;
    case 'gpg':         return <svg {...p}><path d="M3 7V5a5 5 0 0 1 10 0v2"/><rect x="2.5" y="7" width="11" height="6.5" rx="1"/><circle cx="8" cy="10" r="1"/></svg>;
    // Gear (Feather "settings"). Drawn in its native 24-grid — the tooth
    // outline doesn't survive a hand-scale to 16 — with the stroke widened
    // 1.5× so the rendered weight matches the 16-grid icons exactly.
    case 'settings':    return <svg {...p} viewBox="0 0 24 24" strokeWidth={stroke * 1.5}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case 'win-min':     return <svg {...p} viewBox="0 0 10 10" strokeWidth={1}><path d="M1 5h8"/></svg>;
    case 'win-max':     return <svg {...p} viewBox="0 0 10 10" strokeWidth={1}><rect x="1.5" y="1.5" width="7" height="7"/></svg>;
    case 'win-restore': return <svg {...p} viewBox="0 0 10 10" strokeWidth={1}><rect x="1.5" y="2.5" width="6" height="6"/><path d="M3.5 2.5V1.5h5v5h-1"/></svg>;
    case 'win-close':   return <svg {...p} viewBox="0 0 10 10" strokeWidth={1}><path d="M1 1l8 8M9 1l-8 8"/></svg>;
  }
}
