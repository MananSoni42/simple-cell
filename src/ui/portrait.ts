import { N_BRAIN_IN, N_BRAIN_OUT } from '../core/neurons'
import type { OrganismFile } from '../core/organism'
import { LAWS } from '../core/params'
import { TYPE_NAMES } from '../core/types'
import { INK, WORLD } from './theme'

/**
 * An organism drawn rather than described. Three pieces, all generated from the organism's own
 * numbers, so two organisms never look alike unless they really are alike:
 *
 *  - the **body**: its actual rod angles and limb types, with energy shown the way the world
 *    shows it — a brain that fills from the bottom, a limb whose bright core grows with reserve;
 *  - **reserves** as bars, so starving limbs are obvious at a glance;
 *  - the **brain's weights** as a heatmap. 290 numbers nobody can read, but their *pattern* is a
 *    fingerprint, and it is the only part of an organism that is actually inherited.
 */

const L = LAWS
const SIZE = 236
const C = SIZE / 2
const R = 74 // rod length on screen
const SCALE = R / L.L_rod

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export function bodyDiagram(o: OrganismFile): string {
  const quadrants = [0, 1, 2, 3]
    .map((q) => {
      const a = (q * Math.PI) / 2
      return `<line x1="${C}" y1="${C}" x2="${(C + (R + 16) * Math.cos(a)).toFixed(1)}" y2="${(C + (R + 16) * Math.sin(a)).toFixed(1)}"
        stroke="${INK.line}" stroke-width="7" stroke-linecap="round"/>`
    })
    .join('')
  const labels = [0, 1, 2, 3]
    .map((q) => {
      const a = (q + 0.5) * (Math.PI / 2)
      const filled = o.limbs.some((l) => l.quad === q)
      return `<text x="${(C + 40 * Math.cos(a)).toFixed(1)}" y="${(C + 40 * Math.sin(a) + 3.5).toFixed(1)}"
        fill="${INK.muted}" font-size="9" text-anchor="middle" opacity="${filled ? 1 : 0.45}">q${q}</text>`
    })
    .join('')

  const rods = o.limbs
    .map((limb) => {
      const col = WORLD[limb.type]
      const x = C + R * Math.cos(limb.angle)
      const y = C + R * Math.sin(limb.angle)
      const e = clamp01(limb.reserve / L.E_ref)
      const rr = 2.7 * SCALE
      return `
        <line x1="${C}" y1="${C}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr.toFixed(1)}" fill="${col}" fill-opacity="0.28"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(rr * Math.sqrt(e)).toFixed(1)}" fill="${col}"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr.toFixed(1)}" fill="none"
          stroke="${e < 0.12 ? INK.bad : col}" stroke-width="1"/>
        <text x="${x.toFixed(1)}" y="${(y + rr + 11).toFixed(1)}" fill="${INK.muted}" font-size="9" text-anchor="middle">${TYPE_NAMES[limb.type]}</text>`
    })
    .join('')

  // the brain, filling from the bottom exactly as it does on the canvas
  const e = clamp01(o.reserve / L.E_ref)
  const br = 4 * SCALE
  const brain = `
    <rect x="${(C - br).toFixed(1)}" y="${(C - br).toFixed(1)}" width="${(2 * br).toFixed(1)}" height="${(2 * br).toFixed(1)}" fill="#1b2230"/>
    <rect x="${(C - br).toFixed(1)}" y="${(C - br + 2 * br * (1 - e)).toFixed(1)}" width="${(2 * br).toFixed(1)}" height="${(2 * br * e).toFixed(1)}"
      fill="${e < 0.12 ? INK.bad : WORLD[4]}"/>
    <rect x="${(C - br).toFixed(1)}" y="${(C - br).toFixed(1)}" width="${(2 * br).toFixed(1)}" height="${(2 * br).toFixed(1)}"
      fill="none" stroke="${WORLD[4]}" stroke-width="1"/>`

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="portrait" role="img"
      aria-label="an organism with ${o.limbs.length} limbs, generation ${o.generation}">
    <circle cx="${C}" cy="${C}" r="${R + 10}" fill="rgba(244,246,251,0.035)" stroke="rgba(244,246,251,0.12)"/>
    ${quadrants}${labels}${rods}${brain}
  </svg>`
}

/** One bar per reserve: the brain first, then each limb, against the same scale. */
export function reserveBars(o: OrganismFile): string {
  const row = (label: string, v: number, color: string): string => {
    const f = clamp01(v / L.E_cap)
    const low = f < 0.12
    return `<div class="bar-row">
      <span class="bar-k"><span class="swatch" style="background:${color}"></span>${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(f * 100).toFixed(1)}%;background:${low ? INK.bad : INK.secondary}"></span></span>
      <span class="bar-v"${low ? ` style="color:${INK.bad}"` : ''}>${v.toFixed(0)}</span>
    </div>`
  }
  return `<div class="bars">
    ${row('brain', o.reserve, WORLD[4])}
    ${o.limbs.map((l) => row(`q${l.quad} ${TYPE_NAMES[l.type]}`, l.reserve, WORLD[l.type])).join('')}
    <div class="note">full bar = ${L.E_cap}, the most anything can hold · the bar turns red under ${Math.round(0.12 * L.E_cap)};
      the dot is the particle's type</div>
  </div>`
}

/** Diverging: amber for positive, blue for negative, dark at zero — the matrix editor's scheme. */
function weightColor(v: number, scale: number): string {
  const m = Math.min(1, Math.abs(v) / scale)
  if (m < 0.04) return '#121722'
  return v > 0 ? `rgba(255,170,60,${0.12 + 0.82 * m})` : `rgba(80,140,255,${0.12 + 0.82 * m})`
}

/**
 * The brain's weights as a grid, one row per output. Unreadable as numbers and not meant to be
 * read: it is there so an organism has a face, and so a parent and child visibly resemble
 * each other while an unrelated organism does not.
 */
export function weightMap(o: OrganismFile): string {
  const rows = N_BRAIN_OUT
  const cols = N_BRAIN_IN
  const cw = 6
  const ch = 9
  const gap = 1
  const w = cols * (cw + gap)
  const h = rows * (ch + gap)
  let scale = 0
  for (const v of o.wBrain) scale = Math.max(scale, Math.abs(v))
  scale = scale || 1
  let cells = ''
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = o.wBrain[r * cols + c] ?? 0
      cells += `<rect x="${c * (cw + gap)}" y="${r * (ch + gap)}" width="${cw}" height="${ch}" rx="1.5" fill="${weightColor(v, scale)}"/>`
    }
  }
  const labels = ['move x', 'move y', 'feed q0', 'feed q1', 'feed q2', 'feed q3', 'say q0', 'say q1', 'say q2', 'say q3']
  const rowLabels = labels
    .slice(0, rows)
    .map((t, r) => `<text x="-6" y="${r * (ch + gap) + ch - 0.5}" fill="${INK.muted}" font-size="8" text-anchor="end">${t}</text>`)
    .join('')

  let limbCells = ''
  let ls = 0
  for (const v of o.wLimb) ls = Math.max(ls, Math.abs(v))
  ls = ls || 1
  o.wLimb.forEach((v, i) => {
    limbCells += `<rect x="${i * (cw + gap)}" y="0" width="${cw}" height="${ch}" rx="1.5" fill="${weightColor(v, ls)}"/>`
  })

  return `<div class="wmap">
    <svg viewBox="-50 -2 ${w + 54} ${h + 4}" role="img" aria-label="brain weights, ${rows} outputs by ${cols} inputs">
      ${rowLabels}${cells}
    </svg>
    <div class="wmap-foot">
      <svg viewBox="-50 -2 ${w + 54} ${ch + 4}" role="img" aria-label="limb weights">
        <text x="-6" y="${ch - 1.5}" fill="${INK.muted}" font-size="8" text-anchor="end">limb</text>${limbCells}
      </svg>
    </div>
    <div class="note"><span class="swatch" style="background:rgba(80,140,255,.85)"></span>negative
      <span class="swatch" style="background:rgba(255,170,60,.85)"></span>positive ·
      ${o.wBrain.length} brain weights and ${o.wLimb.length} limb weights, the only part of an organism that is inherited</div>
  </div>`
}

export function portrait(o: OrganismFile): string {
  return bodyDiagram(o) + reserveBars(o)
}
