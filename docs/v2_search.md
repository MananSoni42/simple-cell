# The v2 search

*Written after the energy model changed. Every number in `v1_phased_search.md` predates that change
and describes a world that no longer exists — see "What was discarded".*

**Goal:** find worlds that climb the ladder, and save them so progress can be watched rather than
read off a table.

---

## 1. Three measurements that determine the design

Everything below follows from these rather than from preference.

### 1.1 Searching worlds is well-posed. Searching genomes is not

| | noise |
|---|---|
| per-life fitness, `offspring` | **CV 4.22** — ~28,000 lives per genome to detect a 10% effect |
| per-life fitness, `per_tick` | CV 1.07 — ~1,800 lives per genome |
| **world ladder score @ 500t** | signal/noise **2.38** |
| **world ladder score @ 6000t** | signal/noise **5.59** |

A world's score aggregates thousands of lives, so per-life noise averages out. The budget is ~1,800
lives *in total*, shared across every genome — so genome-level selection is four orders of magnitude
short, while world-level selection has a comfortable margin.

### 1.2 A 500-tick score separates dead from alive, and nothing more

Spearman(500t, 6000t) = **0.87** over ten worlds — but **0.16 among the six live ones**. The 0.87 was
entirely the four dead worlds correctly staying dead. One world went 1.69 → 1.05 while another went
0.60 → 3.28.

**Therefore phase 0 is a viability gate, not a ranker.** v1 kept "the best 60,000 of 200,000" by
phase-0 score; that is selection on noise, and it is the identical error that makes the learners
harmful (§1.3).

### 1.3 Every learner is worse than no learner

Paired against `none` on the same six seeds, 6,000 ticks:

| learner | Δ score | t | won |
|---|---|---|---|
| random | +0.000 ± 0.000 | — | 0/6 |
| cem | −0.256 ± 0.185 | −1.4 | 1/6 |
| es | −0.368 ± 0.213 | −1.7 | 1/6 |
| **elites** | **−0.451 ± 0.148** | **−3.1** | 0/6 |
| **ga** | **−0.576 ± 0.250** | **−2.3** | 0/6 |
| td | −1.080 ± 0.637 | −1.7 | 1/6 |
| hebb | −1.091 ± 0.607 | −1.8 | 0/6 |

One mechanism explains all of it: selecting on a CV-4.22 objective converges the population onto
whichever genome got lucky, destroying the diversity random initialisation supplied. The ordering
fits — the harder a method exploits, the more it hurts. `random` is bit-identical to `none` because
it only records.

**Therefore learning is OFF for every world-search phase** and gets its own factorial afterwards
(§4). Turning it on during world selection would add cost and noise to a problem that is currently
sound.

---

## 2. The dials

**38 dials**, plus the chemistry matrix (20 triangle entries, drawn as constrained / uniform /
mutant mixtures rather than factorially).

| group | dials |
|---|---|
| Physics & economics (10) | `metabolism, T, fMax, kBond, fBreak, maxBonds, rEat, muFood, bondFlow, elementSpread` |
| Food (10) | `foodMode, foodLevel, foodRegime, foodLife, patches, radius, sourceMotion, sourceRelation, sourceSpeed, sourceDensity` |
| Life & reproduction (10) | `eBirth, eRepro, eActivate, reproMut, reproMode, eSpore, sporeFood, fission, templating, rowMut` |
| Matter supply (4) — **new** | `arriveScale, brainShare, decayFree, decayScale` |
| Learning (2) — **new** | `objective, inherit` |
| Other (2) | `spawnEvery, decayScale` |

### What was fixed to get here

- **`arriveScale` and `brainShare` were hardcoded.** The rate at which matter and brains enter the
  world was a constant in every searched world, when it sets how much raw material exists and how
  often a brain appears to try activating. It also interacts directly with `eActivate`: a barrier
  decides nothing in a world where no brain arrives to cross it.
- **`decayFree` was never searched.** The fixed 0.002 is comparable to the whole range of
  `decayScale`, and the two add, so the unsearched term was diluting the searched one.
- **`decayScale` silently killed part of `elementSpread`.** It *overwrote* the drawn per-type decay
  with one uniform value, and every level is above zero, so it fired in **100% of sampled worlds** —
  the `decay` component of `elementSpread` never reached a world. Now a multiplier: per-type decay
  reads 0.0120 / 0.0228 / 0.0120 / 0.0087 where it used to be uniform. Same class of defect as
  `muFood`, and worse than a missing dial, because the factor table reports a null result and we
  believe it.
