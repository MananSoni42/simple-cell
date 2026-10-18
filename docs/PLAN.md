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

## 3. Immediate — DONE (see commit history)

All ten shipped, plus every bug in section 6 except B1's full resolution (which is the medium
stability item). Measured before and after: per-tick steps now bounded at ~6 regardless of
temperature (was 34), and the closest brain-to-brain distance went from 0.3 to 15.2 against a
mandated 16.

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

## 4. Medium — DONE

All five shipped. Highlights: the hard core now diverges at contact (a bounded one is
out-pullable by enough neighbours — free particles had been reaching 0.01 units apart), seeded
worlds are automatically sub-stepped, and snapshot restore is verified by running the original
and the restored world on for 400 more ticks and comparing hashes.

| # | Item | Notes |
|---|---|---|
| 11 | **Stability overhaul** (your 7) | §1 option A + C, the stability readout, optional sub-stepping, and tests that assert the budget holds. The one that unlocks membranes |
| 12 | **Aggregate metrics** (your 4, the interesting half) | Organism-level graph: two organisms are linked when any of their limbs touch. Report multi-brain aggregate count, max/mean sub-organisms. For "**always** connected", track **bond age** per organism pair (sampled every ~10 ticks) and define a stable aggregate as one whose edges are older than a threshold — that makes "always" a tunable number instead of a vague word |
| 13 | **Rewind** (your 4/5) | Build one primitive — full world serialization (all arrays, scalars, RNG state, brain weights, patches, lifetime trackers) — then a snapshot ring in the sim worker with a memory budget, a Rewind button and a scrub slider. The same primitive gives us state save/load and long-run checkpoints |
| 14 | **Brain food inputs** (matrix Q3 parts 1–2) | Per-socket food counts plus the body-frame food-force vector |
| 15 | **Explainer tab** (your UI ask) | One page, static SVG: body plan and quadrants, both neuron boxes with every input and output labelled, the energy path (food → limb keeps 10% → brain → redistribute), the signal field, and the lifecycle (spawn → capture → starve → dissolve → bud). Colours matching the renderer |

## 5. Long-term — mostly done now

Of the original four, three were superseded by the bond work and the metric round; learning is now
built and measured, and the food odour field remains.

| # | Item | The question to settle first |
|---|---|---|
| 16 | **Food odour field** (matrix Q3 part 3) | Changes the ecology, not just the plumbing: with smell, foraging becomes solvable and sitting still stops being viable. Decide whether we want that before adding it |
| 17 | **Full state export/import** | Format and forward compatibility; worth doing once rather than twice |
| 18 | ~~**Brain chemistry row**~~ | **Superseded.** Particle bonds with hysteresis (R16) turned out to be the better route to multicellularity: bodies now join through their limbs, which is both more physical and more controllable than letting brains attract each other |
| 19 | ~~**Learning and selection**~~ | **Done, through step 4 of the plan.** `core/learning.ts` is the seam; `none` is the control and keeps the world bit-identical; four algorithms share one interface; `npm run experiment` runs the paired protocol. Measured over 12 paired seeds: CEM lifts offspring 0.28 → 0.45 and net energy 9.7 → 33.7, winning 11/12 seeds on both, with lifespan and compound order rising alongside. GA shows nothing, ES is marginal. See LEARNING.md §0 |

---

## 6. Bugs found

From measurement plus a full read of `src/core`, `src/compute`, `src/sim`, `src/render`, `src/ui`
against RULES.md, fuzzed across pool/inflow, food modes, `foodMoves`, repro on/off,
`decay_free` 0–10%, T 1–40, scale 1–2 and extreme densities.

### Verified clean (worth knowing, so we stop re-checking)

Energy ledger closes to ≤2e-7 over 4000-tick runs in every configuration — every transfer path
is balanced. Index conventions never confuse particle index, packed grid slot, brain or socket
(including the different `limbs` layouts in `world.ts` and `frames.ts`). Toroidal distance agrees
across all four implementations, including the exact `d = ±S/2` tie. R2.3's who-feels-whom is
exact. No stale `limbs` entries, orphan limbs, `owner`/`socket` mismatches, rod-length or
out-of-quadrant violations in any run. No reachable NaN or Infinity; energy never goes negative.
The triple-buffer frame handshake is race-free. Thread slicing covers the packed range exactly.

