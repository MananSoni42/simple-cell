# The plan: a world worth searching

*This supersedes the earlier version of this document, which was written before the adversarial
review and before the food and thermodynamics work was scoped. What carries over is marked; what
was wrong is marked too.*

## The goal, stated so it can be falsified

Organisms that **learn, evolve, and slowly get smarter**, ideally becoming stable multi-organism
structures. Evolving complex intelligence should be *possible within the constraints* — not
inevitable, not designed in. The ladder is the calibrated path, with rungs as real milestones rather
than whatever happened to be measurable.

Two principles govern everything below.

**Make the world expressive enough.** Most failures have not been organisms failing at something;
they have been the world unable to *represent* the thing being asked for. An organism in a food
cloud read zero. A brain had no input carrying its own velocity. Area-restricted search turned out
to need a product of two inputs, which a single linear layer cannot compute. None of that is a
result about life.

**Be open — discover, don't decide.** Every constant is a decision made before the evidence. The
cost of getting this wrong is now measured rather than asserted: `muFood` was a dial with four
levels across a twentyfold range that produced **bit-identical worlds**, because `specInit` never set
`foodMoves`. A pre-registered prediction about it was untestable by the search meant to test it.

## The central problem, named

Every learner and every search in this project has converged on the same strategy: **spend less**.
Thrift beats everything, because the world rewards not acting. Most of what follows is aimed at that
one fact, from three directions:

- **make not-acting insufficient** — moving food, so standing still starves (§2)
- **make acting self-limiting instead of free** — dissipative heating, so thrashing has a physical
  cost rather than an accounting one (§3)
- **measure throughput, not thrift** — a rung that sitting still scores zero on by construction (§3)

## 1. Where things stand

### Done and verified

| | |
|---|---|
| Brain senses: food count, own velocity, limb angles, bond load | 29 → 41 inputs |
| Food has its own mobility; brains have chemistry and can bond to matter | R2.2b, R2.1 |
| Particles are elements: size, mass, valence, bond strength, cost, decay | R2.1c |
| Every particle carries its **own** affinity row; replication mutates it | R2.1b, R7.11 |
| Conjugation and spores; nine physics/economics constants became dials | R7.9, R7.10 |
| Four learners added: MAP-Elites, TD(λ), Hebbian, ES repaired | |
| Ladder rebuilt on **intelligence**: 10 rungs, 7 tiers, every rung with an in-run null | |
| Hand-built brains prove the ladder is climbable — `taxis` reaches level 1 at 8.5× | |
| Adversarial review: determinism, tunnelling, false-finding rate, dead dial, −27…45% CPU | |

### Retracted

**Particle chemistry does not show selection on food affinity.** I reported "+0.140 against the pull
of mutation" and it was an artefact: replication mutated all six row entries onto the matter lattice,
which reaches ±1, while a food entry's ceiling is 0.5. With the cap enforced food *falls* by 0.091,
and the mutation operator alone — no selection — gives −0.10 to −0.18. Indistinguishable.

What survives is **matter** affinity falling 0.173 where the null gives +0.03 to +0.09 — a gap of
about 0.2, and the *opposite* of the obvious prediction, since only a bonded particle can replicate.
Untested reading: selection favours just enough affinity to hold one bond, because a particle buried
in a clump pays `E_bond` repeatedly and sits where food cannot reach it.

### The binding constraint

**Structures do not last.** Order 19 and 41 form readily and travel at 2.2× solo speed when old
enough to measure, but one that is both order 3+ and 500 ticks old is too rare to sustain a rung, and
the best hold is a tenth of a coasting time against a required three. Splitting `Moves together` from
`Holds together` is what made this legible; before, it hid inside a composite threshold.

## 2. Food dynamics: standing still should starve

### Why, beyond incentives

