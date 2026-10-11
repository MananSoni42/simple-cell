# World Rules — v0

The complete and authoritative specification of the v0 world. If a behaviour is not
derivable from the rules below, it does not exist. If the code does something not
written here, the code is wrong.

Companion documents: [DESIGN.md](DESIGN.md) for rationale, stack, and test strategy.

---

## 0. Shape of the world

| | |
|---|---|
| Space | 2D continuous, `SIZE × SIZE`, **toroidal** (wraps on both axes) |
| Time | discrete ticks, `dt = 1` |
| Motion | **overdamped** — velocity ∝ force, no inertia, no momentum |
| Randomness | one seeded PRNG; the entire world is a pure function of `(params, seed)` |

Everything in the world is a particle in one flat array. There are six types:

- **`P1 P2 P3 P4`** — intrinsic matter. Conserved; never created or destroyed after init.
- **`B`** — brain. Conserved.
- **`F`** — food. Created by the sun, destroyed by eating. The world's open boundary.

A particle is free or bound. Bound means: attached to a brain's socket by a rigid rod.

---

## 1. Chemistry

**R1.1** A single **5 × 5 symmetric matrix `A`** over `{P1, P2, P3, P4, Food}` holds
all chemistry. 15 free values in `[-1, 1]`. Positive = attraction.

**R1.2** `A` is symmetric: `A[i][j] = A[j][i]`. Always. This makes the force field
conservative, which is what lets structures (membranes, clusters) assemble as energy
minima — and what makes rule R1.3 necessary.

**R1.3** Because `A` is symmetric, the force field alone can only relax the world
into static structure. **Temperature `T`** (Brownian jitter, R2.2) is what keeps it
alive: it lets structures anneal, melt, and reform. `T` is the single most
consequential dial in the world.

**R1.4** `Food` has a row in `A`. A type with `A[t][Food] > 0` is a mouth; a type
with `A[t][Food] < 0` is a wall food cannot cross. Eating and selective permeability
are consequences of chemistry, not special-cased code.

**R1.5** `B` (brain) has **no** row in `A`. Brains interact only via the hard core
(R2.1), so bodies do not chemically clump into each other.

---

## 2. Physics

**R2.1 — Force law.** For a pair at wrapped distance `r`, with `u = r / r_c` and
core fraction `β`:

```
u < β       →   F = K_core · (u/β − 1)                            [always repulsive]
β ≤ u ≤ 1   →   F = A[i][j] · (1 − |2u − 1 − β| / (1 − β))        [tent, peak at u = (1+β)/2]
u > 1       →   F = 0
```

Positive `F` attracts. Force acts along the minimum-image separation vector. Two
terms with two distinct jobs:

- The **hard core** is universal and not in the matrix. Without it, any attracting
  pair collapses to a point and chemistry can only produce dust.
- The **tent** peaks at a specific distance, which gives matter a *preferred
  spacing*. This is why membranes have a lattice constant instead of being blobs.

**R2.2 — Integration.** Every particle, free or bound, every tick:

```
x ← x + μ·F·dt + sqrt(2·T·dt)·N(0,1)      then wrap into [0, SIZE)
```

**R2.3 — Who feels whom.** All pairs within `r_c` interact, with two exceptions:

- A bound limb and **its own brain** do not (the rod already holds them).
- A limb and **its sibling limbs on the same organism** *do* interact. This is
  load-bearing: it is what gives a body a shape (R3.3).

---

## 3. Organisms

**R3.1 — Body.** One brain particle plus **4 sockets**, one per quadrant. A filled
socket holds a rigid rod of fixed length `L_rod`, rooted at the brain, with one
intrinsic particle at its tip. The tip is always exactly `L_rod` from the brain.

**R3.2 — Quadrants.** Socket `i` owns quadrant `i`, and the four quadrants are
separated by a small angular `gap` so that rods can never coincide. The body is a
disc cut by a thin cross:

