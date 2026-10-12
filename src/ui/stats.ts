import type { Summary } from '../core/lifestats'
import { MAX_ORDER } from '../core/orders'
import type { StatsSnapshot } from '../sim/protocol'
import { sparkline } from './charts'
import { LEVELS } from '../core/ladder'
import { CHART, INK, fmt } from './theme'

const HISTORY = 200

interface Spark {
  key: 'orgs' | 'food' | 'energy'
  color: string
  data: number[]
  canvas: HTMLCanvasElement
}

/** The left rail: what the world is doing right now, updated every frame. */
export class StatsPanel {
  private el: Record<string, HTMLElement> = {}
  private sparks: Spark[] = []
  private lastTick = -1
  private lifeCanvas: HTMLCanvasElement

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hd"><span id="s-tick">tick 0</span><span id="s-rate" class="dim"></span></div>
      <div class="dim" id="s-world"></div>
      <div class="dim" id="s-perf"></div>
      <div class="blk rung" id="s-rung-blk"><div class="row-k"><b id="s-rung-n"></b><i id="s-rung"></i></div>
        <ol class="ladder" id="s-ladder"></ol>
        <div class="sub" id="s-rung-sub"></div></div>
      ${this.block('Organisms', 'orgs')}
      <div class="sub" id="s-orgs-sub"></div>
      ${this.block('Food', 'food')}
      ${this.block('Energy', 'energy')}
      <div class="sub" id="s-energy-sub"></div>
      <div class="blk"><div class="row-k"><b>Compound organisms</b><i id="s-order"></i></div>
        <div class="sub" id="s-order-sub"></div></div>
      <div class="blk" id="s-islands-blk" hidden><div class="row-k"><b>Where they came from</b><i id="s-islands"></i></div>
        <div class="sub" id="s-islands-sub"></div></div>
      <div class="blk"><div class="row-k"><b>Lineages</b><i id="s-lineage"></i></div>
        <div class="sub" id="s-lineage-sub"></div></div>
      <div class="blk"><div class="row-k"><b>Mean lifespan</b><i id="s-life-head" class="dim"></i></div>
        <canvas id="c-life" width="248" height="38"></canvas>
        <div class="sub" id="s-life"></div></div>`
    for (const id of [
      's-tick', 's-rate', 's-world', 's-perf', 's-orgs', 's-orgs-sub', 's-food', 's-energy',
      's-energy-sub', 's-order', 's-order-sub', 's-lineage', 's-lineage-sub', 's-life', 's-life-head',
      's-islands', 's-islands-sub', 's-islands-blk',
      's-rung', 's-rung-n', 's-rung-sub', 's-ladder', 's-rung-blk',
    ]) {
      this.el[id] = root.querySelector<HTMLElement>('#' + id)!
    }
    for (const [key, color] of [['orgs', CHART.blue], ['food', CHART.mint], ['energy', CHART.amber]] as const) {
      this.sparks.push({ key, color, data: [], canvas: root.querySelector<HTMLCanvasElement>('#c-' + key)! })
    }
    this.lifeCanvas = root.querySelector<HTMLCanvasElement>('#c-life')!
  }

  private block(title: string, key: string): string {
    return `<div class="blk"><div class="row-k"><b>${title}</b><i id="s-${key}"></i></div>
      <canvas id="c-${key}" width="248" height="26"></canvas></div>`
  }

  reset(): void {
    for (const s of this.sparks) s.data = []
    this.lastTick = -1
  }

  update(st: StatsSnapshot, rateLabel: string, perf = ''): void {
    const c = st.census
    const total = c.eOrganisms + c.eFree + c.eFood
    if (st.tick !== this.lastTick) {
      this.lastTick = st.tick
      const vals = { orgs: c.organisms, food: c.food, energy: total }
      for (const s of this.sparks) {
        s.data.push(vals[s.key])
        if (s.data.length > HISTORY) s.data.shift()
      }
    }
    const set = (id: string, text: string): void => {
      this.el[id].textContent = text
    }
    set('s-tick', `tick ${fmt.n(st.tick)}`)
    set('s-rate', rateLabel)
    set('s-world', `seed ${st.seed} · ${st.size}² · food ${st.foodMode}${st.foodMoves ? ', drifting' : ', static'} · T ${st.T}`)
    set('s-perf', `${perf}${st.clampedPct > 0.05 ? ` · clamp ${st.clampedPct.toFixed(1)}%` : ''}`)

    // How far this world has got, against absolute thresholds calibrated to what the world used
    // to manage. It is the one number that answers "is this going anywhere", which is otherwise
    // spread across six blocks.
    const L = st.ladder
    const done = L.reached + 1
    // the level is the headline: it says what *kind* of thing exists, where the rung count says
    // only how far along a list the world has got
    set('s-rung-n', `${L.levelName}${L.level >= 0 ? ` · level ${L.level}` : ''}`)
    // both figures, because they answer different questions: how far up without a gap, and how
    // many rungs this world clears in total
    set('s-rung', `rung ${done}/${L.top + 1} · ${L.passed} met · score ${L.score.toFixed(1)}`)
    // The ladder is drawn climbed: every rung shows where this world stands against it, so a
    // rung that is not met still says by how much it is missed rather than going blank.
    this.el['s-ladder'].innerHTML = L.rungs
      .map((r) => {
        const state = r.met ? 'met' : r.n === (L.next?.n ?? -1) ? 'next' : 'locked'
        const mark = r.met ? '✓' : state === 'next' ? '▸' : '·'
        // the progress figure on an unmet rung is what makes the ladder a gradient rather than a
        // cliff: "nearly" and "nowhere near" look different
        const pct = r.met ? '' : ` <b>${Math.round(100 * Math.min(1, r.ratio))}%</b>`
        return `<li class="${state} lvl${r.level}" title="${LEVELS[r.level]} — ${r.needs}"><i>${mark}</i><span>${r.name}${pct}</span><em>${r.at}</em></li>`
      })
      .reverse() // a ladder is climbed upward, so the furthest rung belongs at the top
      .join('')
    this.el['s-rung-sub'].innerHTML = L.next
      ? `to climb: <b>${L.next.name}</b> — ${L.next.needs}`
      : 'every measured rung reached'

    set('s-orgs', `${fmt.n(c.organisms)} alive`)
    set('s-orgs-sub', `born ${fmt.n(st.births)} (${fmt.n(st.budded)} bred) · died ${fmt.n(st.deaths)} · ${c.organisms ? (c.limbs / c.organisms).toFixed(1) : '–'} limbs each · ${fmt.n(c.freeMatter)} loose`)
    set('s-food', fmt.n(c.food))
    set('s-energy', fmt.n(total))
    set('s-energy-sub', `in organisms ${fmt.n(c.eOrganisms)} · loose ${fmt.n(c.eFree)} · food ${fmt.n(c.eFood)} · burned ${fmt.n(st.burned)}`)

    const o = st.orders
    const parts: string[] = []
    for (let k = 2; k <= MAX_ORDER; k++) {
      if (o.live[k - 1] === 0 && o.surviving[k - 1] === 0) continue
      parts.push(`<b>${k}°</b> ${o.live[k - 1]}${o.surviving[k - 1] ? ` <span style="color:${INK.good}">(${o.surviving[k - 1]} held)</span>` : ''}`)
    }
    set('s-order', o.bestOrder > 1 ? `best ${o.bestOrder}° · ${fmt.n(o.bestAge)}t` : '—')
    // The structure line is the one to watch: an aggregate whose members have turned over and
    // which is still there is a different kind of object from a clump of the originals.
    const old = o.oldest
    this.el['s-order-sub'].innerHTML =
      (parts.length ? parts.join(' &nbsp; ') : 'none joined') +
      `<br>${fmt.n(st.bondCount)} bonds standing` +
      (old
        ? `<br>best structure: <b>${old.order}°</b> for ${fmt.n(old.age)}t (${Math.round(100 * old.heldFrac)}% of a life)` +
          (old.replacements > 0
            ? `, <span style="color:${INK.good}">${fmt.n(old.replacements)} members replaced</span>`
            : ', all original')
        : '')

    // only a merged world has islands, and only then is "which of them is winning" a question
    const live = c.islands.filter((n) => n > 0).length
    this.el['s-islands-blk'].hidden = live < 2
    if (live >= 2) {
      const names = st.islandNames ?? []
      const total = Math.max(1, c.organisms)
      let h = 0
      for (const n of c.islands) {
        if (n > 0) h -= (n / total) * Math.log2(n / total)
      }
      set('s-islands', `${h.toFixed(2)} bits`)
      this.el['s-islands-sub'].innerHTML =
        c.islands
          .map((n, i) => (n === 0 ? '' : `<b>${names[i] ?? `island ${i}`}</b> ${n} (${Math.round((100 * n) / total)}%)`))
          .filter(Boolean)
          .join(' &nbsp; ') +
        `<br>${fmt.n(c.crossBonds)} bonds between organisms from different islands` +
        (st.mergeProgress === null
          ? '<br><b>held apart</b> — press “Bring them together” to start the colonies closing'
          : st.mergeProgress < 1
            ? `<br>colonies ${Math.round(st.mergeProgress * 100)}% of the way together`
            : '<br>colonies fully merged')
    }

    set('s-lineage', `${fmt.n(c.lineages)} alive`)
    set('s-lineage-sub', `biggest ${fmt.n(c.biggestLineage)} · gen ${fmt.n(c.maxGen)} · children ${fmt.n(c.children)} (most ${fmt.n(c.maxChildren)}) · oldest ${fmt.n(c.oldest)}t`)

    const l = st.life
    const show = (v: number): string => (Number.isFinite(v) ? fmt.n(v) : '–')
    set('s-life-head', `${(l.windowTicks / 1000).toFixed(0)}k window`)
    const sum = (label: string, s: Summary): string =>
      s.n === 0 ? `${label} —` : `${label} ${[s.min, s.median, s.mean, s.p90, s.max].map((v) => Math.round(v)).join(' / ')}`
    this.el['s-life'].innerHTML =
      `<span style="color:${CHART.blue}">■</span> particles ${show(l.windowMeanParticles)} &nbsp;` +
      `<span style="color:${CHART.coral}">■</span> organisms ${show(l.windowMeanOrganisms)}<br>` +
      `<span class="dim">all-time min/med/mean/p90/max</span><br>${sum('particles', l.particlesDied)}<br>${sum('organisms', l.organismsDied)}`

    this.lifeTrend(l.particlesTrend, l.organismsTrend)
    for (const s of this.sparks) sparkline(s.canvas, s.data, s.color)
  }

  /** Two lines on one scale: mean completed lifespan per bucket. Gaps are left, not bridged. */
  private lifeTrend(particles: Float64Array, organisms: Float64Array): void {
    const g = this.lifeCanvas.getContext('2d')!
    const { width: W, height: H } = this.lifeCanvas
    g.clearRect(0, 0, W, H)
    let max = 0
    for (const arr of [particles, organisms]) for (const v of arr) if (Number.isFinite(v) && v > max) max = v
    if (max <= 0) return
    for (const [arr, color] of [[particles, CHART.blue], [organisms, CHART.coral]] as const) {
      g.strokeStyle = color
      g.lineWidth = 1.5
      g.lineJoin = 'round'
      g.beginPath()
      let open = false
      arr.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          open = false
          return
        }
        const x = (i / (arr.length - 1)) * W
        const y = H - 2 - (v / max) * (H - 4)
        if (open) g.lineTo(x, y)
        else g.moveTo(x, y)
        open = true
      })
      g.stroke()
    }
    g.fillStyle = INK.muted
    g.font = '9px ui-monospace, monospace'
    g.fillText(fmt.n(max), 2, 9)
  }
}