### Needs fixing

| # | What | Where | Severity |
|---|---|---|---|
| B1 | **Exclusion is defeated by the integrator** (§1). Nothing bounds the summed force: measured `μ·\|F\|` up to 5.6 on a free particle and **6.3 on a whole rigid body** at stock seed parameters, against `r_0 = 4`, so bodies jump more than a core diameter per tick. Two amplifiers §9 of RULES misses: a rod cannot yield radially, so a tip accumulates overlap a free particle would have relieved; and `integrate()` sums the brain's hard core + `F_move` + up to four limb radial loads into one unclamped step. At densities the start screen already allows, `μ·\|F\|` reaches 52 | `world.ts:377-403` | **high** |
| B2 | **Brain food split is renormalized over filled sockets only**, so the whole released amount is always pushed out. Spec R5.2 softmaxes over all four outputs, and R4.5 lets only the `E_ref` cap return a share. With one limb and `y = [5,5,-5,5]` the spec gives it 0.005% of the release; the code gives it 100%. Since R5.2 deliberately feeds `alive_i` to the brain, "allocate to an empty socket to hoard" is a strategy the spec offers and the code removes. Affects every organism every tick, and most bodies are incomplete | `world.ts:510-525` | **medium** |
| B3 | **Limb screen positions are never wrapped.** The renderer recomputes tips from the brain to keep rods rigid but omits the modulo, so a brain at `x = 297` of 300 draws its rod off the right edge and nothing at the left. Same for the footprint disc. `World.placeLimbs` does wrap — only the renderer does not. This is your item (1) | `renderer.ts:136-137,169` | medium-low |
| B4 | **Interpolation glides across slot reuse**, so food visibly flies across the world while `foodMoves` is off. The guard only checks that the slot was alive before and after, but `freeFood` is LIFO, so an eaten slot is usually refilled within a few ticks at a fresh random position, and the half-world guard passes reuse distances up to 150 units. Needs a slot identity or generation check. *Same root cause as the measurement trap below* | `renderer.ts:118-124` | low-medium |
| B5 | **Same-tick death and rebirth is invisible to the lifetime bookkeeping.** The liveness diff runs after `injectFood`/`spawnRandom`, so if a slot empties early in a tick and is re-endowed later in the same tick, the completed lifespan is never recorded and `since[i]` is never reset — the new particle inherits the previous occupant's entire age. Also `spawnRandom`'s pool test never checks `energy > 0`, so a particle that just ran dry is immediately eligible. Measured 1 occurrence per 4000 ticks in pool mode, 15 under inflow. Hits the stats added in the last commit | `world.ts:356-368` | low-medium |
| B6 | **Signal cost uses `max(0, sig)` where R4.4 says `\|sig\|`**, so strongly negative limb signals ride free on the signal budget | `world.ts:545` | low |
| B7 | **Capture accepts particles inside the inter-quadrant gap.** The test uses the raw quadrant, ignoring `gap`, so a particle in the gap is accepted and then clamped to the limit — the rod is born resting on its boundary instead of at the angle the particle had (R7.3) | `world.ts:636` | low |
| B8 | **`bud()` ignores limb cooldown under continuous inflow.** `kill()` does not clear `cool`, and the inflow path tests only `!alive[i]`, so a limb that starved can become a child's limb next tick — while `spawnRandom` would still refuse it | `world.ts:781` vs `829` | low |
| B9 | **A newly captured limb deposits a stale signal, for free.** `sig[]` is never cleared on unbind and `captures()` runs after `costs()` but before `stepField()`, so a fresh limb deposits the value left from its previous life having paid no `c_sig`, before `think()` has run for the new body. Measured 11 occurrences in 3000 ticks | `world.ts:354,654-659` | low |

