import { INK, RAMP, fmt } from './theme'

/**
 * The three chart forms this app needs, as SVG.
 *
 * Deliberate omissions, both from the palette validation: there is **no scatter** with four
 * colour-coded series (the palette fails an all-pairs check, so two of the four would be
 * indistinguishable), and there is **no second y-axis** anywhere — two measures of different
 * scale get two charts.
 *
 * Every chart carries a legend whenever it has two or more series, direct labels on the last
 * point, a hover readout, and a table view, so identity is never carried by colour alone.
 */

export interface Series {
  label: string
  color: string
  /** One value per bucket; NaN leaves a gap rather than being bridged. */
  data: ArrayLike<number>
}

export interface ChartSpec {
  title: string
  note?: string
  /** x value per bucket, used for the hover readout. */
  x: ArrayLike<number>
  xLabel?: (v: number) => string
  yLabel?: (v: number) => string
  series: Series[]
  height?: number
}

const W = 560
const PAD = { l: 46, r: 58, t: 10, b: 22 }

let tip: HTMLElement | null = null
function tooltip(): HTMLElement {
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'tooltip'
    tip.hidden = true
    document.body.appendChild(tip)
  }
  return tip
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (mag * m >= v) return mag * m
  return mag * 10
}

function finiteMax(series: Series[]): number {
  let m = 0
  for (const s of series) for (let i = 0; i < s.data.length; i++) if (Number.isFinite(s.data[i]) && s.data[i] > m) m = s.data[i]
  return m
}

function stackedMax(series: Series[], n: number): number {
  let m = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const s of series) if (Number.isFinite(s.data[i])) sum += s.data[i]
    if (sum > m) m = sum
  }
  return m
}

function frame(h: number, max: number, x: ArrayLike<number>, yLabel: (v: number) => string, xLabel: (v: number) => string): string {
  const plotH = h - PAD.t - PAD.b
  const ticks = [0, 0.5, 1]
  let out = ''
  for (const t of ticks) {
    const y = PAD.t + plotH * (1 - t)
    out += `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="${INK.line}" stroke-width="1"/>`
    out += `<text x="${PAD.l - 7}" y="${y + 3.5}" fill="${INK.muted}" font-size="10" text-anchor="end">${yLabel(max * t)}</text>`
  }
  const last = x.length > 0 ? x[x.length - 1] : 0
  out += `<text x="${PAD.l}" y="${h - 6}" fill="${INK.muted}" font-size="10">${xLabel(x.length > 0 ? x[0] : 0)}</text>`
  out += `<text x="${W - PAD.r}" y="${h - 6}" fill="${INK.muted}" font-size="10" text-anchor="end">${xLabel(last)}</text>`
  return out
}

function legend(series: Series[]): string {
  if (series.length < 2) return ''
  return `<div class="legend">${series
    .map((s) => `<span><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`)
    .join('')}</div>`
}