- **The element draw now covers Brain.** It was `t < 4`, so a brain's own mass, radius, valence and
  bond strength were fixed constants. Defensible while a brain was handed a body; not now that it is
  a particle which must drift, eat over a barrier, and physically recruit limbs — its mass decides
  how far it drifts to find food and its radius what it can get close enough to recruit.
  *(Index trap: `BRAIN = 4` and `FOOD = 5` as type ids, while `FOOD_ROW = 4` and `BRAIN_ROW = 5` as
  matrix rows. The element table is indexed by type id.)*

### What is deliberately not a dial

- **Per-type masses individually.** `elementSpread` varies the *spread*, so a factor table can say
  "worlds whose types differ more do better" but never "a heavy P1 helps". Answering the second needs
  24 more dimensions; it belongs as a targeted follow-up on phase-3 survivors, not a blind sweep.
- **Food's valence and bond strength.** Giving food those makes food structural, which is a
  different world rather than a variation on this one.

---

## 3. The phases

Costs measured on 14 cores, at the shapes below.

| phase | shape | ticks | s/world | seeds | worlds | wall | rule |
|---|---|---|---|---|---|---|---|
| **0 gate** | 24 / 120 | 500 | 0.19 | 1 | 200,000 | **45 min** | keep everything alive; discard only zeros |
| **1 rank** | 60 / 300 | 2,000 | 2.21 | 3 | 40,000 | **5.3 h** | keep top 2,000 by **median** across seeds |
| **2 rank + factors** | 150 / 700 | 20,000 | 7.76 | 3 | 2,000 | **55 min** | keep top 100 |
| **3 confirm + save** | 150 / 700 | 100,000 | ~39 | 5 | 100 | **23 min** | the showcase set |

**≈ 7.5 hours total.** Budget is not the constraint; statistical validity is. The spare went into
seeds rather than more worlds.

**Phase 0 ranks nothing** (§1.2). Expected survival ~60%, from a measured 1-in-4 dead at this shape.

**Phase 1 is the first legitimate ranking**, and it ranks on the **median** across seeds rather than
the mean: world scores are heavy-tailed, so the median is the robust statistic.

**Phase 2 is where the factor tables come from** — 20,000 ticks is the first horizon at which the
upper rungs are reachable at all.

### The pilot ran, and it stopped the launch

**A 4,000-world pilot (2% of budget, 30 minutes) found that the full run would have produced twenty
showcase worlds all at level −1.** Recorded here because it is the result, not a preamble to one.

| gate | result |
|---|---|
| 1 — dial coverage | **pass**: thinnest level n = 464, scaling to 23,200 at full budget |
| 2 — no rung pinned | 3 rungs at 100% zero, all three horizon-limited rather than pinned |
| 3 — worlds reach level ≥ 1 | **0.0%**, and `level >= 0` is also **0.0%** |

Re-run at the full phase-1 horizon on 300 gate-passing worlds: `Persists` 81% met, `Feeds` 21%,
**`Lasts` 0.0%**, everything above it at or near zero, and **not one world at level ≥ 0**.

Two causes, found in sequence, and both are my own specification errors rather than facts about the
worlds:

1. **`Lasts` wants a p90 lifespan of 2,000 ticks and phase 1's horizon *is* 2,000 ticks.** You
   cannot have a p90 lifespan of 2,000 in a 2,000-tick run, so tier 0 cannot be assessed at phase 1
   at all, and a gate phrased as "phase-1 survivors reaching level ≥ 1" was impossible by
   construction. At 20,000 ticks `Lasts` becomes passable — measured max 1.92.
2. **At 20,000 ticks `Feeds` becomes the blocker instead: median 0.00.** And the two are
   anti-correlated across sampled worlds — one world read `Lasts` 1.92 with `Feeds` 0.49, another
   `Feeds` 2.05 with `Lasts` 0.56. **No world passed both.**

The common cause is that **both tier-0 rungs are defined against the birth endowment**, and the
birth endowment no longer exists in the form they assume. `Feeds` is "harvested over endowment" and
`Lasts` is "lifespan over what coasting on the endowment allows" — but an organism now activates
holding almost nothing, so both denominators went to approximately zero and neither rung means what
it says any more.

**Tier 0 gates `level` for the whole ladder**, so until it is recalibrated every world scores −1
however good it is, and the search would rank on sub-rung scores and save twenty worlds that all
look identical on the page. That is why this run has not been launched.

### Three gates before committing the full budget, on a 2% pilot

1. every dial level holds n ≥ 30 after phase 1
2. no rung pinned at 0 or 1 across all worlds
3. at least 5% of **phase-2** survivors reach level ≥ 1 — *phase 1 is too short to assess tier 0,
   which is what the first pilot discovered the hard way*

