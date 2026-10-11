# Plan — robustness, metrics, and the next round of rules

Working notes: what we found measuring the current world, what to change, and in what order.
Companion docs: [RULES.md](RULES.md) (the spec), [DESIGN.md](DESIGN.md) (rationale), [BENCH.md](BENCH.md) (performance).

---

## 1. The finding that reorders everything: the world is running outside its stable range

Measured on the current build (seed 3, scale 2, matter slots only, spawn ticks excluded) —
`per-tick displacement` of a single particle against the hard-core radius `r_0 = β·r_c = 4`:

| Temperature | Noise σ | Largest step seen | Steps > `r_0` (4) | Steps > `r_eat` (6) |
|---|---|---|---|---|
| T = 2 (cold end) | 1.41 | 9.5 | 4.3% | 0.3% |
| T = 10 (mid) | 3.16 | 18.3 | **47.6%** | 19.2% |
| T = 40 (hot end) | 6.32 | 34.4 | **82.6%** | 65.2% |

The seed picks `T` from 1–40, so a typical world sits in the middle row. **At that temperature
roughly half of all single-tick moves are longer than the particles are wide.** Consequences,
all of which we have been looking at without naming:

- **Volume exclusion does not work.** A particle can hop clean through another. Measured closest
  brain-to-brain distance: **0.3–0.6 units**, with a rod 16 long — bodies pass through each other
  completely. That is item (5) on your list, and it is not a missing rule, it is this.
- **Food is encountered by luck, not by motion.** At T = 40, 65% of steps are longer than the
  eat radius, so a particle can jump over food. Chemotaxis cannot matter when movement is a
  teleport.
- **Membranes can't hold.** A bond is worth roughly `U ≈ A·(1−β)·r_c/2 ≈ 18` of potential depth;
  the noise is comparable, so nothing stays assembled. This is why we never saw the structures
  the whole project is aiming at.

### Why clamping alone will not fix it

The guardrail you asked for in item (6) is necessary but is a backstop, not a cure. The real
constraint is a budget that ties three laws together:

```
force step:   μ·|F|·dt  ≪  r_0        (currently μ·K_core·dt = 1.5 vs r_0 = 4 — marginal)
noise step:   sqrt(2·μ·T·dt) ≪ r_0    (currently up to 6.3 vs 4 — violated)
structure:    bond depth U ≫ T        (currently comparable — violated)
```

You cannot satisfy all three by turning `T` down alone: cold enough to be stable is also cold
enough to freeze. The three honest ways out:

| Option | Effect | Cost |
|---|---|---|
| **A. Bigger hard core** — `β` 0.1 → 0.25, so `r_0` 4 → 10 | Budget satisfied up to `T ≈ 12`; particles become chunky, which is also more cell-like | Free. Changes the look: things sit further apart |
| **B. Real `dt`** — honour `dt`, set 0.1, sub-step | Exactly correct, keeps the whole temperature range | 10× more ticks per unit of world time |
| **C. Lower `T` range** — 1–40 → 0.5–8 | Free | Narrows the interesting band; risks freezing |
| **D. Displacement clamp** — cap `|Δx|` per tick | Stops the worst teleports | Distorts the high-`T` regime into "max speed in a random direction" |

**Recommendation: A + C together, with D as a guardrail and a visible stability readout.**
That is free at runtime and puts the default world inside its budget. Keep B as an option
(`substeps`) for when we want the hot regime honestly.

Also worth adding: a **stability panel** on the start screen showing `σ/r_0`, `μ·F_max·dt/r_0`
and `T / U_bond`, amber when a budget is breached. Then this class of problem is visible instead
of being inferred from disappointing worlds.

---

## 2. The 4×4 matrix questions

**Q1 — should the food column be half strength?** Yes, and implement it as a *law*, not as a
matrix convention: one scalar `food_coupling = 0.5` multiplying the Food row/column at force
time. The matrix stays uniform in `[-1, 1]`, the bias toward particle-particle structure is one
explicit number, and "a wall that blocks food" still works (just weaker). Tunable 0–1.

