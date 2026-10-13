import type { Summary } from '../core/analyse'
import { type CatalogEntry, specInit } from '../core/catalog'
import { LEVELS } from '../core/ladder'
import type { Init } from '../core/params'
import { mountPreview } from './preview'
import { fmt } from './theme'

/**
 * What the search found.
 *
 * Every entry is shown as its **own world, running** — the same `World` built from the same spec,
 * previewed exactly as the picker previews a world you are about to start. That is deliberate: a
 * search result is a claim about a world, and the honest way to present a claim about a world is
 * to run it in front of the person reading. A thumbnail rendered once at some chosen moment would
 * be a picture of the claim rather than the claim.
 *
 * One figure to read with care in the early phases: "held N% of a life" divides a structure's age
 * by the mean *completed* lifespan, and a five-hundred-tick run has few completed lives to average.
 * Percentages far above a hundred there say the denominator is thin, not that a structure outlived
 * generations. From phase 2 on, where worlds run sixteen generations or more, it means what it says.
 *
 * The aggregate half answers the other question. A top-ten list says which worlds worked; it does
 * not say why, and the why is the part that carries to the next search — so the factor table from
 * `analyse.ts` sits above the list, with its standard errors, and says plainly where a difference
 * is within noise.
 */

interface Discoveries {
  kind: string
  at: number
  worlds: number
  phases: { phase: number; worlds: number }[]
  summary: Summary
  analysedPhase: number
  top: CatalogEntry[]
}

export interface DiscoveryHooks {
  /** Open one of these worlds, exactly as it was scored. */
  start(init: Init): void
  back(): void
}

