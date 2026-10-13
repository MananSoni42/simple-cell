# E8 — is the ladder climbable?

The ladder was redesigned to be hard, and it is: **nothing passes any rung above the viability
tier**, in any of four conditions from blind-and-unlearning up to an online learner. That is the
intended state and it leaves one question unanswered, which is the mirror of the bug it fixed:

> A ladder nothing has ever climbed is indistinguishable from a wall.

Three situations currently look identical from outside, and they call for opposite responses:

| what is true | what to do |
|---|---|
| the rung is hard but climbable | proceed — this is the goal |
| the threshold is set too strictly | recalibrate it |
| the **instrument cannot see** the behaviour | fix the instrument; a search against it is wasted |

Nothing distinguishes them from a run that scores zero. So before any search spends core-hours on
this ladder, each rung gets a brain **built by hand to pass it**. If a deliberately-constructed
solver fails, the problem is the rung, not the world.

## The method

The brain is a 41 → 10 linear map with named input and output indices, so a policy can be written
rather than evolved. Each case sets the weights for exactly one capability, leaves the rest at
zero, and asserts the rung fires. These become permanent tests: deterministic, fast, and they fail
in the suite rather than six months into a search.

## Rung by rung

### Taxis — expect to pass
`FOOD_X → FX`, `FOOD_Y → FY`. The food-pull vector is already an input, so chemotaxis is literally
one weight per axis. If this fails, the instrument is broken, because nothing simpler exists.

### Lingers — expect to pass, and it is the interesting one
The rung wants *commanded turning* to rise where the food count is high. A feedforward map has no
memory, so "turn" has to come from somewhere — and it can: the **own-velocity** inputs give the
current heading, and a torque is a rotation of it.

```
FX ← −VEL_Y × k × FOOD_NEAR
FY ← +VEL_X × k × FOOD_NEAR
```

That is a turn whose rate scales with how much food is around. Note what it demonstrates: this
rung is only reachable *because* the velocity inputs exist. It is the first concrete payoff from a
sense whose first measurement came out flat.

### Follows signal — expect to pass, via the body
The brain's own field input is a **scalar at its own position**; there is no gradient input. But
each limb reads the field at *its* position and sends one signal inward, and the four limbs sit in
known quadrants. So the gradient is reconstructible from the four socket signals, with the body
acting as a spatial sensor array:

- limb weights: pass the field through, `wLimb[S_field] = 1`, everything else zero
- brain weights: combine each socket's signal into the direction that socket points

If this passes, the rung is a real test of using the body to sense. If it fails with a near-zero
ratio, the honest conclusion is that a four-point sensor array is too coarse to resolve this
field, and the rung needs either a gradient input or removal.

### Moves together — expect to pass
Hand-build **identical** brains pushing the same direction, with a chemistry that bonds, and check
a structure of order ≥ 3 outruns a solitary organism. Random organisms fail this because each
pushes its own way and the centroid cancels; identical ones should not.

### Improves and Lineage improves — **cannot be hand-built, by construction**
These ask for change *within* a life and *across* lives. A fixed brain cannot improve at anything,
so no hand-built policy can pass them and a failure would say nothing. They need a learner, which
makes them a different experiment: does TD(λ) pass `Improves` under the most favourable conditions
we can arrange — long lives, plentiful food, high exploration?

That reframing is useful on its own. It means **four of the six intelligence rungs are testable
without any learner, and two are tests of the learners specifically.**

## Results

Five hand-built policies, 9,000 ticks, `reproMut: 0`, in a generous world. `*` means met.

| policy | Persists | Feeds | Lasts | Taxis | Lingers | Improves | Lineage | Signal | MovesTog | HoldsTog |
|---|---|---|---|---|---|---|---|---|---|---|
| **taxis** | \*1.00 | \*4.05 | \*3.07 | **\*8.52** | 0.52 | 0.00 | 0.00 | 0.00 | 0.00 | 0.07 |
| **followsSignal** | \*1.00 | 0.00 | 0.06 | 0.51 | 0.43 | 0.00 | 0.21 | **\*1.80** | 0.00 | 0.07 |
| **movesTogether** | \*1.00 | \*3.10 | \*1.36 | 0.00 | 0.00 | 0.00 | 0.56 | 0.00 | 0.00 | 0.04 |
| **lingers** | \*1.00 | 0.00 | \*1.39 | 0.02 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.03 |
| **thrifty** (control) | \*1.00 | \*3.12 | \*4.04 | 0.00 | 0.00 | 0.00 | 0.19 | 0.00 | 0.00 | 0.12 |

**The ladder is climbable. `taxis` reaches level 1 — Reactive — clearing Taxis at 8.5× its
threshold** and dragging `Feeds` to 4.05 and `Lasts` to 3.07 behind it: a brain wired straight to
the food gradient eats deliberately and lives four times longer for it. The do-nothing control
scores 0.00 on every intelligence rung. `followsSignal` clears its own rung at 1.80.

An earlier version of this document reported **level 2**, and that was an artefact of the `Lingers`
confound described below — plain chemotaxis was passing a rung about area-restricted search. Fixing
the rung cost the claim, which is the right trade.

### Six things E8 found that nothing else would have

