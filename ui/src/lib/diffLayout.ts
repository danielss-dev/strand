/** Settings store `'stacked' | 'split'` → Pierre `'unified' | 'split'`. */
export function toPierreLayout(mode: 'stacked' | 'split'): 'unified' | 'split' {
  return mode === 'split' ? 'split' : 'unified';
}
