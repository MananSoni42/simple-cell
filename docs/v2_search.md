# The v2 search: what to run, and what had to be fixed first

*Written after the energy model changed. Every number in `v1_phased_search.md` predates that change
and describes a world that no longer exists — see "What was discarded" below.*

## Why v1's conclusions cannot be carried over

The world handed out organisms. Every `T_spawn` ticks it created a four-limbed body and **endowed
every particle of it with energy out of nothing**, measured at **41% and 67% of all energy entering
two sample worlds**. The ledger balanced because the creation was booked as injection, which is
exactly why it survived 260,640 worlds of searching.

Three consequences for v1's results, in increasing seriousness:

1. **Food level meant much less than it claimed.** A "scarce" world could still be two-thirds
   subsidised, so the whole food axis was compressed toward the middle.
2. **Efficiency metrics were partly measuring run length**, because the subsidy arrived per unit
   time regardless of behaviour.
3. **The thrift attractor may have been partly an artefact.** Every learner and every search in v1
   converged on "spend less". A steady drip of free energy arriving whatever anybody did is a
   mechanism that would produce exactly that, and we cannot now tell how much of it was real.

The most telling single number from the fix: in the default world, `budded` rose **0.33 → 4.47**
while total births fell. The share of organisms that are *descendants* rather than fresh random
spawns went from **2.6% to 48%**. For v1's entire run, 97% of organisms were freshly randomised, so
selection had almost nothing to act on. That alone may matter more than the energy accounting.

## What the world is now

Nothing is issued. A loose brain particle eats until it crosses an **activation barrier**, written
as a rate rather than a threshold so temperature decides how readily life starts, then assembles its
own body out of whatever drifts into the right quadrant at the right radius — paying for each limb
out of its own reserve. A body that runs dry dissolves, part of what it held becomes food, its
particles return to the pool, and what they *are* is drawn again. **Matter is conserved; only energy
flows, and all of it enters as food.**

## Measurements that decide the shape of the search

### The search's own worlds are viable. The seeded ones are not

This distinction nearly cost a redesign. `initFromSeed` worlds — the generator behind the goldens —
mostly die now: four of six goldens end with 0 or 1 organisms where they had 2 to 16, while the one
2× world is unscathed at 16. That looked like "1× worlds are no longer viable", which would have
forced every phase up a scale and multiplied the search's cost by four.

It is not true of the **constrained sampler the search actually uses**:

| shape | ticks | still alive | mean organisms | mean limbs |
|---|---|---|---|---|
| slots 24, matter 120, 1× | 500 | **24/24** | 15.9 | 42.4 |
| slots 24, matter 120, 2× | 500 | 23/24 | 15.9 | 21.8 |
| slots 60, matter 300, 1× | 2000 | 23/24 | 36.7 | 117.1 |
| slots 60, matter 300, 2× | 2000 | 23/24 | 29.3 | 83.0 |
| slots 150, matter 700, 2× | 2000 | **24/24** | 81.3 | 251.9 |

**So the phase shapes stay as they are.** The sampler's constrained chemistry produces worlds that
live; `initFromSeed`'s unconstrained draw does not, which is a fact about that generator rather than
about the scale.

### Large worlds now work, and what they cost

Scale was raised to 128×, and two things had to be fixed to make it usable:

- **The food cap was nine tenths idle.** `max_food` was `300 × area`, and measured use was 11.0%,
  9.8%, 9.9% and 9.8% at scales 1, 2, 4 and 8. Sizing it from arrival rate × spoilage life instead
  took a 128× world from **~2GB to ~646MB**.
- **Seeding was quadratic.** `spawnRandom` rebuilt the full candidate pool per organism, so seeding
  cost O(n_start × nMatter): **63 seconds** for a 128× world, against 73ms to allocate the same
  world empty. Batching the scan took it to **4.6 seconds**.

| scale | across | alloc | per tick | snapshot | verdict |
|---|---|---|---|---|---|
| 1–8 | 300–2,400 | <10ms | 0.3–3.5ms | ≤3.5MB | search |
| 16 | 4,800 | 26ms | 12.8ms | 12MB | search, at a cost |
| 32 | 9,600 | 64ms | 68ms | 45MB | ~15 ticks/s — a few long runs |
| 64 | 19,200 | 369ms | 296ms | 178MB | ~3 ticks/s — one run, overnight |
| 128 | 38,400 | 4.6s | 2.3s | 711MB | ~0.4 ticks/s — watching one world, not searching |