export function mountDiscoveries(root: HTMLElement, hooks: DiscoveryHooks): { refresh(): Promise<void> } {
  let data: Discoveries | null = null
  const previews: { stop(): void }[] = []

  root.innerHTML = `
    <div class="summary">
      <div class="setup-head">
        <div>
          <h1>DISCOVERIES</h1>
          <div class="note" id="d-note">reading the catalog…</div>
        </div>
        <div class="row"><button id="d-back">← back</button></div>
      </div>
      <div id="d-aggregate"></div>
      <h2>Worlds worth looking at</h2>
      <div class="note" style="margin-bottom:12px">Picked along several axes rather than by score
        alone — the best overall, then the best at each thing the ladder measures separately, then
        the best for each food pattern. Ranking a quarter of a million worlds by one number returns
        ten copies of the same trick.</div>
      <div class="disco-grid" id="d-grid"></div>
    </div>`

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!
  q('#d-back').addEventListener('click', () => hooks.back())

  function stopAll(): void {
    for (const p of previews) p.stop()
    previews.length = 0
  }

  /** The factor tables: what the dials and the chemistry did, with the noise marked as noise. */
  function aggregate(d: Discoveries): string {
    const s = d.summary
    const levels = s.byLevel
      .map((n, i) => ({ level: i - 1, n }))
      .filter((x) => x.n > 0 && x.level >= 0)
      .map((x) => `<span class="chip"><i>${LEVELS[x.level] ?? x.level}</i>${fmt.n(x.n)}</span>`)
      .join('')
    const table = (title: string, fs: Summary['factors']['dials']): string => {
      if (!fs.length) return ''
      return `
        <div class="blk"><div class="row-k"><b>${title}</b></div>
          ${fs
            .slice(0, 6)
            .map(
              (f) => `
            <div class="factor${f.real ? '' : ' noise'}">
              <div class="factor-name">${f.name}<i>${f.real ? `z ${f.z.toFixed(1)}` : 'within noise'}</i></div>
              ${f.cells
                .slice(0, 4)
                .map((c) => {
                  const hi = f.cells.reduce((a, x) => (x.mean > a ? x.mean : a), 0) || 1
                  return `<div class="factor-cell"><span>${c.label}</span>
                    <div class="bar"><i style="width:${Math.round((100 * c.mean) / hi)}%"></i></div>
                    <em>${c.mean.toFixed(2)}±${c.se.toFixed(2)} · n ${fmt.n(c.n)}</em></div>`
                })
                .join('')}
            </div>`,
            )
            .join('')}
        </div>`
    }
    return `
      <div class="chips-row" style="margin-bottom:12px">
        <span class="chip"><i>catalogued</i>${fmt.n(d.worlds)}</span>
        <span class="chip"><i>simulated</i>${(s.ticks / 1e6).toFixed(1)}M ticks</span>
        <span class="chip"><i>cost</i>${s.hours.toFixed(1)} core-h</span>
        <span class="chip"><i>best score</i>${s.bestScore.toFixed(2)}</span>
        ${levels}
      </div>
      <div class="note" style="margin-bottom:14px">Factors are measured within phase ${d.analysedPhase}
        alone, because phases fix some dials themselves and pooling them would make those dials a
        proxy for how long a world was run. Nothing is reported from fewer than thirty worlds, and a
        difference is only called real past two standard errors.</div>
      <div class="cols">
        ${table('What the dials did', d.summary.factors.dials)}
        ${table('What shape of chemistry did', [...(d.summary.factors.source ? [d.summary.factors.source] : []), ...d.summary.factors.shapes])}
      </div>
      ${table('Which couplings mattered', d.summary.factors.couplings)}`
  }

  function card(e: CatalogEntry, i: number): string {
    const s = e.stats
    const chip = (k: string, v: string): string => `<span class="chip"><i>${k}</i>${v}</span>`
    return `
      <article class="disco" data-i="${i}">
        <div class="disco-stage"><canvas></canvas></div>
        <div class="disco-body">
          <div class="row-k"><b>${e.why ?? 'high score'}</b><i>score ${e.score.toFixed(2)}</i></div>
          <div class="note" style="color:var(--good)">${e.level >= 0 ? LEVELS[e.level] : 'nothing yet'} · ${e.ratios?.filter((r) => r >= 1).length ?? 0}/13 rungs</div>
          <div class="note">${e.spec.foodMode} · ${e.spec.foodLevel} · ${e.spec.foodRegime} ·
            metabolism ${e.spec.metabolism} · flow ${e.spec.bondFlow} · T ${e.spec.T}${e.spec.fission ? ' · fission' : ''}</div>
          <div class="chips-row">
            ${chip('lives', `${s.p90Coasts?.toFixed(2) ?? '–'} coasts`)}
            ${chip('seeks', (s.seek ?? 0).toFixed(2))}
            ${chip('order', String(s.bestOrder ?? 0))}
            ${chip('held', `${Math.round(100 * (s.heldFrac ?? 0))}% of a life`)}
            ${chip('gen', fmt.n(s.maxGen ?? 0))}
          </div>
          <div class="note">${fmt.n(e.ticks)} ticks × ${e.seeds} seed${e.seeds === 1 ? '' : 's'} · ${e.stop}${e.source ? ` · ${e.source}` : ''}</div>
          <button data-open="${i}">Open this world →</button>
        </div>
      </article>`
  }

  async function refresh(): Promise<void> {
    stopAll()
    try {
      const res = await fetch('/discoveries.json', { cache: 'no-store' })
      if (!res.ok) throw new Error(`no catalog export (${res.status})`)
      data = (await res.json()) as Discoveries
    } catch (err) {
      q('#d-note').textContent = `nothing to show yet — run \`npm run search -- --export\` first (${(err as Error).message})`
      q('#d-grid').innerHTML = ''
      q('#d-aggregate').innerHTML = ''
      return
    }
    const d = data
    q('#d-note').textContent =
      `${fmt.n(d.worlds)} worlds catalogued across ${d.phases.length} phase${d.phases.length === 1 ? '' : 's'} ` +
      `(${d.phases.map((p) => `${p.phase}: ${fmt.n(p.worlds)}`).join(', ')}) · exported ${new Date(d.at).toLocaleString()}`
    q('#d-aggregate').innerHTML = aggregate(d)
    q('#d-grid').innerHTML = d.top.map(card).join('')

    // each card runs its own world: a result about a world is best stated by running it
    for (const [i, e] of d.top.entries()) {
      const canvas = root.querySelector<HTMLCanvasElement>(`.disco[data-i="${i}"] canvas`)
      if (!canvas) continue
      const p = mountPreview(canvas)
      previews.push(p)
      p.show(specInit(e.spec))
    }
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-open]'))) {
      b.addEventListener('click', () => {
        const e = d.top[Number(b.dataset.open)]
        stopAll()
        hooks.start(specInit(e.spec))
      })
    }
  }

  return { refresh }
}
