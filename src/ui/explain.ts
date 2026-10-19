import { LAWS, QUANTA } from '../core/params'

const C = { p1: '#ff6b81', p2: '#ffc145', p3: '#3ddc97', p4: '#5b8def', brain: '#f4f6fb', food: '#a3e635', dim: '#6b7589', line: '#1b2230' }
const L = LAWS

/**
 * One topic: a diagram, a line that says what it is, and the detail behind it.
 *
 * Tiles rather than a wall of prose, and the split is the point. The page used to be seven sections
 * laid side by side, every one of them fully expanded, which meant the reader met five thousand
 * words about the ladder before learning what a body was. A tile says what a thing *is* in one
 * line; opening it says how it works. Nothing was cut to do this — the bodies below are the same
 * text, behind a summary.
 *
 * Native `<details>`, so opening a tile costs no JavaScript, survives printing, and is reachable
 * from the keyboard without anything being wired up.
 */
interface Topic {
  key: string
  title: string
  /** One line: what this is, not how it works. Shown on the closed tile. */
  blurb: string
  svg?: string
  body: string
}

function topics(): Topic[] {
  return [
    {
      key: 'overall',
      title: 'What this is',
      blurb: `Four kinds of particle, one table of attractions, and nothing else told what to do.`,
      svg: overallSvg(),
      body: `        <p>Four kinds of <b>intrinsic particle</b> and one symmetric table saying which attracts
        which. Food falls from nowhere in particular. Everything beyond that — membranes, bodies
        that heal, organisms that latch together and stay — has to arrive on its own or not at all.</p>
        <p>There is <b>no fitness function and no behaviour written down anywhere</b>. A learner can
        be switched on, and when it is, what it optimises is a choice you made and part of the
        result rather than part of the world. With it off, every new organism gets random weights
        and whatever happens is the world doing it.</p>
        <p>The goal is organisms that learn, evolve, and slowly get <b>smarter</b> — ideally into
        stable multi-organism structures. The hard part is not making something happen; it is
        knowing whether what happened is the thing you wanted. That is what the ladder is for, and
        why most of the work here is in the measuring rather than the mechanism.</p>`,
    },
    {
      key: 'body',
      title: 'Body',
      blurb: `A brain with four sockets, each holding a rigid rod tipped with one particle.`,
      svg: bodySvg(),
      body: `        ${bodySvg()}
        <p>A <b style="color:${C.brain}">brain</b> with four sockets, one per quadrant, each able to
        hold a rigid rod of length ${L.L_rod} tipped with one <b>intrinsic particle</b>
        (<span style="color:${C.p1}">P1</span>, <span style="color:${C.p2}">P2</span>,
        <span style="color:${C.p3}">P3</span>, <span style="color:${C.p4}">P4</span>). Organisms are
        born with 1–4 filled and grow the rest from the soup.</p>
        <p>Rod angles are <b>not decided</b>. Forces on a tip produce a torque, the rod swings and
        clamps at its quadrant edge, so <b>body shape is an equilibrium of the chemistry</b>: limbs
        whose types attract rest together, limbs that repel splay apart. The quadrant gap
        (${L.gap} rad) keeps rods from ever coinciding.</p>
      `,
    },
    {
      key: 'chemistry',
      title: 'Chemistry',
      blurb: `One symmetric table of attractions. Every particle carries its own copy.`,
      svg: matrixSvg(),
      body: `        ${matrixSvg()}
        <p>One symmetric 6×6 matrix over {P1…P4, Food, Brain} is the world's <b>ancestral</b>
        chemistry: 20 numbers in [−1, 1], snapped to ${QUANTA.join(', ')}. Positive attracts.
        Symmetric by law — an asymmetric coupling would have no potential-energy function, and the
        energy ledger would stop meaning anything.</p>
        <p>Ancestral, because each particle carries its <i>own</i> copy of its row, and the coupling
        between a pair is the mean of what each one thinks of the other's kind. Two P1 particles are
        no longer interchangeable. If the chemistry is set to evolve, a bonded particle with energy
        to spare copies itself into a slot that decay has emptied, mutating its affinities as it
        goes — so the matrix is only where the world begins. Only <i>bonded</i> particles can copy,
        which is what selects chemistry for getting itself attached where energy flows rather than
        for being merely sticky.</p>
        <p>Brain has a row too. It used to have none at all — no chemistry, unable to bond, held
        apart from everything by a hardcoded push — which is what made an organism a template held
        together by rods rather than an assembly held together by what it is made of. It still never
        bonds to another brain, which is a rule rather than an accident.</p>
        <p>And each <i>kind</i> of matter has the properties of an element besides: size, mass,
        valence, bond strength, and how fast it runs down. Measured, one of those is the opposite of
        the obvious guess — a <b>heavy</b> type ends up <i>more</i> bonded, not less, because it is
        not dragged out of its bonds by the jostling that breaks everything else's. Slow matter is
        structural matter.</p>
        <p>Every pair also has a universal <b>hard core</b> that diverges at contact, so nothing can
        be squeezed through anything. A brain carries a body radius (${L.r_brain_core}) and is kept
        ${L.r_brain} from other brains, so <b>organisms can only touch through their limbs</b>.</p>
        <p>The Food row acts at <b>half strength</b> (×${L.food_coupling}), which tilts the world
        toward building structure rather than chasing food. A type with a positive Food entry is a
        mouth; a negative one is a wall food cannot cross.</p>
      `,
    },
    {
      key: 'neurons',
      title: 'Neurons',
      blurb: `One linear layer. The only nonlinearity is a tanh at each limb.`,
      svg: neuronSvg(),
      body: `        ${neuronSvg()}
        <p>Two kinds, both <code>tanh(W·x)</code>, with <b>random weights per organism</b> — nothing
        about a brain is designed.</p>
        <p>A <b>limb neuron</b> reads its own reserve, the signal field under it and the food it can
        see, and emits two numbers: a <b>signal</b> deposited outward into the field, and a
        <b>message</b> passed inward along the rod.</p>
        <p>The <b>brain</b> reads all four messages, each socket's type and whether it is filled, the
        food each socket sees, its own reserve and signal, and <b>which way food lies</b> as a
        vector. It outputs how to split energy among the four sockets and a force to move the body.</p>
      `,
    },
    {
      key: 'energy',
      title: 'Energy',
      blurb: `In from the sun as food, out as dissipated work. Nothing else creates it.`,
      svg: energySvg(),
      body: `        <p><b>Every joule that enters this world arrives as food</b>, and every one that leaves is
        work dissipated — upkeep, movement, signalling, and the slow bleed of loose matter. The
        ledger is checked continuously: <code>total + burned === initial + injected</code>.</p>
        <p>That is a recent correction rather than a design note. Until recently a world also
        created a whole four-limbed organism every few dozen ticks and
        endowed every particle of it out of nothing — measured at <b>41% and 67% of all energy
        entering two sample worlds</b>. The books balanced, because the creation was booked as
        injection, which is exactly why it went unnoticed. But energy input was not a function of
        food, inefficient organisms drew an unconditional subsidy proportional to how long the run
        was, and the thrift that every learner here converges on may partly have been an artefact
        of a free drip arriving whatever anybody did.</p>
        <p>So nothing is issued. A loose brain particle <b>eats its way over an activation
        barrier</b> — ${L.E_activate} energy, as a rate rather than a threshold, so temperature
        decides how readily life starts — and then assembles its own body out of whatever drifts
        into the right quadrant at the right radius, paying for each limb it takes on. A body that
        runs dry dissolves, part of what it held becomes food, its particles return to the pool, and
        what they <i>are</i> is drawn again. Matter is conserved; only energy flows.</p>`,
    },
    {
      key: 'invariants',
      title: 'What is always true',
      blurb: `Four things checked continuously, because each one hid a bug when it was not.`,
      svg: invariantSvg(),
      body: `        <p>Each of these is checked as a world runs, and each is here because something broke
        silently before it was.</p>
        <ul>
          <li><b>The energy ledger closes.</b> <code>total + burned === initial + injected</code>,
          to nine decimal places. Energy moves, never appears. This caught a bond-flow path that
          snapshotted only part of the matter range and quietly created energy, and a corpse rule
          that destroyed it.</li>
          <li><b>Matter is conserved.</b> The slot pool is fixed for all time; a particle is never
          made or destroyed, only recycled. Checked as a <i>total</i> rather than kind by kind,
          because a recycled particle has its kind drawn again — the per-kind counts drift while the
          total is exactly fixed.</li>
          <li><b>A rewind is bit-identical.</b> Any state can be snapshotted and restored to the
          same future, exactly. Seven of eight configurations hold; the cross-entropy learner does
          not serialise its in-flight samples and is the one known gap.</li>
          <li><b>Threads and the GPU change nothing.</b> Splitting the force computation across
          cores is bit-identical; the GPU agrees to about one part in ten thousand. Where the forces
          are computed is never allowed to change what the world does.</li>
        </ul>`,
    },
    {
      key: 'lifecycle',
      title: 'Life cycle',
      blurb: `Start from nothing, grow a body, breed or dissolve back into the pool.`,
      svg: lifecycleSvg(),
      body: `        ${lifecycleSvg()}
        <p><b>Spawn:</b> a whole organism appears on a schedule, clear of every other body.
        <b>Capture:</b> an empty socket takes any free particle drifting through its quadrant near
        the rod circle — which is also how a body <b>regrows</b> a lost limb, at no extra cost in
        rules. <b>Starve:</b> a limb at zero reserve unbinds and drifts away.
        <b>Dissolve:</b> a brain at zero reserve releases everything.
        <b>Bud:</b> a brain above ${L.E_repro} pays for a child from its own reserve, copying its
        limbs and inheriting its weights with mutation.</p>
      `,
    },
    {
      key: 'clamp',
      title: 'Why time is clamped',
      blurb: `A long step would carry a particle through another, and exclusion would mean nothing.`,
      svg: clampSvg(),
      body: `        <p>Time is discrete, so a long step would carry a particle straight through another and
        exclusion would mean nothing. Three bounds hold every tick: motion is capped at
        ${L.d_max} (half a particle), a rod swings at most ${L.dth_max} rad, and random kicks are cut
        at ${L.z_max}σ. Hot worlds are additionally <b>sub-stepped</b> — the tick is split so each
        move stays small, with the same total diffusion.</p>
        <p>The start screen shows this budget live. It matters: before it existed, mid-range
        temperatures moved particles further than their own diameter on about half of all ticks,
        brains sat 0.3 units apart, and nothing stayed assembled.</p>
      `,
    },
    {
      key: 'dials',
      title: 'What you can change',
      blurb: `Roughly sixty dials, and the search is allowed to vary almost all of them.`,
      svg: dialsSvg(),
      body: `        <p>Nothing here is a constant that someone decided once. Physics, economics, chemistry,
        reproduction and learning are all <b>dials with ranges</b>, and the search varies them
        rather than being handed a world that works.</p>
        <ul>
          <li><b>Particles</b> — the chemistry table, and per-kind size, mass, valence, bond
          strength, recruitment cost and decay. Four kinds differing in one dimension are barely
          four kinds.</li>
          <li><b>Food</b> — where it lands, how each source moves, what the sources do together,
          how many and how fast, how much and for how long. Source speed is a <i>fraction of how
          fast an organism travels</i>, because absolute units once gave a source that outran
          anything that could chase it.</li>
          <li><b>World</b> — size from 1× to 128×, temperature, metabolism, terrain, how many
          particles and how many brains.</li>
          <li><b>Life</b> — whether reproduction, conjugation and spores are allowed, what birth
          costs, how hard a brain may push, how fast chemistry mutates.</li>
          <li><b>Learning</b> — eight algorithms including none, which is the control, and what
          counts as doing well, which is an invention rather than a measurement.</li>
        </ul>
        <p>The cost of getting this wrong is measured rather than asserted: one dial had four levels
        across a twentyfold range and produced <b>bit-identical worlds</b>, because the code that
        built a world never read it. A pre-registered prediction about that dial was untestable by
        the search meant to test it.</p>`,
    },
    {
      key: 'ladder',
      title: 'The ladder',
      blurb: `Ten rungs in seven tiers, each with a null that a trivial organism already defeated.`,
      body: `        <p>The point of all this is organisms that slowly get <b>smarter</b>, and the hard part is
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
      `,
    },
  ]
}

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

    <div class="ex-tiles">
      ${topics()
        .map(
          (t) => `
        <details class="ex-tile" id="ex-${t.key}">
          <summary>
            ${t.svg ? `<div class="ex-tile-art">${t.svg}</div>` : ''}
            <div class="ex-tile-head">
              <h2>${t.title}</h2>
              <p class="ex-tile-blurb">${t.blurb}</p>
            </div>
          </summary>
          <div class="ex-tile-body">${t.body}</div>
        </details>`,
        )
        .join('')}
    </div>
    <div class="note" style="margin-top:20px">The authoritative version of all of this is
      <code>docs/RULES.md</code>. If this page and the code disagree, the code is wrong.</div>
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

