import { type OrganismFile, checkCompatibility, parseOrganism } from '../core/organism'
import type { Init } from '../core/params'
import { bodyDiagram } from './portrait'
import { type StoredOrganism, type StoredRun, collection } from './store'
import { download } from './config'
import { fmt } from './theme'

export interface LibraryHooks {
  /** Run a stored world again, exactly as it was. */
  replay(init: Init): void
  /** Open a stored world in the setup panel, so its dials can be changed before it runs again. */
  edit(init: Init): void
  /** Hand an organism to the world screen's organism tool. */
  arm(o: OrganismFile): void
  back(): void
}

const when = (t: number): string => {
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * The collection. Organisms are cards showing the body as it stood and the weight fingerprint —
 * the portrait earns its keep here, because a wall of faces is browsable where a table of numbers
 * is not. Runs are a list you can reopen or re-run.
 */
export function mountLibrary(root: HTMLElement, hooks: LibraryHooks): { refresh(): Promise<void> } {
  let tab: 'organisms' | 'runs' = 'organisms'
  let sort: 'recent' | 'age' | 'children' | 'joined' = 'recent'
  let query = ''

  root.innerHTML = `
    <div class="summary">
      <div class="setup-head">
        <div>
          <h1>COLLECTION</h1>
          <div class="note" id="lib-note"></div>
        </div>
        <div class="row">
          <button id="lib-back">← back</button>
          <button id="lib-export">export collection</button>
          <button id="lib-import">import…</button>
          <input type="file" id="lib-file" accept="application/json" hidden />
        </div>
      </div>
      <div class="tabs">
        <button data-ltab="organisms">Organisms</button>
        <button data-ltab="runs">Runs</button>
      </div>
      <div class="row" id="lib-controls" style="margin-bottom:16px"></div>
      <div id="lib-body"></div>
      <div class="note" id="lib-io" style="margin-top:14px"></div>
    </div>`

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!
  const body = q('#lib-body')
  const io = q('#lib-io')

  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-ltab]'))) {
    b.addEventListener('click', () => {
      tab = b.dataset.ltab as typeof tab
      void refresh()
    })
  }

  q('#lib-back').addEventListener('click', () => hooks.back())
  q('#lib-export').addEventListener('click', async () => {
    download(`simplecell-collection-${new Date().toISOString().slice(0, 10)}.json`, await collection.exportAll())
    io.textContent = 'collection downloaded — this is the only copy that survives a cleared browser'
  })
  q('#lib-import').addEventListener('click', () => q<HTMLInputElement>('#lib-file').click())
  q<HTMLInputElement>('#lib-file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const r = await collection.importAll(await f.text())
      io.textContent = `merged ${r.runs} run${r.runs === 1 ? '' : 's'} and ${r.organisms} organism${r.organisms === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} unreadable` : ''}`
      await refresh()
    } catch (err) {
      io.textContent = `could not read that: ${(err as Error).message}`
    }
  })

  function organismCard(s: StoredOrganism): string {
    const o = s.organism
    const compat = checkCompatibility(o)
    const f = o.fitness
    const stat = (k: string, v: string): string => `<span class="chip"><i>${k}</i>${v}</span>`
    return `
      <article class="org-card${compat.ok ? '' : ' incompatible'}" data-id="${s.id}">
        ${bodyDiagram(o)}
        <input class="org-name" value="${s.name}" data-id="${s.id}" aria-label="name" />
        <div class="note">${s.label} · ${when(s.savedAt)}${o.from ? ` · ${o.from.foodMode} ${o.from.foodLevel}, seed ${o.from.seed}` : ''}</div>
        <div class="chips-row">
          ${stat('age', fmt.n(o.age) + 't')}
          ${stat('gen', fmt.n(o.generation))}
          ${stat('kids', fmt.n(o.children))}
          ${f ? stat('ate', fmt.n(f.meals)) : ''}
          ${f && f.orderTicks > 0 ? stat('joined', fmt.n(f.orderTicks)) : ''}
        </div>
        ${
          compat.ok
            ? `<div class="row" style="gap:5px"><button data-arm="${s.id}">use in world</button>
               <button data-save="${s.id}">save file</button><button data-del="${s.id}">delete</button></div>`
            : `<div class="warn-box">cannot be used in this build — ${compat.reason}</div>
               <div class="row" style="gap:5px"><button data-save="${s.id}">save file</button><button data-del="${s.id}">delete</button></div>`
        }
      </article>`
  }

  function runRow(r: StoredRun): string {
    const s = r.summary
    const i = r.init
    return `
      <article class="run-row" data-id="${r.id}">
        <div class="run-head">
          <div>
            <b>${i.foodMode} · ${i.foodLevel} · ${i.foodRegime}</b>
            <div class="note">seed ${i.seed} · ${i.size}² · ${fmt.ticks(r.ticks)} · ${when(r.savedAt)}</div>
          </div>
          <div class="row" style="gap:5px">
            <button data-replay="${r.id}">run again</button>
            <button data-edit="${r.id}" title="open this world's settings, change something, and run it from scratch or from a saved tick">edit & re-run</button>
            <button data-delrun="${r.id}">delete</button>
          </div>
        </div>
        <div class="chips-row">
          <span class="chip"><i>peak</i>${fmt.n(s.peakOrganisms)} organisms</span>
          <span class="chip"><i>born</i>${fmt.n(s.births)}</span>
          <span class="chip"><i>bred</i>${fmt.n(s.budded)}</span>
          <span class="chip"><i>oldest</i>${fmt.n(s.recordAge)}t</span>
          <span class="chip"><i>best</i>${s.bestOrder > 1 ? `order ${s.bestOrder} for ${fmt.n(s.bestOrderAge)}t` : '—'}</span>
          <span class="chip"><i>gen</i>${fmt.n(s.maxGen)}</span>
        </div>
        ${r.observations.length ? `<ul class="obs">${r.observations.slice(0, 3).map((o) => `<li>${o}</li>`).join('')}</ul>` : ''}
        <div class="note">${r.organismIds.length} organism${r.organismIds.length === 1 ? '' : 's'} kept from this run</div>
      </article>`
  }

  function score(o: StoredOrganism): number {
    if (sort === 'age') return o.organism.age
    if (sort === 'children') return o.organism.children
    if (sort === 'joined') return o.organism.fitness?.orderTicks ?? 0
    return o.savedAt
  }

  async function refresh(): Promise<void> {
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-ltab]'))) {
      b.classList.toggle('on', b.dataset.ltab === tab)
    }
    const organisms = await collection.organisms()
    const runs = await collection.runs()
    q('#lib-note').textContent =
      `${organisms.length} organism${organisms.length === 1 ? '' : 's'} from ${runs.length} run${runs.length === 1 ? '' : 's'}` +
      (collection.mode === 'memory' ? ' · storage unavailable in this browser, so nothing here will survive a reload' : '')

    const controls = q('#lib-controls')
    controls.innerHTML =
      tab === 'organisms'
        ? `<label class="mono-k">sort <select id="lib-sort">
             <option value="recent">most recent</option>
             <option value="age">longest lived</option>
             <option value="children">most children</option>
             <option value="joined">most time joined</option>
           </select></label>
           <input id="lib-q" placeholder="search by name" style="width:180px" value="${query}" />`
        : ''
    if (tab === 'organisms') {
      const sortEl = q<HTMLSelectElement>('#lib-sort')
      sortEl.value = sort
      sortEl.addEventListener('change', () => {
        sort = sortEl.value as typeof sort
        void refresh()
      })
      const qEl = q<HTMLInputElement>('#lib-q')
      qEl.addEventListener('input', () => {
        query = qEl.value
        void refresh()
      })
    }

    if (tab === 'organisms') {
      const shown = organisms
        .filter((o) => !query || o.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => score(b) - score(a))
      body.innerHTML = shown.length
        ? `<div class="org-grid">${shown.map(organismCard).join('')}</div>`
        : `<div class="empty-hint">nothing kept yet — finish a run and its best three organisms land here,
             or save one from the inspector while a world is running</div>`
    } else {
      body.innerHTML = runs.length
        ? runs.map(runRow).join('')
        : '<div class="empty-hint">no runs yet — press Stop on a world and it is recorded here</div>'
    }

    for (const el of Array.from(body.querySelectorAll<HTMLInputElement>('.org-name'))) {
      el.addEventListener('change', async () => {
        await collection.rename(el.dataset.id!, el.value)
        io.textContent = `renamed to ${el.value}`
      })
    }
    const find = (id: string): StoredOrganism | undefined => organisms.find((o) => o.id === id)
    const on = (attr: string, fn: (id: string) => void | Promise<void>): void => {
      for (const el of Array.from(body.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`))) {
        el.addEventListener('click', () => void fn(el.dataset[attr]!))
      }
    }
    on('arm', (id) => {
      const s = find(id)
      if (!s) return
      try {
        hooks.arm(parseOrganism(JSON.stringify(s.organism)))
        io.textContent = `${s.name} armed — switch to the Organism tool and click in the world`
      } catch (err) {
        io.textContent = `cannot use that one: ${(err as Error).message}`
      }
    })
    on('save', (id) => {
      const s = find(id)
      if (s) download(`${s.name || 'organism'}.json`, JSON.stringify(s.organism, null, 2))
    })
    on('del', async (id) => {
      await collection.deleteOrganism(id)
      await refresh()
    })
    on('edit', (id) => {
      const r = runs.find((x) => x.id === id)
      if (r) hooks.edit(r.init)
    })
    on('replay', (id) => {
      const r = runs.find((x) => x.id === id)
      if (r) hooks.replay(r.init)
    })
    on('delrun', async (id) => {
      await collection.deleteRun(id)
      await refresh()
    })
  }

  void refresh()
  return { refresh }
}