**Q2 — quantize the non-food 4×4 to {−1, −0.5, −0.25, 0, 0.25, 0.5, 1}?** Yes, as a default-on
toggle. Be clear about what it buys, though: it does **not** improve numerical stability (the
magnitudes are unchanged; stability is §1's problem). What it buys is real anyway — far fewer
distinct chemistries, so regimes are repeatable and comparable, the matrix editor becomes usable
with clicks instead of typing, and discrete bond strengths feel more molecular. Snap on seed
generation and on manual edit; keep continuous values available behind the toggle.

**Q3 — how to track food better?** You are right that it is too local. Today a limb neuron gets
one scalar, `foodDensity_here` (a count within `r_c = 40`), in a world 300–9600 wide, and the
brain sees food only through whatever the limb neuron chose to encode. Three levels:

1. **Give the brain food directly** (immediate, nearly free): 4 extra inputs, one per socket,
   carrying that socket's food count.
2. **Give it a direction** (immediate, nearly free): the net food-attraction force on the body is
   *already computed* in the force pass. Feed it to the brain as a 2-vector in body frame. That
   turns chemotaxis into a single weight instead of something that has to be inferred from four
   scalars. This is the highest value-per-line change on the whole list.
3. **A food odour field** (medium): a second channel of the existing signal-field machinery.
   Food deposits into it, it diffuses and decays, organisms sample value and gradient. This is
   what actually fixes locality — it gives food a smell that reaches further than `r_c`, with a
   diffusion length we control. Reuses code we already have.

---

## 3. Immediate — mechanical, low risk, do now

| # | Item | Notes |
|---|---|---|
| 1 | **Render the wrap-around** (your 1) | The physics is already a torus; only the *drawing* stops at the edge, so an organism at the seam appears cut in half. Draw the 3×3 tiled copies that intersect the view |
| 2 | **Remove "Largest connected"** (your 2) | Replaced by §4's aggregate metrics. Also saves a union-find pass |
| 3 | **Editable matrix** (your 9) | Click/type per cell, clamped to `[-1, 1]`, mirror `[i][j] → [j][i]`, Food×Food locked at 0, snap to the quantized set when that toggle is on |
| 4 | **`food_coupling = 0.5`** (matrix Q1) | One scalar in the force law |
| 5 | **Quantized 4×4** (matrix Q2) | Default on, toggleable |
| 6 | **Step clamps** (your 6) | Cap per-tick displacement and the rod's angular step; clamp the Gaussian draw at ~3σ. Guardrail, with a counter so we can see how often it bites |
| 7 | **Minimum brain separation** (your 5) | Brains get a body radius: strong exclusion against other brains out to `r_brain ≈ L_rod`, so organisms can only touch through limb particles. Needs §1 to be real |
| 8 | **Lifetime line graph** (your 3) | Rolling average over a trailing 10k ticks, bucketed (100 buckets × 100 ticks), one line for particles and one for organisms |
| 9 | **Children & lineage counters** (your 4, cheap half) | Per-organism children count; founder id inherited by offspring, so we can show lineages alive, largest lineage, max generation |
| 10 | **Export / import config** (your 8) | JSON with a schema version: seed, scale, matrix, every editable field. Plus a URL hash, so a world is a link |

## 4. Medium — clear enough, needs a design pass

| # | Item | Notes |
|---|---|---|
| 11 | **Stability overhaul** (your 7) | §1 option A + C, the stability readout, optional sub-stepping, and tests that assert the budget holds. The one that unlocks membranes |
| 12 | **Aggregate metrics** (your 4, the interesting half) | Organism-level graph: two organisms are linked when any of their limbs touch. Report multi-brain aggregate count, max/mean sub-organisms. For "**always** connected", track **bond age** per organism pair (sampled every ~10 ticks) and define a stable aggregate as one whose edges are older than a threshold — that makes "always" a tunable number instead of a vague word |
| 13 | **Rewind** (your 4/5) | Build one primitive — full world serialization (all arrays, scalars, RNG state, brain weights, patches, lifetime trackers) — then a snapshot ring in the sim worker with a memory budget, a Rewind button and a scrub slider. The same primitive gives us state save/load and long-run checkpoints |
| 14 | **Brain food inputs** (matrix Q3 parts 1–2) | Per-socket food counts plus the body-frame food-force vector |
| 15 | **Explainer tab** (your UI ask) | One page, static SVG: body plan and quadrants, both neuron boxes with every input and output labelled, the energy path (food → limb keeps 10% → brain → redistribute), the signal field, and the lifecycle (spawn → capture → starve → dissolve → bud). Colours matching the renderer |

## 5. Long-term — think before building

| # | Item | The question to settle first |
|---|---|---|
| 16 | **Food odour field** (matrix Q3 part 3) | Changes the ecology, not just the plumbing: with smell, foraging becomes solvable and sitting still stops being viable. Decide whether we want that before adding it |
| 17 | **Full state export/import** | Format and forward compatibility; worth doing once rather than twice |
| 18 | **Brain chemistry row** | Letting brains into the matrix lets bodies bond to bodies — the cheapest route to real multicellularity, and the most likely to change everything |
| 19 | **Learning and selection** | Paused by request. §4's lineage and aggregate metrics are the instruments we will need when it resumes |

---

## 6. Bugs and smells found while reading

Verified by measurement or by reading, not speculation:

1. **Exclusion is defeated by the integrator** (§1). Closest brain-brain 0.3 units, closest
   particle pair 0.5, against `r_0 = 4`. High severity: it undermines membranes, bodies and
   feeding at once.
2. **Overlapping decay mechanisms in continuous-inflow mode.** `world.ts` runs both
   `decayFree()` (loses a fraction of reserve) and `freeMatterDecay()` (pays `c_up` and kills at
   zero) against the same free particles every tick. The ledger stays exact, but free matter is
   charged twice by two rules that were added for the same purpose. Consolidate on `decay_free`
   and let `freeMatterDecay` only handle removal.
3. **A measurement trap worth recording.** Food slots are recycled: a food particle eaten this
   tick can be re-injected at a random position in the same tick, reusing its slot. Any probe
   that diffs positions across a tick will see a "teleport" of hundreds of units. Our first
   stability numbers were wrong for exactly this reason. If we add tracking by identity, slots
   need a generation counter.
4. **`DESIGN.md` promises two invariant tests we never implemented**: "no overlap" (min pair
   distance > 0.5·`r_0`) and the max-displacement bound. Both would have caught §1 immediately.
   Add them with §4's stability work — a failing test is how this should have surfaced.
