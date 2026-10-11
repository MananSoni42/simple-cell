import { type Init, initFromSeed } from '../core/params'
import { MATRIX_NAMES } from '../core/types'

const FOOD_BLURB: Record<string, string> = {
  random: 'uniform sprinkle',
  patchy: 'drifting hot-spots',
  gradient: 'one sunlit band',
}

function cellColor(a: number): string {
  const m = Math.abs(a)
  return a >= 0 ? `rgba(255,170,60,${0.08 + 0.7 * m})` : `rgba(80,140,255,${0.08 + 0.7 * m})`
}

/** Read-only start screen. The seed is the only input; everything shown derives from it. */
export function mountStart(root: HTMLElement, onStart: (init: Init) => void): { show(): void; hide(): void } {
  let seed = Math.floor(Math.random() * 1e9)
  let init = initFromSeed(seed)

  root.innerHTML = `
    <div class="card">
      <h1>CELL LIFE</h1>
      <div class="sub">a world is a seed. the chemistry below is frozen.</div>
      <div class="row">
        <label>seed <input id="seed" inputmode="numeric" /></label>
        <button id="roll">re-roll (R)</button>
      </div>
      <table class="m" id="matrix"></table>
      <div class="legend">attraction <span style="color:#ffaa3c">■</span> positive &nbsp; <span style="color:#508cff">■</span> negative &nbsp; (symmetric; Food×Food = 0)</div>
      <dl id="params"></dl>
      <div class="go">press ENTER to enter the world</div>
    </div>`
  const seedEl = root.querySelector<HTMLInputElement>('#seed')!
  const matrixEl = root.querySelector<HTMLTableElement>('#matrix')!
  const paramsEl = root.querySelector<HTMLElement>('#params')!

  function render(): void {
    seedEl.value = String(seed)
    const head = '<tr><th></th>' + MATRIX_NAMES.map((n) => `<th>${n}</th>`).join('') + '</tr>'
    const rows = init.A.map(
      (row, i) =>
        `<tr><th>${MATRIX_NAMES[i]}</th>` +
        row.map((a) => `<td style="background:${cellColor(a)}">${a.toFixed(2)}</td>`).join('') +
        '</tr>',
    ).join('')
    matrixEl.innerHTML = head + rows
    const patchy = init.foodMode === 'patchy' ? ` · ${init.n_patch} patches, r=${init.r_patch}, drift ${init.v_patch}` : ''
    const items: [string, string][] = [
      ['temperature', String(init.T)],
      ['food', `${init.foodMode} (${FOOD_BLURB[init.foodMode]})${patchy}`],
      ['food every', `${init.T_food} ticks`],
      ['organism every', `${init.T_spawn} ticks (brain weights random each time)`],
      ['matter', `${init.n_intrinsic} particles, ${init.n_brain} brains`],
    ]
    paramsEl.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
  }

  function setSeed(s: number): void {
    seed = s
    init = initFromSeed(seed)
    render()
  }

  root.querySelector('#roll')!.addEventListener('click', () => setSeed(Math.floor(Math.random() * 1e9)))
  seedEl.addEventListener('input', () => {
    const n = Number(seedEl.value)
    if (Number.isFinite(n) && seedEl.value.trim() !== '') {
      seed = Math.floor(n)
      init = initFromSeed(seed)
      const keep = seedEl.value
      render()
      seedEl.value = keep
    }
  })
  addEventListener('keydown', (e) => {
    if (root.hidden) return
    if (e.key === 'Enter') onStart(init)
    else if ((e.key === 'r' || e.key === 'R') && e.target !== seedEl) setSeed(Math.floor(Math.random() * 1e9))
  })

  render()
  return {
    show: () => (root.hidden = false),
    hide: () => (root.hidden = true),
  }
}