/**
 * Diagrams for the tiles that had none.
 *
 * Every tile is meant to be a picture plus a line, and four of them were a line alone — which read
 * as those topics being less real than the others rather than as them being harder to draw. These
 * are deliberately crude: at thumbnail size a diagram has to carry one idea, and anything more
 * detailed is noise until the tile is opened.
 */
function overallSvg(): string {
  const dots = [C.p1, C.p2, C.p3, C.p4]
    .map((c, i) => `<circle cx="${18 + i * 17}" cy="26" r="5.5" fill="${c}" />`)
    .join('')
  return `<svg viewBox="0 0 150 90" role="img" aria-label="four kinds of particle, a table of attractions, and food falling">
    ${dots}
    <rect x="14" y="42" width="68" height="30" rx="2" fill="none" stroke="${C.line}" />
    ${[0, 1, 2, 3]
      .map((r) =>
        [0, 1, 2, 3]
          .map((cc) => {
            const v = ((r * 7 + cc * 3) % 5) / 4 - 0.5
            const col = v > 0 ? 'rgba(255,170,60,' : 'rgba(80,140,255,'
            return `<rect x="${15 + cc * 17}" y="${43 + r * 7.25}" width="16" height="6.25" fill="${col}${Math.abs(v) * 1.4 + 0.08})" />`
          })
          .join(''),
      )
      .join('')}
    ${[0, 1, 2, 3, 4]
      .map((i) => `<circle cx="${100 + (i % 3) * 15}" cy="${16 + Math.floor(i / 3) * 18 + (i % 2) * 7}" r="2.4" fill="${C.food}" />`)
      .join('')}
    <text x="100" y="80" fill="${C.dim}" font-size="7">food, from nowhere</text>
  </svg>`
}