```
          │ ╲   gap   ╱ │             θ_i ∈ [ i·π/2 + gap/2 ,
       ───┼────╳────────┼───                  (i+1)·π/2 − gap/2 ]
          │ ╱         ╲ │
        q1 │ q0                      i = 0..3
       ────┼────                      gap = 0.12 rad (≈7°)
        q2 │ q3
```

Within its quadrant a rod is entirely free; at the boundary it stops. `θ_i` is
clamped, not wrapped — a rod pressed against a limit rests there under load.

**R3.3 — Rod angles are physics, not decisions.** The net force on a tip produces a
torque about the brain; the rod swings, damped, and clamps at its quadrant limits:

```
τ  = L_rod · (F_tip ⟂ rod)        // tangential component of tip force
ω  ← (1 − d_rot)·ω + μ_rot·τ
θ  ← clamp(θ + ω·dt, quadrant limits)     // ω → 0 when clamped
```

The brain has no control over `θ`. **Consequence: body shape is an equilibrium of
the matrix.** Limbs whose tip types attract swing together and come to rest against
their shared gap boundary; limbs whose types repel splay to opposite limits. Each of
the shapes below is a stable resting configuration, and not one of them is
enumerated in code — they are all the same four clamped rods under different
chemistry:

```
    =O=              ||                │
                      O              ──O──
                     II                │

  two filled      q0+q1 attract      four limbs,
  sockets,        up, q2+q3          mutually
  splayed         attract down       repelling
```

The `gap` is what makes `||` legible instead of degenerate: two attracting rods
settle `gap` apart rather than on top of each other.

**R3.4 — Movement.** The brain outputs a force vector `F_move` applied to the brain
particle. The body translates as a rigid unit: every tip moves with the brain, then
R2.2 and R3.3 adjust the tips relative to it. Only the brain pays the motion cost.

---

## 4. Energy

One Food particle carries `E_food`. Every particle has a reserve, capped at `E_cap`.
The ledger must close exactly: `Σ reserves + Σ food in world + total burned` equals
`initial + total injected`, every tick.

**R4.1 — Sun.** Every `T_food` ticks, one Food particle appears at a uniformly
random position.

**R4.2 — Uptake.** A particle within `r_0` of a Food particle consumes it: the Food
particle is destroyed, `E_food` is added to the consumer's reserve. If several are in
range, the nearest consumes it. Nothing compels a particle to seek food — whether it
ever meets one is decided by `A` (R1.4).

**R4.3 — The inward toll.** A bound limb keeps `k_keep = 10%` of what it takes in
and passes the remainder **inward** to its brain, one hop per tick. Energy never
teleports.

**R4.4 — Costs.** Every tick, every particle pays; spent energy leaves the world as
heat and is recorded as burned:

| Cost | Amount |
|---|---|
| Upkeep | `c_up` per particle per tick |
| Motion | `c_mv · μ · \|F_move\|²`, brains only |
| Signal | `c_sig · \|sig\|` per emitting particle |

**R4.5 — Redistribution.** The brain holds its accumulated reserve and sends a
fraction `releaseFrac` of it back out along the rods each tick, split by the brain's
output (R5.2). A limb at `E_cap` rejects its share; the rejected energy stays in the
brain.

---

## 5. Neurons

Every neuron has the same shape: `out = tanh(W·x)`. All weights are hand-set in v0.

**R5.1 — Limb neuron** (one per bound intrinsic particle):

```
x   = [ reserve/E_ref , signal_here , foodDensity_here , 1 ]
out = tanh(W_limb · x)                    // W_limb is 2×4
sig = out[0]     →  deposited outward into the signal field
msg = out[1]     →  passed inward to the brain
```

**R5.2 — Brain** (one per organism):

```
x = for each of 4 sockets: [ msg_i , onehot4(type_i) , alive_i ]    // 24
  ⧺ [ reserve/E_ref , signal_here , 1 ]                              //  3
y = W_brain · x                                                      // 27 → 6

food split = softmax(y[0..3])        // how to divide releaseFrac among sockets
F_move     = F_max · tanh(y[4..5])   // where to go
```