**Recommendation: search at 1–2×, confirm promising worlds at 8–16×, and reserve 32×+ for
observation.** A 128× run of 10,000 ticks is about seven hours and its checkpoint is most of a
gigabyte, so it is a showcase rather than an instrument.

## The ladder: nine of ten rungs are sound, one is not

Across **30 unaided worlds** that must not trip anything above tier 0:

| rung | tripped | worst ratio |
|---|---|---|
| Persists (tier 0, allowed) | — | 1.00 |
| Feeds | 0/30 | 0.93 |
| Lasts | 0/30 | 0.84 |
| Taxis | 0/30 | 0.43 |
| Lingers | 0/30 | 0.76 |
| Improves | 0/30 | 0.07 |
| Lineage improves | 0/30 | 0.91 |
| Follows signal | 0/30 | 0.77 |
| **Moves together** | **unscored** | see below |
| Holds together | 0/30 | 0.30 |

Two were fixed on the way here. **`Lineage improves`** became a partial correlation with age
partialled out of both sides: among contemporaries, generation correlates with youth, so any
age-dependence of efficiency read as a generation effect and the rung passed on worlds where nothing
is inherited — 1.03 unaided, now 0.20. This was owed as M4.

**`Moves together` is unscored, and that is the honest state.** Eight controls were tried and all
eight failed, each differently and each initially looking like the rung working: a baseline that
empties as a world gets better at bonding (0.00); organisms holding no bond (**3.81×**); size-matched
non-compound organisms (**2.77×**, because a solo brain drags inert matter while a compound member's
partners push); the members' own pre-join speed (unavailable — **median join age 19 ticks, 93% join
before age 100, zero of 60 organisms had a usable baseline**); rescaled command agreement against the
population (**8/30**); the same standardised per group size (biased the other way — a coordinated
structure read 0.39); raw agreement against the same number of random non-members (**9/30**, as
fixing size exposed a location confound); and against the *nearest* non-members (**8/30, worst
13.09**, because a single nearby group is itself noisy).

The pattern is that this world offers no population comparable to a structure's members: being
bonded correlates with size, anchoring, co-location and age simultaneously. A usable version probably
needs a **physical** counterfactual — re-simulating the same members with their bonds removed for a
few ticks — which is a real piece of work, not another choice of baseline. Until then the rung
reports what it measures and never passes, so no search can optimise against a number nobody trusts.

**This means the collective tier is currently unreachable**, and v2 should be read with that in mind.

## What was discarded

Everything below was measured under the subsidy and has been re-recorded or retired:

- the six golden worlds (re-pinned; the diff is in the commit)
- the equivalence baseline (re-recorded)
- `v1_phased_search.md`'s factor tables and rankings — **retained as a record of the method, not of
  the world.** Any specific claim in it about which dial mattered should be re-derived.
- the hand-built feasibility results, which were scored against a ladder with two broken nulls

## Order of work before launching

1. **T1 — the thermodynamic rung.** Now measurable honestly for the first time: it reads order
   maintained against energy throughput, and until this week up to 67% of throughput was free money.
   It is also the one rung that sitting still cannot pass, which is the whole point.
2. **T2 — the detailed-balance test.** Turn the sun off; separations must follow `exp(−U(r)/T)`. A
   hidden energy source shows up as the wrong effective temperature, and this would have caught the
   endowment bug by inspection rather than by accident.
3. **A 2% pilot**, against three gates: every dial level holds n ≥ 30, no rung pinned at 0 or 1
   across all worlds, and stratifier cells populated.
4. **Full phase 0**, with learners entering at phase 2 rather than after everything.

## Pre-registered predictions

Written before the search so they can be wrong.

- **P1** Self-repulsion wins by phase 2. *(carried from v1, never tested at scale.)*
- **P2** `fMax / fBreak` is the strongest single factor on the structural rungs.
- **P4** `reproMut` 0 is clearly worse than any nonzero rate. If it is not, nothing here is evolving,
  and that is the most important finding available.
- **P5** Nothing reaches a collective tier without bond angular rigidity. *(Untestable until the
  travel rung has a null — noted rather than quietly dropped.)*
- **P6** A moving food source raises `Taxis` and `Improves` over the static control, and `orbit`
  beats `wander` at matched speed, the difference being anticipation.
- **P7** The thermodynamic rung is passed by worlds no existing rung distinguishes, because it is the
  only one thrift cannot satisfy.
- **P8** *(new)* `E_activate` is among the three strongest factors on every tier above 0. It sets how
  much of the population is descended rather than freshly randomised, and that share just moved from
  2.6% to 48% — if selection matters at all here, the dial that governs how much selection can
  accumulate should matter most.