### Doc fixes (code is right, the spec is wrong)

- RULES.md pipeline step 5 says food is consumed within `r_0`; R4.2 and the Laws table say `r_eat` (6). The code uses `r_eat`.
- RULES.md §10 says the tick rate ranges to 512/s; `main.ts` allows 65536.
- `metrics.ts:29` claims mass "must never change", which is false under `inflow` by design (R7.6).
- `DESIGN.md` promises two invariant tests we never wrote — "no overlap" (min pair distance > 0.5·`r_0`) and a max-displacement bound. **Either one would have caught B1 immediately**, which is the real lesson: the stability budget needs to be a test, not a comment.

### Consolidation, not a bug

In continuous-inflow mode `decayFree()` (loses a fraction of reserve) and `freeMatterDecay()`
(pays `c_up`, kills at zero) both charge the same free particles every tick. The ledger stays
exact, but two rules added for the same purpose now overlap. Consolidate on `decay_free`, leaving
`freeMatterDecay` to handle only removal.

### A measurement trap worth recording

Food slots are recycled, so a particle eaten this tick can be re-injected at a random position in
the same tick reusing its slot. Any probe that diffs positions across a tick sees a "teleport" of
hundreds of units — our first stability numbers were wrong for exactly this reason, and B4 is the
same root cause showing up on screen. If we ever track particles by identity, slots need a
generation counter.

## Structural misses not taken

From the review in [structural_misses.md](structural_misses.md). These are not bugs — the code
does what the rules say. They are things the rules cannot express, which is why each one makes
some rung of the ladder unreachable rather than merely hard. Numbering is that document's.

| # | Miss | Why it might matter | Cost |
|---|---|---|---|
| 4 | **No anabolism.** Energy can never become matter, so every body is assembled from pre-existing free particles and the matter budget is a hard population ceiling. | This is the real reason reproduction cannot be boundless. An organism that could build a limb from its reserve would make growth a decision rather than a lottery over what happens to be drifting nearby. | large — breaks matter conservation, which is a law with tests |
| 6 | **Nothing ages.** Death is starvation only. | With no senescence there is no pressure to reproduce *early*, so a thrifty immortal is a perfect strategy and the search keeps finding it. Previously rejected on the grounds that particles should loosely represent chemicals, which still holds for bond aging; organism senescence is a separate question. | small, but it changes the economics of every world |
| 7 | **Bonds have no angular rigidity.** A bond is a distance spring, so a bonded chain has no preferred shape. | "Compound organisms that hold a form" may be unreachable without it: a structure can currently only be a clump or a floppy chain, and the `Holds` rungs ask for something a distance spring cannot represent. | medium — a second force term, and a stability budget to re-derive |
| 8 | **Comet food does not move.** The pattern whose name implies motion places static food. | A moving food source is the cleanest possible test of pursuit, and the one food pattern that should provide it does not. Cheap to fix and now worth more, since food is heavy enough to be chased. | small |
| 10 | **Signalling has no addressing.** The field is a scalar everyone reads and writes. | "Transmits joining" and any form of division of labour need a message with a recipient. The brain now at least knows it *has* bonds (R5.5), which is the precondition; passing anything along them is not yet possible. | medium |

The four that were taken are #1, #2, #3 and #5/#9; see that document for what each cost and what
it bought.

## Known determinism gap

**A world running CEM (or ES) is not bit-identical after a snapshot restore.** The distribution
learners' in-flight samples — `pending` and `batch` in `learning.ts` — are not serialised, and
losing them changes which genome the learner hands out next, which changes the world. Measured
directly: seven of eight configurations restore bit-identically (plain, TD(λ), Hebbian, TD with
Darwinian inheritance, templating, spores, conjugation); CEM diverges.

The code used to assert this "costs one partial update rather than correctness", which was wrong.
Both arrays are bounded (`capPending = max(8, batch·4)`), so serialising them is a bounded job —
roughly forty lines — and worth doing before any run that relies on rewind plus a distribution
learner together.