function tableOf(spec: ChartSpec): string {
  const n = spec.x.length
  const rows: string[] = []
  const step = Math.max(1, Math.floor(n / 60)) // a readable number of rows, evenly spaced
  for (let i = 0; i < n; i += step) {
    rows.push(
      `<tr><td>${fmt.n(spec.x[i])}</td>${spec.series
        .map((s) => `<td>${Number.isFinite(s.data[i]) ? fmt.n(s.data[i]) : '–'}</td>`)
        .join('')}</tr>`,
    )
  }
  return `<table><thead><tr><th>tick</th>${spec.series.map((s) => `<th>${s.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`
}

/** Shared chrome: title, a table toggle, the plot, a legend. */
function shell(spec: ChartSpec, plot: string, h: number): HTMLElement {
  const el = document.createElement('figure')
  el.className = 'chart'
  el.style.margin = '0'
  el.innerHTML = `
    <div class="chart-head"><h3>${spec.title}</h3><button type="button" class="t-toggle">table</button></div>
    ${spec.note ? `<p class="note">${spec.note}</p>` : ''}
    <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${spec.title}">${plot}</svg>
    ${legend(spec.series)}
    <div class="t-view" hidden>${tableOf(spec)}</div>`
  const btn = el.querySelector<HTMLButtonElement>('.t-toggle')!
  const svg = el.querySelector('svg')!
  const table = el.querySelector<HTMLElement>('.t-view')!
  btn.addEventListener('click', () => {
    const showTable = table.hidden
    table.hidden = !showTable
    svg.style.display = showTable ? 'none' : 'block'
    btn.textContent = showTable ? 'chart' : 'table'
  })
  return el
}

/** Attaches the crosshair and readout. An HTML chart is interactive, so this is not optional. */
function hover(el: HTMLElement, spec: ChartSpec, h: number, stacked: boolean): void {
  const svg = el.querySelector('svg')!
  const n = spec.x.length
  if (n === 0) return
  const plotW = W - PAD.l - PAD.r
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('stroke', INK.secondary)
  line.setAttribute('stroke-width', '1')
  line.setAttribute('stroke-dasharray', '3 3')
  line.setAttribute('y1', String(PAD.t))
  line.setAttribute('y2', String(h - PAD.b))
  line.style.display = 'none'
  svg.appendChild(line)

  const t = tooltip()
  const move = (e: PointerEvent): void => {
    const r = svg.getBoundingClientRect()
    const fx = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((fx - PAD.l) / plotW) * (n - 1))
    if (i < 0 || i >= n) return
    line.setAttribute('x1', String(PAD.l + (i / (n - 1 || 1)) * plotW))
    line.setAttribute('x2', line.getAttribute('x1')!)
    line.style.display = ''
    const rows = spec.series
      .map((s) => {
        const v = s.data[i]
        return `<div><span class="swatch" style="display:inline-block;background:${s.color}"></span> ${s.label}: <b>${Number.isFinite(v) ? fmt.n(v) : '–'}</b></div>`
      })
      .join('')
    const total = stacked
      ? `<div style="color:${INK.muted};margin-top:3px">total ${fmt.n(spec.series.reduce((a, s) => a + (Number.isFinite(s.data[i]) ? s.data[i] : 0), 0))}</div>`
      : ''
    t.innerHTML = `<div style="color:${INK.muted};margin-bottom:3px">tick ${fmt.n(spec.x[i])}</div>${rows}${total}`
    t.hidden = false
    t.style.left = `${Math.min(innerWidth - t.offsetWidth - 12, e.clientX + 14)}px`
    t.style.top = `${Math.max(8, e.clientY - t.offsetHeight - 10)}px`
  }
  svg.addEventListener('pointermove', move)
  svg.addEventListener('pointerleave', () => {
    line.style.display = 'none'
    t.hidden = true
  })
}

export function lineChart(spec: ChartSpec): HTMLElement {
  const h = spec.height ?? 170
  const n = spec.x.length
  const plotW = W - PAD.l - PAD.r
  const plotH = h - PAD.t - PAD.b
  const max = niceMax(finiteMax(spec.series))
  const yLabel = spec.yLabel ?? fmt.n
  const xLabel = spec.xLabel ?? fmt.n
  let out = frame(h, max, spec.x, yLabel, xLabel)

  for (const s of spec.series) {
    let d = ''
    let open = false
    let lastX = 0
    let lastY = 0
    for (let i = 0; i < n; i++) {
      const v = s.data[i]
      if (!Number.isFinite(v)) {
        open = false // a gap means no data, not a value of zero
        continue
      }
      const x = PAD.l + (i / (n - 1 || 1)) * plotW
      const y = PAD.t + plotH * (1 - Math.min(1, v / max))
      d += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      open = true
      lastX = x
      lastY = y
    }
    out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    if (d) {
      // direct label on the last point, so the series is identified without the legend
      out += `<circle cx="${lastX}" cy="${lastY}" r="2.5" fill="${s.color}"/>`
      out += `<text x="${lastX + 6}" y="${lastY + 3.5}" fill="${INK.secondary}" font-size="10">${s.label}</text>`
    }
  }
  const el = shell(spec, out, h)
  hover(el, spec, h, false)
  return el
}

export function stackedAreaChart(spec: ChartSpec): HTMLElement {
  const h = spec.height ?? 170
  const n = spec.x.length
  const plotW = W - PAD.l - PAD.r
  const plotH = h - PAD.t - PAD.b
  const max = niceMax(stackedMax(spec.series, n))
  const yLabel = spec.yLabel ?? fmt.n
  const xLabel = spec.xLabel ?? fmt.n
  let out = frame(h, max, spec.x, yLabel, xLabel)

  const base = new Float64Array(n)
  for (const s of spec.series) {
    const top: number[] = []
    for (let i = 0; i < n; i++) {
      const v = Number.isFinite(s.data[i]) ? s.data[i] : 0
      top.push(base[i] + v)
    }
    const pt = (i: number, v: number): string =>
      `${(PAD.l + (i / (n - 1 || 1)) * plotW).toFixed(1)},${(PAD.t + plotH * (1 - Math.min(1, v / max))).toFixed(1)}`
    let d = `M${pt(0, top[0])}`
    for (let i = 1; i < n; i++) d += `L${pt(i, top[i])}`
    for (let i = n - 1; i >= 0; i--) d += `L${pt(i, base[i])}`
    // a 2px surface gap between bands: the CVD margin on this palette needs the separation
    out += `<path d="${d}Z" fill="${s.color}" fill-opacity="0.72" stroke="${INK.surface}" stroke-width="2"/>`
    for (let i = 0; i < n; i++) base[i] = top[i]
  }
  const lastTop = base[n - 1] ?? 0
  out += `<text x="${W - PAD.r + 6}" y="${(PAD.t + plotH * (1 - Math.min(1, lastTop / max))).toFixed(1)}" fill="${INK.secondary}" font-size="10">total</text>`
  const el = shell(spec, out, h)
  hover(el, spec, h, true)
  return el
}

export interface BarSpec {
  title: string
  note?: string
  bars: { label: string; value: number; sub?: string }[]
  height?: number
}

/**
 * Horizontal bars on the sequential ramp. Used for compound order, where the categories have a
 * natural ranking — so magnitude wants one hue light-to-dark, not four unrelated hues.
 */
export function barChart(spec: BarSpec): HTMLElement {
  const el = document.createElement('figure')
  el.className = 'chart'
  el.style.margin = '0'
  const max = niceMax(Math.max(...spec.bars.map((b) => b.value), 0))
  const rowH = 26
  const h = Math.max(60, spec.bars.length * rowH + 20)
  const plotW = W - 150
  let out = ''
  spec.bars.forEach((b, i) => {
    const y = i * rowH + 6
    const w = max > 0 ? (b.value / max) * plotW : 0
    const color = RAMP[Math.min(RAMP.length - 1, Math.max(0, RAMP.length - 1 - i))]
    out += `<text x="86" y="${y + 13}" fill="${INK.secondary}" font-size="11" text-anchor="end">${b.label}</text>`
    out += `<rect x="94" y="${y + 3}" width="${Math.max(w, b.value > 0 ? 2 : 0).toFixed(1)}" height="14" rx="4" fill="${color}"/>`
    out += `<text x="${94 + Math.max(w, 2) + 7}" y="${y + 14}" fill="${INK.primary}" font-size="11">${fmt.n(b.value)}${b.sub ? ` <tspan fill="${INK.muted}">${b.sub}</tspan>` : ''}</text>`
  })
  el.innerHTML = `
    <div class="chart-head"><h3>${spec.title}</h3></div>
    ${spec.note ? `<p class="note">${spec.note}</p>` : ''}
    <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${spec.title}">${out}</svg>`
  return el
}

/** A small inline sparkline for the stats rail, drawn on canvas because it redraws every frame. */
export function sparkline(canvas: HTMLCanvasElement, data: number[], color: string): void {
  const g = canvas.getContext('2d')!
  const { width: w, height: h } = canvas
  g.clearRect(0, 0, w, h)
  if (data.length < 2) return
  let lo = Infinity
  let hi = -Infinity
  for (const v of data) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) return
  lo = Math.min(lo, 0)
  const span = hi - lo || 1
  g.strokeStyle = color
  g.lineWidth = 1.5
  g.lineJoin = 'round'
  g.beginPath()
  let open = false
  data.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      open = false
      return
    }
    const x = (i / (data.length - 1)) * w
    const y = h - 2 - ((v - lo) / span) * (h - 4)
    if (open) g.lineTo(x, y)
    else g.moveTo(x, y)
    open = true
  })
  g.stroke()
}
