/**
 * Design tokens.
 *
 * Two palettes, because they do different jobs. WORLD colours are glowing marks on a near-black
 * canvas and are chosen for visibility there. CHART colours are the same four hues stepped down
 * into the dark-mode lightness band so they work as chart marks; that set was run through the
 * palette validator and passes every check on the adjacent pairlist (worst adjacent CVD ΔE 8.4
 * protan, normal-vision 15.7, all ≥3:1 on the surface).
 *
 * Two constraints came out of that run and are load-bearing:
 *  - mint↔amber sits right at the CVD floor, so stacks and lines must carry direct labels and a
 *    2px gap as secondary encoding — colour alone is not enough;
 *  - the set fails an all-pairs check, so no scatter with four colour-coded series. Lines and
 *    stacked areas only.
 */
export const CHART = {
  coral: '#e05668',
  amber: '#c98500',
  mint: '#199e70',
  blue: '#3987e5',
} as const

/** Categorical order, fixed. A fifth series folds into "other" rather than inventing a hue. */
export const SERIES = [CHART.blue, CHART.mint, CHART.amber, CHART.coral] as const

/** Sequential, for magnitude with a natural ranking (compound order). One hue, light to dark. */
export const RAMP = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#184f95'] as const

export const INK = {
  primary: '#e8edf6',
  secondary: '#aab4c6',
  muted: '#6b7589',
  line: '#1b2230',
  surface: '#0b0e14',
  raised: '#0f131c',
  accent: '#7aa2ff',
  good: '#3ddc97',
  warn: '#ffb04d',
  bad: '#ff6b81',
} as const

export const fmt = {
  /** 1234567 -> "1.23M", 4210 -> "4,210". Keeps numbers exact below 10k. */
  n(v: number): string {
    if (!Number.isFinite(v)) return '–'
    const a = Math.abs(v)
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k'
    return Math.round(v).toLocaleString('en-US')
  },
  ticks(v: number): string {
    return fmt.n(v) + (Math.abs(v) === 1 ? ' tick' : ' ticks')
  },
  pct(v: number): string {
    return `${Math.round(v * 100)}%`
  },
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