If gate 3 fails, the ladder is too hard for the current world and the pilot said so for 1/50th of
the cost.

---

## 4. Learning, as a separate factorial

Not a dial in the world search. Take the **top 20 confirmed worlds** and cross:

`local {off, hebb} × global {off, ga} × objective {offspring, per_tick} × inherit {birth, learned}`

16 cells × 20 worlds × 5 seeds = **1,600 runs, ≈ 4 h**, paired within world so each world is its own
control. This is the first honest test of "does learning ever help, and under what objective" — and
it includes the **both-on** cell (lifetime learning feeding heritable weights, the Baldwin
configuration) which cannot be expressed today and needs the two-engine composition built first.

---

## 5. What I expect to find

Written before the run so it can be wrong. These are predictions, not hopes.

| | prediction | why | what it would mean if wrong |
|---|---|---|---|
| **P1** | Self-repulsion wins by phase 2 | carried from v1, never tested at scale | — |
| **P2** | `fMax / fBreak` is the strongest single factor on the structural rungs | it decides whether a body can drag a structure or tears free of it | structure is set by chemistry, not by force balance |
| **P4** | `reproMut` 0 is clearly worse than any nonzero rate | without mutation there is no variation to select | **nothing in this model is evolving** — the most important finding available |
| **P6** | A moving food source raises `Taxis` and `Improves` over the static control, and `orbit` beats `wander` at matched speed | the difference is anticipation | moving food is a cost with no benefit, and the whole food-dynamics programme was wrong |
| **P7** | `Budgets` is passed by worlds no existing rung distinguishes | it is the only rung thrift cannot satisfy | the rung is measuring something another already captures |
| **P8** | `eActivate` is among the three strongest factors on every tier above 0 | it sets the descended share of the population, which moved from 2.6% to 48% when the subsidy closed | selection pressure is not what limits this world |
| **P9** | `arriveScale` interacts with `eActivate` more strongly than either acts alone | a barrier is meaningless without arrivals to cross it | the two are independent, and matter supply is not limiting |
| **P10** | No learning configuration beats `local off, global off` | measured at −0.26 to −1.09 already, and the noise analysis says why | the objective was the whole problem, which would be excellent news |
| **P11** | Most worlds plateau at level 1–2 | `Lingers` needs a product of two inputs and the brain is one linear layer (M1) | the brain is less of a limit than the architecture suggests |

**P5 is retired as untestable.** It concerned the collective tier, and `Moves together` is currently
unscored — see §7.

---

## 6. What gets saved

| artefact | when | what for |
|---|---|---|
| `search/catalog-p{0..3}.jsonl` | every phase, appended | the full record; a resumed search skips what it holds |
| `search/factors-p2.json` | phase 2 | the factor tables, with studentized-range and Bonferroni correction over a family of 68 |
| `public/discoveries.json` | after phase 3 | the browser page: every showcase world, its ladder level, and its rung-by-rung sheet |
| **checkpoints every 5,000 ticks, phase 3 only** | phase 3 | **the point of the exercise** — open any showcase world at any tick and watch it, instead of re-running 100,000 ticks. ~12 MB each at this shape, 20 kept per world |
| `search/pilot.json` | before phase 0 | the three gates, so a failed gate is a record rather than a memory |

Phase 3 survivors are the deliverable: a world you can open, scrub through, and watch climb.

---

## 7. Known limits of this run

- **`Moves together` is unscored, so the collective tier is unreachable.** Eight controls were tried
  and all eight failed; the rung reports what it measures and never passes. **Phase 3 cannot produce
  a world above level 5 however good it is.** Worth deciding whether to fix this before launching,
  because it caps what the search can find.
- **`Lingers` needs a product of two inputs** and the brain is a single linear layer, so tier 2 may
  be unreachable for architectural reasons (M1). P11 predicts this bites.
- **A ~0.4% energy leak remains**, halved from 0.5% by fixing an assignment in `templateParticles`.
  `tests/evolution.test.ts` is left failing on purpose rather than relaxing a ledger bound.
- **The learner evidence is six paired seeds.** Directions are consistent and two results are
  individually significant, but nothing here should be treated as settled until §4 runs.

---

## 8. What was discarded

Measured under the energy subsidy, re-recorded or retired:

- the six golden worlds (re-pinned)
- the equivalence baseline (re-recorded)
- `v1_phased_search.md`'s factor tables and rankings — **kept as a record of the method, not of the
  world.** Any specific claim about which dial mattered must be re-derived.
- the hand-built feasibility results, scored against a ladder with two broken nulls