function invariantSvg(): string {
  return `<svg viewBox="0 0 150 90" role="img" aria-label="energy in equals energy out plus what is held">
    <text x="8" y="22" fill="${C.food}" font-size="9">in</text>
    <text x="8" y="36" fill="${C.dim}" font-size="7">food only</text>
    <path d="M34 19 H58" stroke="${C.food}" stroke-width="1.4" marker-end="url(#exar)" />
    <rect x="60" y="8" width="30" height="28" rx="2" fill="none" stroke="${C.brain}" opacity="0.5" />
    <text x="66" y="26" fill="${C.brain}" font-size="8">held</text>
    <path d="M92 19 H116" stroke="${C.p1}" stroke-width="1.4" marker-end="url(#exar)" />
    <text x="118" y="22" fill="${C.p1}" font-size="9">out</text>
    <text x="8" y="58" fill="${C.dim}" font-size="7.5">total + burned</text>
    <text x="8" y="70" fill="${C.dim}" font-size="7.5">= initial + injected</text>
    <path d="M8 62 H98" stroke="${C.line}" />
    <text x="104" y="70" fill="${C.p3}" font-size="9">✓</text>
    <defs><marker id="exar" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
      <path d="M0 0 L5 2.5 L0 5 z" fill="currentColor" /></marker></defs>
  </svg>`
}