A **static** food source makes the optimal policy a *constant*: find it once, stop. No tracking, no
re-acquisition, nothing to improve at — and a constant policy cannot be selected on. It also explains
three rung exploits that all require food to have a fixed location: "always swim north" (which
defeated the rotation null), `Lingers` being passed by chemotaxis because a gradient turns most
inside a patch, and `Improves` being trippable by drifting into a patch and staying. Moving sources
attack those at the root rather than needing a null each.

### What is actually wrong today

Source speeds were never calibrated against how fast an organism can travel. Measured, same worlds
and seed, net displacement per tick:

| mode | source | organism | ratio |
|---|---|---|---|
| comet | 0.363 | 0.196 | **1.9×** — outruns its pursuer |
| patchy | 0.073 | 0.085 | 0.9× |
| converging | 0.022 | 0.136 | 0.2× |
| spring / ring / gradient | 0.000 | ~0.13 | static |

Note the correction: an earlier claim in these docs that **comet food does not move was wrong** — it
moves, at `max(1.5, v_patch·12)` per tick, which is the real bug. A target that outruns its pursuer
is not a chase.

### The change

**Speed expressed as a fraction of organism speed, not in absolute units.** A `sourceSpeed` dial at
0.2 / 0.5 / 0.8 × the measured solitary-organism speed is catchable by construction and stays
meaningful when metabolism or `F_max` changes. Absolute units silently became uncatchable.

**Five motion patterns, chosen to be contrastive** so the search can answer *what* moving food
selects for rather than only whether it helps:

| mode | motion | selects for |
|---|---|---|
| **comet** (speed fixed) | straight line, constant heading | pure pursuit |
| **orbit** | circles the world, periodic, returns | **anticipation** — the first pattern that could reward memory |
| **wander** | random walk at the same speed as orbit | tracking *without* anticipation |
| **tide** | a band sweeping across and wrapping | positioning rather than chasing — food comes to you |
| **shy** | flees the densest cluster of organisms | anti-camping; adversarial, and most likely to go degenerate |

**`comet` / `orbit` / `wander` at matched speed is the experiment**: identical difficulty, differing
only in predictability, which isolates tracking from anticipating. Anticipation is the one item there
that bears on intelligence rather than reflexes.

**One static mode is kept deliberately.** `spring` stays fixed as the control — otherwise "moving
food improves the rungs" becomes an assumption we can never test. Same discipline as keeping
`thrifty` and `none`.

### Two interactions to watch

A moving source **plus** `muFood` near 1 stacks two forms of elusiveness, and food diffusing as fast
as a limb swims already makes pursuit impossible. And spoilage matters more: a moving source with a
long `food_life` leaves a trail that re-creates a static distribution behind it. Short life makes the
trail a gradient worth following; long makes it a map.

`shy` is held back until the other four are measured.

## 3. Thermodynamics: generalise what is already ad-hoc

The world is **already** a driven dissipative system — energy in from the sun, through structures,
out to `burned` — and the integrator already implements the Einstein relation (`σ = √(2μT)`, so
`D = μT`) with per-type mobility scaling as `√μ`, which is equipartition done correctly. What is
missing is that several hand-written rules are special cases of laws we are not stating.

### T1 — A thermodynamic rung. The one that attacks thrift directly

Schrödinger's framing: a living thing **maintains local order while dissipating energy**. Both halves
are already measurable here — configurational order over a structure's bonds, and energy throughput
per tick, which `burned` already tracks per organism.

A rung reading *"maintains a low-entropy configuration against a dissipative flux"* **cannot be
passed by sitting still**, because sitting still is zero throughput. That is a better answer to the
thrift attractor than any threshold tried so far, and it needs **no new physics** — only a
configurational-entropy measure over bonds, which the order tracker nearly has.

Highest value per unit of effort on this list.

### T2 — The detailed-balance test. Cheap, and validates the foundations

Turn the sun off. An energy-conserving system with no driving must satisfy detailed balance, so pair
separations should follow `exp(−U(r)/T)` for the pair potential we define.