**R5.3 — v0 policy: feed the hungriest.** `W_limb` is set so `msg` rises as reserve
falls; `W_brain` is set so the food softmax follows `msg`. A limb near starvation
shouts, and gets fed. This is the healing behaviour, and it is deliberately a
*policy* so that it can be measured against an even-split control.

---

## 6. Signals

**R6.1** Signal is a decaying scalar **field** on a coarse toroidal grid, not a
particle. A signal particle would need to be massless, chemically inert, and
self-destroying — three exceptions to the laws. A field is one rule.

**R6.2** Each tick: particles deposit `sig` at their own position (bilinear), the
field diffuses once (5-point stencil), then decays by `λ`. Every neuron samples the
field at its own position.

This is the only channel between organisms. Influence is stigmergic — written into a
shared medium — so there is no messaging code and no concept of "nearby organism".

---

## 7. Creation and destruction

**R7.1 — Organism spawn.** Every `T_spawn` ticks, one organism appears at a uniformly
random position: a free brain particle plus **1 to 4 filled sockets** (count chosen
uniformly), each taking a random free intrinsic particle, in a random quadrant, at a
random angle within it, seeded with `E_init`. If the free pool is short, fewer
sockets are filled. Organisms are therefore born asymmetric and incomplete, and
R7.3 lets them finish growing from the soup.

**R7.2 — Limb death.** A limb whose reserve reaches 0 **unbinds** and becomes a free
particle again. The organism carries on with an empty socket.

**R7.3 — Regeneration.** An empty socket captures any free intrinsic particle lying
within its own quadrant and within `r_bind` of the rod circle (`|r − L_rod| <
r_bind`, measured from the brain). The particle snaps to `L_rod` and the new rod
takes the angle the particle already had. A socket's capture zone is therefore an
arc, not a point — a body reaches for whatever drifts past the right part of it.

This is the *only* other way a socket gets filled, and it is why healing costs no
extra code: regeneration is binding, running again on a body that already exists.

**R7.4 — Organism death.** A brain whose reserve reaches 0 dissolves: all limbs
unbind, the brain becomes a free particle, and its residual reserve is emitted as
`floor(reserve / E_food)` Food particles nearby. A corpse is food.

**R7.5 — Matter is conserved.** Intrinsic and brain particles are allocated once at
init and never created or destroyed. Birth and death only change `owner` and
`socket`. Scarcity of free particles therefore creates competition for limbs with no
competition logic anywhere.

---

## 8. Tick pipeline

Canonical order. Everything above happens here, once per tick, in this sequence.

```
 1  build spatial hash
 2  pair forces            hard core + matrix, over neighbours within r_c  (R2.1, R2.3)
 3  rod torques            → ω, θ for bound limbs                          (R3.3)
 4  integrate              overdamped drift + Brownian, then wrap          (R2.2)
 5  food uptake            consume Food within r_0                         (R4.2)
 6  inward flow            limbs keep k_keep, pass rest to brain           (R4.3)
 7  limb neurons           → sig, msg                                      (R5.1)
 8  brains                 → food split, F_move                            (R5.2)
 9  costs                  upkeep, motion, signal → burned                 (R4.4)
10  deaths                 limb unbind, brain dissolve                     (R7.2, R7.4)
11  captures               empty sockets take free particles               (R7.3)
12  field                  deposit, diffuse, decay                         (R6.2)
13  sun                    inject food, spawn organisms on schedule        (R4.1, R7.1)
14  ledger check           dev builds only
```

---

## 9. Parameters

Two tiers, and the distinction is the whole discipline of the project. **Laws** are
universal constants — the same for every particle, hand-set once, not play material.
**Initial conditions** are what the start screen randomizes and what you tune.

### Laws

