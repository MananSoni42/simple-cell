import { LAWS, QUANTA } from '../core/params'

const C = { p1: '#ff6b81', p2: '#ffc145', p3: '#3ddc97', p4: '#5b8def', brain: '#f4f6fb', food: '#a3e635', dim: '#6b7589', line: '#1b2230' }
const L = LAWS

/** One page explaining what an organism is and every mechanism that acts on it. */
export function explainHTML(): string {
  return `
  <div class="explain">
    <div class="setup-head">
      <div>
        <h1>WHAT AN ORGANISM IS</h1>
        <div class="note">everything below follows from the rules — nothing here is special-cased</div>
      </div>
      <button id="ex-back">← back</button>
    </div>

    <div class="ex-grid">
      <section>
        <h2>Body</h2>
        ${bodySvg()}
        <p>A <b style="color:${C.brain}">brain</b> with four sockets, one per quadrant, each able to
        hold a rigid rod of length ${L.L_rod} tipped with one <b>intrinsic particle</b>
        (<span style="color:${C.p1}">P1</span>, <span style="color:${C.p2}">P2</span>,
        <span style="color:${C.p3}">P3</span>, <span style="color:${C.p4}">P4</span>). Organisms are
        born with 1–4 filled and grow the rest from the soup.</p>
        <p>Rod angles are <b>not decided</b>. Forces on a tip produce a torque, the rod swings and
        clamps at its quadrant edge, so <b>body shape is an equilibrium of the chemistry</b>: limbs
        whose types attract rest together, limbs that repel splay apart. The quadrant gap
        (${L.gap} rad) keeps rods from ever coinciding.</p>
      </section>

      <section>
        <h2>Chemistry</h2>
        ${matrixSvg()}
        <p>One symmetric 5×5 matrix over {P1…P4, Food} is the world's entire chemistry: 15 numbers
        in [−1, 1], snapped to ${QUANTA.join(', ')}. Positive attracts.</p>
        <p>Every pair also has a universal <b>hard core</b> that diverges at contact, so nothing can
        be squeezed through anything. A brain carries a body radius (${L.r_brain_core}) and is kept
        ${L.r_brain} from other brains, so <b>organisms can only touch through their limbs</b>.</p>
        <p>The Food row acts at <b>half strength</b> (×${L.food_coupling}), which tilts the world
        toward building structure rather than chasing food. A type with a positive Food entry is a
        mouth; a negative one is a wall food cannot cross.</p>
      </section>

      <section>
        <h2>Neurons</h2>
        ${neuronSvg()}
        <p>Two kinds, both <code>tanh(W·x)</code>, with <b>random weights per organism</b> — nothing
        about a brain is designed.</p>
        <p>A <b>limb neuron</b> reads its own reserve, the signal field under it and the food it can
        see, and emits two numbers: a <b>signal</b> deposited outward into the field, and a
        <b>message</b> passed inward along the rod.</p>
        <p>The <b>brain</b> reads all four messages, each socket's type and whether it is filled, the
        food each socket sees, its own reserve and signal, and <b>which way food lies</b> as a
        vector. It outputs how to split energy among the four sockets and a force to move the body.</p>
      </section>

      <section>
        <h2>Energy</h2>
        ${energySvg()}
        <p>Food carries ${L.E_food}. A limb that touches it keeps ${L.k_keep * 100}% and passes the
        rest <b>inward</b> — one hop per tick, never teleported. The brain holds the reserve and
        sends a fraction (${L.releaseFrac}) back out each tick, split by its own output.</p>
        <p>Everything costs: upkeep every tick, movement, and signalling. Free particles decay too.
        Spent energy leaves the world as heat, and the ledger is checked every tick:
        <code>reserves + burned = initial + injected</code>.</p>
      </section>

      <section>
        <h2>Life cycle</h2>
        ${lifecycleSvg()}
        <p><b>Spawn:</b> a whole organism appears on a schedule, clear of every other body.
        <b>Capture:</b> an empty socket takes any free particle drifting through its quadrant near
        the rod circle — which is also how a body <b>regrows</b> a lost limb, at no extra cost in
        rules. <b>Starve:</b> a limb at zero reserve unbinds and drifts away.
        <b>Dissolve:</b> a brain at zero reserve releases everything.
        <b>Bud:</b> a brain above ${L.E_repro} pays for a child from its own reserve, copying its
        limbs and inheriting its weights with mutation.</p>
      </section>

      <section>
        <h2>Why time is clamped</h2>
        <p>Time is discrete, so a long step would carry a particle straight through another and
        exclusion would mean nothing. Three bounds hold every tick: motion is capped at
        ${L.d_max} (half a particle), a rod swings at most ${L.dth_max} rad, and random kicks are cut
        at ${L.z_max}σ. Hot worlds are additionally <b>sub-stepped</b> — the tick is split so each
        move stays small, with the same total diffusion.</p>
        <p>The start screen shows this budget live. It matters: before it existed, mid-range
        temperatures moved particles further than their own diameter on about half of all ticks,
        brains sat 0.3 units apart, and nothing stayed assembled.</p>
      </section>

      <section>
        <h2>The ladder</h2>
        <p>The point of all this is organisms that slowly get <b>smarter</b>, and the hard part is
        knowing whether that is happening. So progress is tracked as nine milestones in
        <b>seven tiers of intelligence</b>, shown live in the world's left rail.</p>
        <p>The ladder used to measure levels of biological <i>organisation</i> — matter, metabolism,
        heredity, association, collective structure — and that was the wrong axis. A bacterial mat
        has heredity, association and collective structure, and knows nothing. Measured, a
        <b>blind</b> world whose organisms had random weights and no learner at all met <b>nine of
        the thirteen</b> rungs of that ladder, including <i>"a held structure travelling three times
        what drift gives"</i>. It was describing the world rather than the organisms in it.</p>
        <p>Every rung now asks one question in increasingly demanding forms: <b>does behaviour
        exploit a particular kind of information, in a way that a null destroying exactly that
        information does not reproduce?</b></p>
        <ol class="ladder-doc">
          <li><b>Viable</b> — not intelligence, but the precondition for showing any of it.
            <i>Persists</i>: anything alive, and staying that way. <i>Feeds</i>: the typical life
            ate more than it was given. <i>Lasts</i>: long lives, both in ticks and against what
            coasting on the birth endowment alone would allow.</li>
          <li><b>Reactive</b> — acts on what it senses now. <i>Taxis</i>: steers toward food,
            beyond the same gradients shuffled in time.</li>
          <li><b>Discriminative</b> — behaves differently in different situations.
            <i>Lingers</i>: turns more where food is dense and presses on where it is not —
            area-restricted search, the oldest foraging trick there is.</li>
          <li><b>Adaptive</b> — gets better inside one lifetime. <i>Improves</i>: converts
            encounters into meals better late in life than early.</li>
          <li><b>Cumulative</b> — later lives are better than earlier ones. <i>Lineage
            improves</i>: among organisms alive <i>at the same moment</i>, the later generations
            forage better.</li>
          <li><b>Social</b> — uses information that came from another organism. <i>Follows
            signal</i>: steers by the signal field, beyond what the food gradient already said.</li>
          <li><b>Collective</b> — the structure, not the organism, is the thing acting.
            <i>Moves together</i>: a held structure of three or more covering ground faster than a
            solitary organism manages.</li>
        </ol>
        <p>Three rules keep the rungs honest, and <b>each one comes from a trivial organism that
        defeated an earlier version</b>:</p>
        <ul>
          <li><b>Commanded motion, never realised motion.</b> A crowded food patch physically
          jostles whatever is inside it, and a well-fed organism can afford to move more. Both show
          up as "behaviour correlated with food" in realised movement. A brain's <i>command</i>
          cannot be jostled and does not depend on what it can afford.</li>
          <li><b>Time-shuffled conditioners, never rotation.</b> Rotating the food direction by 90°
          looks like a perfect null — same magnitudes, no information — and it is beaten by "always
          swim north" in a world whose food is to the north. That organism uses no information at
          all. Pairing this tick's command with a gradient the same organism saw at a random
          <i>earlier</i> time gives it nothing, because its performance never depended on the
          pairing.</li>
          <li><b>Efficiency, never throughput.</b> An organism that merely <i>grows</i> gains limbs,
          so it harvests more with nothing learned; one that drifts into a patch harvests more
          because of where it is. Both buy more <i>encounters</i>. Only skill improves the
          <i>conversion</i> of encounters into meals.</li>
        </ul>
        <p>Getting that null right cuts both ways. A first version drew its shuffle from only the
        last sixteen ticks — and every conditioner here is autocorrelated over much longer, so the
        "shuffled" gradient was nearly the same gradient, the null scored almost as well as the
        real thing, and a synthetic organism following the gradient <i>perfectly</i> scored 0.155
        where it should have scored near 1. A null that fails to destroy the information it is
        meant to destroy does not make a rung lenient — it makes it unreachable.</p>
        <p>Every claim needs <b>both significance and an effect size</b>. The first seeking rung
        reported <i>z = 133</i> for an alignment of about 0.3: pooled over hundreds of lives, any
        consistent bias clears a z-test, which establishes that an effect is not exactly zero and
        says nothing about whether it is worth having.</p>
        <p>Each statistic is <b>windowed</b> over the recent dead or the recent samples, so a rung
        describes a sustained condition rather than one lucky tick, and each has <b>hysteresis</b> —
        on at the threshold, off only well below it — so the readout does not flicker while a number
        sits on the line. Unmet rungs show how close they are, because "nearly" and "nowhere near"
        are different facts.</p>
      </section>
    </div>
    <div class="go" id="ex-back-2">← back (Esc)</div>
  </div>`
}