A sharp test: a hidden energy source shows up as the wrong effective temperature. It would have
caught every ledger bug found so far by inspection, and it is the honest way to validate
`potentialEnergy`, which the review found no longer matches the actual force field (it reads the
*ancestral* matrix and a single global core radius, so it is wrong for any world with elements or
templating).

### T3 — Temperature as a field, `T(x, y)`

One field generalises a surprising amount: cold regions are where structures survive, hot regions
tear them apart, so **habitats** appear without a habitat feature, and spatial structure gets a cause
that is not food. It also adds **thermotaxis** — a second navigable gradient with a clear payoff,
which matters because food is currently the only one.

Cost: `stability()` must track the *maximum local* T rather than a scalar. That function was just
fixed for exactly this class of blindness, so the lesson is fresh.

### T4 — Dissipated energy becomes heat

`burned` currently vanishes into a global counter. Thermodynamically, dissipated work *is* heat and
should raise local temperature. One rule generalises three hand-written ones:

- **movement cost becomes self-limiting** — thrash and you cook your own neighbourhood, where today
  it is a flat `c_mv` penalty
- **the clumping cap falls out as physics** — dense clumps dissipate, heat, and their bonds break.
  Today an explicit rule ("only *bonded* particles may replicate") exists purely to stop immortal
  self-attracting clots
- **`burned` stops being a bookkeeping sink** and becomes a quantity with a location

And it adds a feedback loop with no current analogue: activity → heat → bonds break → dispersal →
cooling → re-aggregation. A mechanism for oscillation and patchiness from one rule. Requires T3.

### T5 — Arrhenius bond kinetics

Bonds form on a hard threshold and break on another. The generalisation makes them *rates*:
`P(break) ∝ exp(−depth / T_local)`. The existing `F_form`/`F_break` hysteresis gap stops being two
magic numbers and becomes what it already resembles — an **activation energy** — and per-type
`bondStrength` becomes a well depth.

What it buys: temperature controls structure stability *continuously*, and there is a **critical
temperature** where structures are marginally stable. Since "structures do not last" is the binding
constraint, a knob that tunes persistence through a phase transition is aimed straight at it. Only
interesting once T3 exists.

### Deliberately not doing

**Entropy as a driving law** — maximum entropy production, free-energy minimisation as an organising
principle. In a system this small it degenerates into hand-waving: one can always define an entropy
that the dynamics happens to increase. Entropy as a *measurement* (T1) earns its place; entropy as a
*force* does not.

Stoichiometry and compound formation: over-engineering for now. Active transport along bonds (a
chemical-potential `bond_flow`) is interesting for division of labour but needs a decision mechanism
the brain cannot express — see the hidden-layer question below.

## 4. Metrics still owed

**M1 — the brain cannot multiply.** `Lingers` needs `VEL × FOOD_NEAR`, a product of two inputs, and
the brain is a single linear layer. The best linear attempt reaches 0.86. Either give the brain a
hidden layer, or reformulate the rung. The one nonlinearity that exists is the `tanh` at each limb,
reachable through the socket signals — which is how `followsSignal` works and where a serious attempt
should go.

**M2 — a memory tier needs a recurrent brain.** Identical inputs give identical outputs by
construction, so memory is not representable. `Lingers` is a partial substitute, getting persistence
from the velocity *input* rather than internal state.

**M3 — `Follows signal` leaks to self-signalling.** A brain that shouts a constant into the field and
steers by its own velocity scores 0.57 of the rung, because the field near an organism is partly its
own deposit. Needs the sender's own recent contribution subtracted.

**M4 — `Lineage improves` is confounded with age.** Among contemporaries, generation correlates with
youth at r ≈ −0.5, so any age-dependence of efficiency becomes a generation effect. Needs
residual-on-age or age matching. Its Fisher z is also pseudo-replication: n is co-living clones in one
world sharing one food field, so the effective independent sample is **one world**.