| | | |
|---|---|---|
| `SIZE` | 1000 | world edge length |
| `dt` | 1 | tick |
| `mu` | 0.5 | mobility |
| `r_c` | 40 | interaction cutoff |
| `beta` | 0.1 | core fraction → `r_0 = 4` |
| `K_core` | 3.0 | hard-core strength; must exceed `max|A| = 1` |
| `L_rod` | 12 | rod length |
| `gap` | 0.12 rad | angular gap between quadrants (≈7°) |
| `mu_rot` | 0.02 | rod angular mobility |
| `d_rot` | 0.2 | rod angular damping |
| `r_bind` | 6 | socket capture radius |
| `E_food` | 10 | energy per food particle |
| `E_cap` | 100 | reserve capacity |
| `E_ref` | 50 | neuron normalization scale |
| `E_init` | 30 | reserve of a freshly spawned particle |
| `c_up` | 0.02 | upkeep / particle / tick |
| `c_mv` | 0.5 | motion cost coefficient |
| `c_sig` | 0.01 | signal cost coefficient |
| `k_keep` | 0.1 | fraction a limb keeps |
| `releaseFrac` | 0.3 | fraction of brain reserve sent outward per tick |
| `F_max` | 1.0 | max brain move force |
| `lambda` | 0.05 | signal decay |
| `D_sig` | 0.2 | signal diffusion |
| `fieldN` | 64 | signal grid resolution |

### Initial conditions — the start screen

| | default | |
|---|---|---|
| `seed` | random | determines everything |
| `A` | **random symmetric** | the chemistry; the main dial |
| `T` | 0.05 | temperature |
| `n_intrinsic` | 1500 | conserved matter pool |
| `n_brain` | 20 | conserved brain pool |
| `T_food` | 2 | ticks between food injections |
| `T_spawn` | 200 | ticks between organism spawns |

**Stability constraint.** Overdamped Euler is stable while `μ·|F|_max·dt ≪ r_0`.
With these numbers, `μ·K_core·dt = 1.5` against `r_0 = 4` — comfortable. Raising `μ`
or `K_core` without lowering `dt` lets particles tunnel through each other; this is
an assertion in the test suite, not a comment.

---

## 10. Interface

**Start screen.** Shows the full parameter set with `A` randomly initialized as a
5 × 5 heatmap. `R` re-rolls the random seed and matrix; any value is editable;
**`Enter` enters the world**.

**World screen.**

- **Tick meter**, default **1 tick / second**. `←` / `→` step the rate through
  `0.25, 0.5, 1, 2, 5, 10, 30, 60, max` ticks/sec. `Space` pauses. `.` single-steps.
- Live readout: tick count, free / bound particle counts, organism count, food in
  world, total energy, mean cluster size.
- Rendering: particles as additive glow sprites coloured by type, rods as lines,
  signal field as a colour wash beneath.
- `A` is editable live, so chemistry can be changed on a running world.

---

## 11. Deliberately not in v0

Each of these is a deferred decision with a reason, not an oversight.

| Not in v0 | Why, and the trigger to add it |
|---|---|
| **Learning, evolution, mutation, reproduction** | v0 is world-building. Brains are hand-wired on purpose, so the policy is a measurable baseline for evolution to beat later |
| **Food patches** | v0 food is uniformly random, which is the minimal rule. But uniform food makes standing still optimal — **this is the first knob to add** once organisms move at all, because patchiness is what makes locomotion worth paying for |
| **Organism condensation** | Organisms spawn whole (R7.1) rather than assembling from the soup. Condensation is more elegant, and R7.3 already contains the mechanism — promoting it to full birth is a small change once the world is stable |
| **Evolvable morphology** | Socket count is fixed at 4 and quadrants are fixed in size. Fill count (1–4), tip types, and rod angles already vary, so shape is not fixed — only the limb budget is. No ceiling on dynamics: membranes, gradients, and healing are all reachable without touching it |
| **Multiple signal channels** | One channel until something needs two |
| **Brain chemistry (`B` in `A`)** | Would let bodies bind to bodies through existing physics — the cheapest route to multicellularity, and therefore worth trying early |