function clampSvg(): string {
  return `<svg viewBox="0 0 150 90" role="img" aria-label="a step capped so a particle cannot pass through another">
    <circle cx="26" cy="34" r="10" fill="none" stroke="${C.p4}" />
    <circle cx="96" cy="34" r="10" fill="none" stroke="${C.p2}" />
    <path d="M36 34 H56" stroke="${C.p3}" stroke-width="2" />
    <text x="38" y="26" fill="${C.p3}" font-size="7">allowed</text>
    <path d="M36 58 H110" stroke="${C.p1}" stroke-width="1" stroke-dasharray="3 3" />
    <text x="38" y="70" fill="${C.p1}" font-size="7">would pass straight through</text>
    <text x="8" y="14" fill="${C.dim}" font-size="7.5">one tick moves at most d_max</text>
  </svg>`
}

function dialsSvg(): string {
  const rows = [0.3, 0.7, 0.5, 0.85, 0.15]
  return `<svg viewBox="0 0 150 90" role="img" aria-label="a column of dials, most of them searchable">
    ${rows
      .map((v, i) => {
        const y = 14 + i * 15
        return `<path d="M14 ${y} H132" stroke="${C.line}" stroke-width="2" />
          <circle cx="${14 + v * 118}" cy="${y}" r="4" fill="${i === 4 ? C.dim : C.p4}" />`
      })
      .join('')}
    <text x="14" y="86" fill="${C.dim}" font-size="7">the search moves these, not a person</text>
  </svg>`
}