**M5 — `fitness.ts` still ships the defeated statistic.** `seeking` is the mean cosine of command
against the food direction with **no null at all** — the exact measure `ladder.ts` documents as
defeated — and it is selectable as a search objective. A brain reading only its own velocity scores
0.298 on it. Must be nulled or removed before any search optimises it.

**M6 — the percentile score is zero-sum.** Taken against the trailing 128 deaths, so a uniform
improvement of the whole population moves no score at all; the median organism scores 0.5 forever.
A live candidate mechanism for "nothing climbs" coexisting with real progress. Raw means must be read
alongside.

## 5. Known gaps, recorded not fixed

- **CEM and ES do not restore bit-identically.** Their in-flight samples are not serialised, and
  losing them changes which genome is handed out next. The only remaining determinism hole; bounded
  work (~40 lines).
- **The GPU backend is stale and probably dead.** `N_MATRIX` 5 → 6 left a buffer sized for 25 floats
  being written 36, and the shader strides by 5 over a 6-wide matrix. It also ignores per-particle
  rows and per-type radii entirely.
- **A structure survives total membership replacement.** The >50% share rule lets a 3-member group
  swap one member per sample and keep its founding date indefinitely; observed 252 replacements on an
  18-member structure aged 501.
- **The reservoir null's effective size is 16 forever**, so its error is O(1/√16) regardless of life
  length — conservative if independent across organisms, biasing if their early-life gradients are
  correlated, which they are if they spawn near the same patch.
- **Conditional dials are analysed as unconditional.** `eSpore`/`sporeFood` act on 2 of 4 reproMode
  levels, `rowMut` on 1 of 2 — so those factor tables are half filled with worlds where the dial did
  nothing, shrinking any true effect by that factor.
- **`foodRegime` is partly a proxy for the horizon**: `bloom` is 5.5× food at 500 ticks and 0.84× at
  100,000, so the same level means different things per phase.

## 6. Order of work

1. **T1 — the thermodynamic rung**, and **T2 — the detailed-balance test**. No new physics, attacks
   the central failure, validates the foundations before anything is built on them.
2. **M5 and M6** — a defeated statistic that is selectable as a search objective, and a zero-sum
   score that can hide progress. Both can corrupt a search's conclusions rather than merely weaken
   them.
3. **Food dynamics (§2)** — speed relative to organism speed, then comet/orbit/wander/tide, keeping
   `spring` static as the control.
4. **B0 — the parallel sweep runner at thirty seeds**, then re-run `senses`, `learners` and `cap`.
   Every earlier verdict was taken on a metric since shown to be noise above tier 0.
5. **M1–M4** as the measurements argue for them.
6. **v2 pilot at 2% budget** against three gates: every dial level holds n ≥ 30, no rung pinned at 0
   or 1 across all worlds, stratifier cells populated.
7. **Full v2 phase 0**, with learners entering at phase 2 rather than after everything.
8. **T3 → T4 → T5** as a v3 world change, in that order, since each needs the one before.

## 7. Pre-registered predictions

Written before the search so they can be wrong. **P3 is retired** — it concerned `muFood`, which was
a dead dial, so it was never testable.

- **P1** Self-repulsion wins by phase 2. *(carried from v1, still untested — phase 2 was never
  reached with enough worlds.)*
- **P2** `fMax / fBreak` is the strongest single factor on the structural rungs.
- **P4** `reproMut` 0 is clearly worse than any nonzero rate. If it is not, nothing in this model is
  evolving, and that is the most important finding available.
- **P5** Nothing reaches a collective tier without bond angular rigidity.
- **P6** *(new)* A moving food source raises `Taxis` and `Improves` relative to the static control,
  and `orbit` beats `wander` at matched speed — the difference being anticipation.
- **P7** *(new)* The thermodynamic rung is passed by worlds that no existing rung distinguishes,
  because it is the only one thrift cannot satisfy.
