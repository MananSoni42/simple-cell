# v2: an expressive world, an open search

## The goal, stated so it can be falsified

Organisms that **learn, evolve, and slowly get smarter and more complex**, ideally becoming
stable multi-organism structures. Evolving complex intelligence should be *possible within the
constraints* — not inevitable, not designed in. And the ladder should be a calibrated path to
that, with the rungs as real milestones rather than as whatever happened to be measurable.

Two principles govern every decision below.

**Make the world expressive enough.** Most of the v1 failures were not organisms failing at
something; they were the world being unable to *represent* the thing being asked for. An organism
in a food cloud read zero. A brain had no input carrying its own velocity. A bond is four times
stronger than any force a brain can exert, so "move together" was unreachable by construction.
None of that is a result about life; it is a result about the model.

**Be open — discover, do not decide.** Every constant is a decision made before the evidence.
Two of mine have already been measured wrong by a wide margin (`r_eat` 12 beat 6 in both
pairings; `F_break` 2.5 cost four fifths of all standing bonds against 4). A search that fixes
the physics and varies only the chemistry can only find the best world *consistent with my
guesses*, and will then present my guesses back to me as a finding.

## Where v1 left things

From [v1_phased_search.md](v1_phased_search.md) — 260,640 worlds, 90 core-hours:

| Solved | At the floor |
|---|---|
| Heredity (100% of confirmed worlds breed true) | **Agency: 2.5%** — nothing seeks food |
| Lineage outliving the individual (100%) | **Metabolism: 20%** — organisms live on their inheritance |
| Association — things join (100%) | **Structural persistence: 15%** |

**Nothing in 260,640 worlds reached level 2.** And the search found a flaw in my metric rather
than a world: `Lasts` was rewarding short lives, because coasting time scales with the metabolism
dial.

The honest reading is that v1 searched a world that could not express what levels 2 and up ask
for. That is what v2 fixes first.

---

## 1. World changes

### Done (this commit)

| Change | Rule | Note |
|---|---|---|
| Brain reads a normalised food count over its whole body | R5.4 | the cloud blindness; the signal existed and nothing read it |
| Brain reads its own net displacement, two ticks lagged | R5.5 | its only memory, and its only feedback from the world |
| Brain reads each limb's within-quadrant angle | R5.5 | it did not know which way its body pointed |
| Brain reads bond load, per limb and per body | R5.5 | bonds were never mentioned in any input |
| Food mobility `μ · mu_food`, kick `sqrt(mu_food)` | R2.2b | you cannot catch what diffuses as fast as you swim |
| Food capacity 120 → 300 per area, wasted light counted | R4.1 | a capacity that binds is a thermostat |
| Reproduction failures counted by cause | R7.7a | four diagnoses had one symptom |
| Nine physics and economics constants became searchable dials | — | see §3 |
| Ablation seam for brain inputs (`WorldOpts.blind`) | — | so each sense is a measurable claim |

Brain shape 29 → 41 inputs. Saved organisms from before are refused loudly, which is the existing
rule and correct.

### Next, in priority order

**W1 — Bond angular rigidity.** *(largest expected effect on the stated goal)*
A bond is a distance spring, so a bonded chain has no preferred shape. "Compound organisms that
hold a form" may be literally unreachable: a structure can currently be a clump or a floppy
chain, and nothing else. Add an angular term between two bonds sharing a particle, with the rest
angle and the stiffness both searchable — including zero, so the search can find that the current
world was right. **Needs the stability budget re-derived**, since a new force enters `d_max`.

**W2 — Make `F_max` vs `F_break` a first-class ratio.** Already searchable as two dials, but the
prediction deserves naming: at `F_max` 1 and `F_break` 4 no organism can pull itself free of a
structure or drag one anywhere. If "moves together" turns on anything, this is my first guess.
Reported as its own factor in `analyse.ts`.

**W3 — Comet food should move.** The one food pattern whose name implies motion places static
food. Cheap, and worth more now that food is heavy enough to be chased — it is the cleanest test
of pursuit the world can offer.