function bodySvg(): string {
  const cx = 150
  const cy = 110
  const r = 72
  const tips: [number, string][] = [[0.6, C.p1], [2.1, C.p2], [3.5, C.p3], [5.3, C.p4]]
  const rods = tips
    .map(([a, col]) => {
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>
              <circle cx="${x}" cy="${y}" r="7" fill="${col}"/>`
    })
    .join('')
  const spokes = [0, 1, 2, 3]
    .map((q) => {
      const a = (q * Math.PI) / 2
      return `<line x1="${cx}" y1="${cy}" x2="${cx + (r + 14) * Math.cos(a)}" y2="${cy + (r + 14) * Math.sin(a)}" stroke="${C.line}" stroke-width="7"/>`
    })
    .join('')
  const labels = [0, 1, 2, 3]
    .map((q) => {
      const a = (q + 0.5) * (Math.PI / 2)
      return `<text x="${cx + 44 * Math.cos(a)}" y="${cy + 44 * Math.sin(a) + 4}" fill="${C.dim}" font-size="10" text-anchor="middle">q${q}</text>`
    })
    .join('')
  return `<svg viewBox="-10 0 320 232" class="ex-svg">
    <circle cx="${cx}" cy="${cy}" r="${r + 8}" fill="rgba(244,246,251,0.04)" stroke="rgba(244,246,251,0.14)"/>
    ${spokes}${labels}${rods}
    <rect x="${cx - 9}" y="${cy - 9}" width="18" height="18" fill="${C.brain}"/>
    <text x="${cx}" y="${cy + 104}" fill="${C.dim}" font-size="9" text-anchor="middle">rod ${L.L_rod} long · free within its quadrant · clamps at the gap</text>
  </svg>`
}

function matrixSvg(): string {
  const names = ['P1', 'P2', 'P3', 'P4', 'Food']
  const demo = [
    [0.5, -1, 0.25, 0, 0.5],
    [-1, 0.25, 0.5, -0.5, -1],
    [0.25, 0.5, -0.25, 1, 0.25],
    [0, -0.5, 1, 0.5, -0.5],
    [0.5, -1, 0.25, -0.5, 0],
  ]
  const cell = 32
  let out = ''
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const v = demo[i][j]
      const col = v >= 0 ? `rgba(255,170,60,${0.1 + 0.7 * Math.abs(v)})` : `rgba(80,140,255,${0.1 + 0.7 * Math.abs(v)})`
      const faded = i === 4 || j === 4 ? ' opacity="0.65"' : ''
      out += `<rect x="${40 + j * cell}" y="${22 + i * cell}" width="${cell - 3}" height="${cell - 3}" rx="3" fill="${col}"${faded}/>`
    }
    out += `<text x="34" y="${22 + i * cell + 19}" fill="${C.dim}" font-size="10" text-anchor="end">${names[i]}</text>`
    out += `<text x="${40 + i * cell + 14}" y="16" fill="${C.dim}" font-size="10" text-anchor="middle">${names[i]}</text>`
  }
  return `<svg viewBox="0 0 310 200" class="ex-svg">${out}
    <text x="152" y="192" fill="${C.dim}" font-size="9" text-anchor="middle">symmetric · Food×Food = 0 · Food row at half strength</text>
  </svg>`
}

function neuronSvg(): string {
  const box = (x: number, y: number, w: number, h: number, label: string, col: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="none" stroke="${col}"/>
     <text x="${x + w / 2}" y="${y + h / 2 + 4}" fill="${col}" font-size="11" text-anchor="middle">${label}</text>`
  const inp = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" fill="${C.dim}" font-size="9.5" text-anchor="end">${t}</text>`
  const arrow = (x1: number, y1: number, x2: number, y2: number, col = C.dim) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1.2" marker-end="url(#ar)"/>`
  return `<svg viewBox="0 0 370 230" class="ex-svg">
    <defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="${C.dim}"/></marker></defs>
    ${inp(92, 28, 'own reserve')}${inp(92, 42, 'signal field here')}${inp(92, 56, 'food in sight')}
    ${arrow(96, 24, 128, 40)}${arrow(96, 38, 128, 44)}${arrow(96, 52, 128, 50)}
    ${box(130, 28, 86, 36, 'limb neuron', C.p3)}
    ${arrow(218, 36, 258, 24)}<text x="262" y="27" fill="${C.p3}" font-size="9.5">signal out</text>
    ${arrow(218, 56, 258, 68)}<text x="262" y="71" fill="${C.p3}" font-size="9.5">message in</text>
    ${inp(92, 118, '4 × message')}${inp(92, 132, '4 × type + filled')}${inp(92, 146, '4 × food seen')}
    ${inp(92, 160, 'reserve, signal')}${inp(92, 174, 'food direction →')}
    ${arrow(96, 114, 128, 136)}${arrow(96, 128, 128, 140)}${arrow(96, 142, 128, 146)}${arrow(96, 156, 128, 152)}${arrow(96, 170, 128, 158)}
    ${box(130, 118, 86, 50, 'brain', C.brain)}
    ${arrow(218, 132, 258, 120)}<text x="262" y="123" fill="${C.brain}" font-size="9.5">energy split ×4</text>
    ${arrow(218, 154, 258, 166)}<text x="262" y="169" fill="${C.brain}" font-size="9.5">move force</text>
    <text x="185" y="214" fill="${C.dim}" font-size="10" text-anchor="middle">weights are random per organism</text>
  </svg>`
}

function energySvg(): string {
  return `<svg viewBox="-30 0 370 158" class="ex-svg">
    <defs><marker id="ar2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="${C.food}"/></marker></defs>
    <path d="M18,42 l7,-7 l7,7 l-7,7 z" fill="${C.food}"/>
    <text x="40" y="46" fill="${C.food}" font-size="10">food ${L.E_food}</text>
    <line x1="86" y1="42" x2="120" y2="42" stroke="${C.food}" stroke-width="1.2" marker-end="url(#ar2)"/>
    <circle cx="136" cy="42" r="9" fill="${C.p3}"/>
    <text x="136" y="70" fill="${C.dim}" font-size="9.5" text-anchor="middle">limb keeps ${L.k_keep * 100}%</text>
    <line x1="150" y1="42" x2="186" y2="42" stroke="${C.food}" stroke-width="1.2" marker-end="url(#ar2)"/>
    <rect x="193" y="33" width="18" height="18" fill="${C.brain}"/>
    <text x="202" y="70" fill="${C.dim}" font-size="9.5" text-anchor="middle">brain pools the rest</text>
    <path d="M211,51 q34,26 -61,26" fill="none" stroke="${C.brain}" stroke-width="1.2" stroke-dasharray="3 3"/>
    <text x="150" y="98" fill="${C.dim}" font-size="9.5" text-anchor="middle">…and sends ${L.releaseFrac * 100}% back out, split by its own output</text>
    <text x="150" y="126" fill="${C.dim}" font-size="9" text-anchor="middle">upkeep ${L.c_up}/tick · movement · signalling · free decay → burned</text>
    <text x="150" y="144" fill="${C.dim}" font-size="9" text-anchor="middle">reserves + burned = initial + injected, every tick</text>
  </svg>`
}

function lifecycleSvg(): string {
  const node = (x: number, y: number, t: string, col: string) =>
    `<rect x="${x}" y="${y}" width="74" height="26" rx="13" fill="none" stroke="${col}"/>
     <text x="${x + 37}" y="${y + 17}" fill="${col}" font-size="10" text-anchor="middle">${t}</text>`
  const link = (x1: number, y1: number, x2: number, y2: number, t: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.dim}" stroke-width="1.2" marker-end="url(#ar3)"/>
     <text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" fill="${C.dim}" font-size="9" text-anchor="middle">${t}</text>`
  return `<svg viewBox="0 0 360 170" class="ex-svg">
    <defs><marker id="ar3" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="${C.dim}"/></marker></defs>
    ${node(14, 16, 'free soup', C.p4)}
    ${node(113, 16, 'organism', C.brain)}
    ${node(212, 16, 'child', C.p2)}
    ${node(113, 120, 'dissolved', C.dim)}
    ${link(88, 29, 111, 29, 'spawn / capture')}
    ${link(187, 29, 210, 29, 'bud')}
    ${link(150, 42, 150, 118, 'starve')}
    <path d="M113,133 q-70,10 -62,-88" fill="none" stroke="${C.dim}" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#ar3)"/>
    <text x="40" y="150" fill="${C.dim}" font-size="9">matter returns</text>
    <text x="212" y="150" fill="${C.dim}" font-size="9">regrowth = capture, again</text>
  </svg>`
}