**1. A hand-built policy does not survive reproduction.** Budding inherits weights with Gaussian
mutation, so over twelve thousand ticks the descendants of a written brain drift into something
else. The descendants of a brain whose every weight was **zero** reached a commanded force of 0.77
and went on to *pass a rung*. The entire first run of this suite was measuring drift; every result
above needs `reproMut: 0` to mean anything.

**2. The signal field is self-extinguishing, which is why `Follows signal` always read ~0.01.** A
limb deposits into the field only when its own neuron fires, and a limb neuron's largest input is
what the brain told it — so with every brain silent the field stays at zero, nothing has anything to
report, and there is no gradient. The first `followsSignal` policy read the socket signals
faithfully, commanded nothing, and scored **identically to the do-nothing control to every decimal
place**. Adding a bias on the outbound signal outputs took it from 0.00 to **1.80**. The rung was
never unreachable; the world was never signalling.

**3. `Lingers` was a second, noisier Taxis.** Plain chemotaxis scored **4.64** on it, because
following a wandering gradient means turning when the gradient turns and a gradient turns most
inside a patch. It now counts a turn only while the gradient is **steady** — within ~11° of last
tick — so leftover turning cannot be the gradient's doing. Chemotaxis fell to **0.52**.

**4. Area-restricted search is not representable by this brain.** Conditioning turn *rate* on the
food count wants `VEL_Y × FOOD_NEAR`, a **product of two inputs**, and the brain is a single linear
layer. The best linear attempt reaches 0.86 — close enough to be worth knowing, and still short. A
proper attempt needs a hidden layer or a multiplicative input. The one nonlinearity that exists is
the `tanh` at each limb, reachable through the socket signals, which is how `followsSignal` works
and where a serious attempt should go.

**5. `Moves together` demanded something physically impossible, and has been split.** It required a
structure travel **1.5× faster than a solitary organism**. The dynamics are overdamped — velocity
goes as force over drag and both scale with member count — so a perfectly coherent structure moves
at exactly solo speed and never faster. Nothing could ever have passed it. Matching solo speed is
the right claim, because the alternative is what happens: members pulling different ways cancel and
an incoherent centroid crawls.

It also conjoined travelling with persisting, and which half bound depended on the horizon —
`heldFrac` read **0.554 at 9,000 ticks and 0.057 at 12,000** on one world, seed and policy, because
it divides by a windowed mean *completed lifespan*. Persistence is now **Holds together**, measured
in coasting times.

**6. A windowed maximum of a ratio is not a statistic.** Reading whichever structure existed at the
instant of asking made the rung forget a capability it had shown — the multiple reached **2.206**
while the rung reported 0.00, because the structure alive at the end was 460 ticks old against a
500-tick guard. So it reads the window; and a maximum over a *ratio* seeks the sample with the
smallest denominator. The do-nothing control then scored **17.36** on a rung about moving, since its
organisms only drift. Fixed twice over: the baseline must itself be moving, and the statistic is the
**median** of qualifying samples.

### What both collective rungs now say

That **structures do not last.** Order 19 and 41 form readily and travel at 2.2× solo when old
enough to measure, but one that is both order 3+ and 500 ticks old is too rare to sustain the rung,
and the best hold is about a tenth of a coasting time against a required three. Before the split
that single fact was hidden inside a composite threshold.

### Still untested

`Improves` and `Lineage improves` cannot be probed this way: they ask for change within a life and
across lives, and a fixed brain cannot improve at anything. They are tests of TD(λ) and the Hebbian
learner, under the most favourable conditions available.

## What each outcome changes

- **All four hand-buildable rungs pass.** The ladder is calibrated and the metrics gate is cleared.
  Proceed to the v2 pilot.
- **A rung fails with a high ratio** (say above 0.6). The behaviour is visible and the threshold is
  too strict; lower it to where a deliberate solver clears it with margin, and record the solver as
  the reference.
- **A rung fails near zero.** The instrument cannot see the behaviour even when it is definitely
  present. That is a bug, and it is the outcome worth most, because it is invisible any other way.

## Then what

In order, once E8 reports:

1. **E7 (`cap`)** — is perception unpaid because the population cap, not food, is what this world
   selects on? 41,244 reproductions blocked for want of a brain slot against 230 successful buds
   says the selection pressure has nothing to do with finding food. One dial, and it may explain
   why the senses measured flat.
2. **Re-run `senses` and `learners` at thirty seeds** against the *new* ladder. Both earlier
   verdicts were taken on a metric since shown to be mostly noise above tier 0, so they are
   uninformative either way rather than negative.
3. **v2 pilot at 2% budget**, against three gates: every dial level holds n ≥ 30, no rung is pinned
   at 0 or 1 across all worlds, and the stratifier's cells are populated rather than mostly empty.
4. **Full v2 phase 0**, with learners entering at phase 2 rather than after everything — v1 ran its
   entire search at `learn: 'none'` and then asked why nothing had learned.

## Deferred, and now better motivated

- **A recurrent brain.** The stated prerequisite for a memory tier: the brain is a pure feedforward
  map, so identical inputs give identical outputs and memory is not representable. Note that
  `Lingers` is a partial substitute — it gets persistence from the velocity *input* rather than from
  internal state.
- **Making signalling useful.** `Follows signal` sat at 0.01 in every measured condition. If E8
  shows the rung is reachable by hand, that number is a fact about the organisms; if it is not, it
  is a fact about the world, and signalling needs to pay before anything can be measured following
  it.