**W4 — Senescence.** With starvation as the only death, a thrifty immortal is a perfect strategy,
which is what every search keeps finding. An age term makes reproducing *early* worth something.
Searchable, with "off" among the levels. Note: distinct from bond aging, which was rejected on
the grounds that particles should loosely represent chemicals — that reasoning does not extend to
organisms.

**W5 — Anabolism.** Energy becoming matter. This is the real reason reproduction cannot be
boundless, and it would make growth a decision rather than a lottery over nearby debris. **Breaks
matter conservation**, a law with tests, so it must be a world *option* with its own ledger, not
an edit to the default.

**W6 — Addressed signalling.** The field is a scalar everyone reads, so a message cannot have a
recipient, which blocks division of labour. The brain now knows it *has* bonds; sending anything
along one is the natural next step.

## 2. Small experiments and ablations

The rule: **one change per measurement, several seeds, standard errors, and a pre-registered
prediction.** Four complementary changes made at once are four changes none of which can be
credited — which is why the ablation seam exists.

| | Experiment | Question | Prediction |
|---|---|---|---|
| E1 | `scripts/senses.ts` — **running now**, 20k × 5 seeds | Does each new sense pay, and which? | food count and heavy food matter together, neither alone; `Seeks` stays near zero without a payoff for moving |
| E2 | Force ratio sweep: `F_max` × `F_break` | Can an organism out-pull a bond, and does it then move a structure? | the strongest single effect on `Holds`/`Moves together` |
| E3 | Mutation rate sweep, `reproMut` 0 … 0.15 | Is evolution doing anything, or is every world decided at init? | 0 should be clearly worse; if it is not, nothing is evolving and that is the headline |
| E4 | Angular rigidity sweep (after W1) | Does a preferred shape produce persistent structure? | large on `heldFrac`, small on lifespan |
| E5 | Learner × mortality | The learner is inert in healthy worlds — 788 of 800 attempts failed for want of a free brain slot | learning rate should rise with death rate, which would make the two inseparable |
| E6 | Clamp regime audit | How many catalogued worlds run with the integrator, not the chemistry, in charge? | already known to matter: at `T` 20 the clamp erases food's mobility entirely |

E1 and E6 are done or running. E3 is the one I most expect to be uncomfortable.

## 3. Parameters: what the search is allowed to vary

Now searchable, each as a discrete set so the factor tables have cells with worlds in them:

| Group | Dials |
|---|---|
| **Chemistry** | 14 quantized triangle entries (unchanged) |
| **Forces** | `muFood` (food vs life mobility), `fMax` (how hard a brain can push), `kBond`, `fBreak`, `maxBonds` |
| **Economics** | `rEat` (mouth width), `eBirth`, `eRepro`, metabolism |
| **Evolution** | `reproMut` (mutation rate), `learn` (algorithm) |
| **World** | temperature, food pattern / level / regime / patches / radius / spoilage, bond flow, fission, slots, matter, scale |

### The cost, stated plainly

This multiplies the space by about 10^5. That sounds fatal and is not: the search has always been
a **sampler, not an enumerator** — 7^14 chemistries is already 6.8 × 10^11, and 260,640 worlds
covered 4 × 10^-7 of it. A new dial costs **statistical power per dial**, not coverage. At a
200,000-world phase every level of every dial still holds tens of thousands of samples, so
marginal means stay solid.

What genuinely degrades is detecting **interactions** between dials — and §1's prediction (force
ratio) is exactly an interaction. So E2 is a deliberate sweep rather than something to be read
off the big search, and the stratifier should cross force ratio in, next to self-repulsion and
food pattern.

### Still fixed, and why

`SIZE`, `r_c`, `beta`, `K_core`, `L_rod`, the brain exclusion radii, `d_max`, `dth_max`. These
are the integrator's own scale and the geometry that `substepsFor` derives its budget from.
Varying them does not explore a different world so much as a differently-broken numerical scheme.
If any of them should move, it should move as a deliberate re-derivation, not as a search dial.

## 4. Metrics and the ladder

The ladder's job is to be a calibrated path, and v1 proved it is not yet one. Three known
failures, in order of severity:

**M1 — `Seeks` reads geometry, not behaviour.** It goes 0.000 → 0.107 → 0.000 as `r_eat` goes
6 → 12 → 20 **with no learner present**. A rung that moves when nothing is learning is measuring
the world, not the organism. Fix: score alignment against a within-world null — the same organism's
movement correlated with a *shuffled* food direction — so the geometry cancels.

**M2 — Nothing measures intelligence, only survival.** The stated goal includes "slowly get
smarter", and no rung distinguishes an organism that responds to what it sees from one with a
lucky constant policy. Proposed rungs, in increasing order:
- **Responds** — mutual information between a brain's inputs and its outputs above the null for a
  frozen policy. Cheap to approximate, and it directly separates "acting" from "twitching".
- **Discriminates** — behaviour differs measurably between food-rich and food-poor surroundings.
  The new food count makes this representable for the first time.
- **Improves within a life** — performance later in a life beats performance earlier, for the
  same organism. This is the rung that would make the local learning loop visible.

**M3 — Rungs are not calibrated against each other.** They are thresholded against nulls
individually, which is right, but nothing checks that level 2 is *harder* than level 1. With
260,640 worlds of data the pass rates are now known, so the levels can be ordered by measured
difficulty and any rung that is easier than a lower one moved down.

Also: keep the `(r+0.5)/(n+1)` percentile normalisation and the frozen baseline cohort. The
zero-sum version made CEM look inert, and random search scored +0.002 on it — that calibration
is why raw units are the headline now.

## 5. UI

| | Change | Why |
|---|---|---|
| U1 | Show the new senses in the inspector: food count, own velocity, bond load, per-limb angle | the brain's inputs are now the interesting part of an organism, and none of them are visible |
| U2 | Law dials in the builder, grouped as *Forces* and *Economics* | they are searchable now, so they must be playable — and a searched world must be openable as it was scored (already wired through `Init.laws`) |
| U3 | Surface ceilings: wasted light and blocked births | **done** — in the left pane under Food |
| U4 | Discoveries: show which dials a world won on, not only its score | a top-ten list says which worlds worked, not why, and the why is what carries to the next search |
| U5 | A ladder page explaining each rung's null and threshold | the ladder is the project's definition of progress and is currently only legible in code |

## 6. The v2 search

Same five-phase shape as v1 — it worked, it is resumable, and it is honest about cost — with four
changes:

1. **Dials include physics and economics** (§3). Phase 0 draws from the full set.
2. **Stratify on force ratio** alongside self-repulsion × food pattern × metabolism. Phase 0 can
   only see clumping and limb retention, so a plain top-N cut would discard exactly the
   chemistries the predictions are about. This is the same error that stratification already
   fixes, applied to the new dials.
3. **Learners enter at phase 2**, not at the end. v1 ran the whole search with `learn: 'none'`
   and then asked why nothing learned. Worth pairing each phase-2 survivor with and without a
   learner, since that is also E5.
4. **Fix the metrics first** (§4). Searching 200,000 worlds against a rung that reads `r_eat` is
   200,000 worlds of wasted compute, and v1 already spent a phase learning that lesson once.

Pre-registered predictions, written before the search so they can be wrong:

- **P1** Self-repulsion wins by phase 2. *(carried over from v1, still untested — phase 2 was
  never reached with enough worlds)*
- **P2** `fMax / fBreak` is the strongest single factor on the structural rungs.
- **P3** `muFood` below 0.4 is necessary for any world to clear `Seeks`.
- **P4** `reproMut` 0 is clearly worse than any nonzero rate. If it is not, nothing in this model
  is evolving, and that is the most important finding available.
- **P5** Nothing reaches level 3 without W1 (angular rigidity).

## 7. Order of work

1. **Metrics** (M1, M2, M3) — a search against a broken rung is wasted compute.
2. **E1 results** (running) and **E2, E3** — cheap, and they decide how much of W1–W6 is worth building.
3. **W1** (angular rigidity) with its stability re-derivation, then **W3** (moving comet food).
4. **U1, U2** so the new world is playable and inspectable.
5. **v2 phase 0** at full dial coverage.
6. **W4–W6** as the data argues for them, not before.

The thing to avoid is the v1 mistake in a new form: building more world, searching it hard, and
discovering afterwards that the metric was measuring the search.
