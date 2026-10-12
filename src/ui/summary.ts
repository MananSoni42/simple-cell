import type { Init } from '../core/params'
import type { OrganismFile } from '../core/organism'
import { MAX_ORDER } from '../core/orders'
import type { RunRecord } from '../core/recorder'
import { barChart, lineChart, stackedAreaChart } from './charts'
import { download } from './config'
import { stat } from './controls'
import { CHART, INK, fmt } from './theme'
import { defaultName } from '../core/organism'
import { type StoredRun, collection, newId } from './store'

export interface RunResult {
  record: RunRecord
  observations: string[]
  init: Init
  /** Alive at the end, plus a hall of fame (oldest, most children). */
  organisms: OrganismFile[]
  notable: { label: string; organism: OrganismFile }[]
}

/**
 * What happened. Hero numbers first, then the observations in prose, then the charts that back
 * them up, then the exports. Every number here comes off the run record — nothing is estimated.
 */
/**
 * Files a finished run and the three organisms it offered up. Automatic, because a collection
 * nobody remembers to fill is empty; short runs are skipped so fiddling does not clog it.
 */
async function fileRun(result: RunResult): Promise<{ saved: boolean; note: string }> {
  const r = result.record
  if (r.ticks < 300) return { saved: false, note: `too short to keep (${fmt.ticks(r.ticks)})` }
  const runId = newId('run')
  const ids: string[] = []
  for (const n of result.notable) {
    const id = newId('org')
    const name = n.organism.name ?? defaultName(n.organism, n.label.split(' ')[0])
    await collection.putOrganism({
      id,
      savedAt: Date.now(),
      name,
      label: n.label,
      runId,
      organism: { ...n.organism, name, from: { ...n.organism.from!, runId, savedAt: Date.now() } },
    })
    ids.push(id)
  }
  const f = r.final
  const run: StoredRun = {
    id: runId,
    savedAt: Date.now(),
    init: result.init,
    ticks: r.ticks,
    observations: result.observations,
    summary: {
      organisms: f.organisms, births: f.births, budded: f.budded, deaths: f.deaths,
      recordAge: f.recordAge, bestOrder: f.bestOrder, bestOrderAge: f.bestOrderAge,
      burned: f.burned, injected: f.injected, peakOrganisms: r.peaks.organisms.value,
      lineages: f.lineages, maxGen: f.peakGen,
    },
    spark: {
      organisms: Array.from(r.series.organisms).map((v) => Math.round(v * 100) / 100),
      food: Array.from(r.series.food).map((v) => Math.round(v * 100) / 100),
    },
    organismIds: ids,
  }
  await collection.putRun(run)
  return { saved: true, note: `kept this run and ${ids.length} organism${ids.length === 1 ? '' : 's'}` }
}

export function mountSummary(root: HTMLElement, result: RunResult, hooks: { again(): void; setup(): void; library(): void }): void {
  const r = result.record
  const f = r.final
  const orders = []
  for (let k = 1; k <= Math.min(MAX_ORDER, 6); k++) {
    if (f.ordersLive[k - 1] > 0 || f.ordersHeld[k - 1] > 0) {
      orders.push({
        label: `order ${k}`,
        value: f.ordersLive[k - 1],
        sub: f.ordersHeld[k - 1] > 0 ? `${f.ordersHeld[k - 1]} held` : '',
      })
    }
  }

  root.innerHTML = `
    <div class="summary">
      <div class="setup-head">
        <div>
          <h1>RUN ENDED</h1>
          <div class="note">seed ${f ? result.init.seed : ''} · ${result.init.size}² · ${fmt.ticks(r.ticks)} ·
            sampled every ${fmt.n(r.bucketTicks)} into ${r.n} buckets</div>
          ${
            f.learner
              ? `<div class="note" style="margin-top:5px;color:var(--accent)">learned with
                 <b>${f.learner.name}</b> on <b>${f.learner.fitness}</b> —
                 ${fmt.n(f.learner.seen)} lives scored, ${fmt.n(f.learner.updates)} updates,
                 best ${fmt.sig(f.learner.best)}, last ${fmt.sig(f.learner.recent)} on average
                 (percentiles among recent deaths).
                 A chosen measure is part of the result, not a property of the world.${
                   f.fitnessChanges?.length
                     ? ` <b>The measure changed mid-run</b> — ${f.fitnessChanges
                         .map((c) => `tick ${fmt.n(c.tick)} → ${c.measure}`)
                         .join(', ')} — so this run is not comparable with any other.`
                     : ''
                 }</div>`
              : ''
          }
        </div>
        <div class="row">
          <button class="primary" id="x-again">Run it again</button>
          <button id="x-setup">New world</button>
          <button id="x-lib">Collection</button>
        </div>
      </div>

      <div class="hero">
        ${stat('organisms at the end', fmt.n(f.organisms), `peak ${fmt.n(r.peaks.organisms.value)} at tick ${fmt.n(r.peaks.organisms.tick)}`)}
        ${stat('born', fmt.n(f.births), `${fmt.n(f.budded)} of them bred`, CHART.blue)}
        ${stat('died', fmt.n(f.deaths), `mean life ${fmt.n(f.lifeOrganisms)} ticks`, CHART.coral)}
        ${stat('oldest', fmt.ticks(f.recordAge), `generation ${fmt.n(f.peakGen)} reached`)}
        ${stat('best compound', f.bestOrder > 1 ? `order ${f.bestOrder}` : '—', f.bestOrder > 1 ? `held ${fmt.n(f.bestOrderAge)} ticks` : 'nothing joined up', CHART.mint)}
        ${stat('energy burned', fmt.n(f.burned), `of ${fmt.n(f.initialEnergy + f.injected)} that ever existed`, CHART.amber)}
      </div>

      <h2>What happened</h2>
      <ul class="obs">${result.observations.map((o) => `<li>${o}</li>`).join('')}</ul>

      <h2>Over the run</h2>
      <div class="charts" id="x-charts"></div>

      <h2>Take it with you</h2>
      <div class="row" style="margin-bottom:8px">
        <button id="x-run">export the whole run</button>
        <button id="x-orgs">export ${result.organisms.length} organism${result.organisms.length === 1 ? '' : 's'}</button>
        ${result.notable.map((nb, i) => `<button data-nb="${i}">save the ${nb.label}</button>`).join('')}
        <span class="note" id="x-note"></span>
      </div>
      <p class="note">The run file holds the config, every sampled series and these totals, so a run can be
        reopened or compared later. An organism file can be loaded back into any world from its inspector.</p>
    </div>`

  const charts = root.querySelector('#x-charts')!
  const x = r.x
  charts.append(
    lineChart({
      title: 'Population',
      note: 'organisms, food in the world, and matter still drifting loose',
      x,
      series: [
        { label: 'organisms', color: CHART.blue, data: r.series.organisms },
        { label: 'food', color: CHART.mint, data: r.series.food },
        { label: 'free matter', color: CHART.amber, data: r.series.freeMatter },
      ],
    }),
    stackedAreaChart({
      title: 'Where the energy sat',
      note: 'held in organisms, in loose matter, and in uneaten food',
      x,
      series: [
        { label: 'organisms', color: CHART.blue, data: r.series.eOrganisms },
        { label: 'loose', color: CHART.amber, data: r.series.eFree },
        { label: 'food', color: CHART.mint, data: r.series.eFood },
      ],
    }),
    lineChart({
      title: 'Mean lifespan',
      note: 'average completed life, over a trailing window',
      x,
      yLabel: (v) => fmt.n(v),
      series: [
        { label: 'particles', color: CHART.blue, data: r.series.lifeParticles },
        { label: 'organisms', color: CHART.coral, data: r.series.lifeOrganisms },
      ],
    }),
    lineChart({
      title: 'Holding together',
      note: 'bonds standing, and compounds of two or more organisms',
      x,
      series: [
        { label: 'bonds', color: CHART.mint, data: r.series.bonds },
        { label: 'compounds', color: CHART.coral, data: r.series.compounds },
      ],
    }),
  )
  if (orders.length > 0) {
    charts.append(
      barChart({
        title: 'Compounds at the end',
        note: 'by order — one organism, two bonded into one object, and so on. "Held" means bonded for a quarter of the trailing window.',
        bars: orders,
      }),
    )
  }
  if (r.peaks.lineages.value > 1) {
    charts.append(
      lineChart({
        title: 'Lineages alive',
        note: `peaked at ${fmt.n(r.peaks.lineages.value)}; ${fmt.n(f.lineages)} survived, the largest holding ${fmt.n(f.biggestLineage)} organism${f.biggestLineage === 1 ? '' : 's'}`,
        x,
        series: [{ label: 'lineages', color: CHART.blue, data: r.series.lineages }],
      }),
    )
  }

  const note = root.querySelector('#x-note')!
  const save = (name: string, data: unknown): void => {
    download(name, JSON.stringify(data, null, 2))
    note.textContent = `saved ${name}`
  }
  root.querySelector('#x-run')!.addEventListener('click', () =>
    save(`simplecell-run-${result.init.seed}-${r.ticks}t.json`, {
      version: 1,
      init: result.init,
      ticks: r.ticks,
      bucketTicks: r.bucketTicks,
      observations: result.observations,
      final: f,
      peaks: r.peaks,
      x: Array.from(r.x),
      series: Object.fromEntries(Object.entries(r.series).map(([k, v]) => [k, Array.from(v).map((n) => Math.round(n * 1e4) / 1e4)])),
    }),
  )
  root.querySelector('#x-orgs')!.addEventListener('click', () =>
    save(`simplecell-organisms-${result.init.seed}.json`, { version: 1, organisms: result.organisms }),
  )
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-nb]'))) {
    b.addEventListener('click', () => {
      const nb = result.notable[Number(b.dataset.nb)]
      save(`simplecell-${nb.label.replace(/\s+/g, '-')}.json`, nb.organism)
    })
  }
  root.querySelector('#x-again')!.addEventListener('click', () => hooks.again())
  root.querySelector('#x-setup')!.addEventListener('click', () => hooks.setup())
  root.querySelector('#x-lib')!.addEventListener('click', () => hooks.library())
  void fileRun(result).then((r) => {
    note.textContent = r.note + (collection.mode === 'memory' ? ' — but this browser blocks storage, so it will not persist' : '')
  })

  if (result.organisms.length === 0) {
    root.querySelector('#x-orgs')!.setAttribute('disabled', 'true')
    root.querySelector<HTMLElement>('#x-orgs')!.style.color = INK.muted
  }
}
