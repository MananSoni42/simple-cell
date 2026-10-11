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
- The **tent** is where the matrix acts. Note that for `A > 0` the potential minimum
  is at contact (`r_0`), not at the tent's peak: the peak is only where the pull is
  strongest. Spacing and membrane-like structure come from *mixed signs* — types
  that attract each other but repel their own kind.

**R2.2 — Integration.** Free particles (including Food), every tick. `T` is a true
temperature in potential-energy units (Einstein relation, `D = μT`):

```
x ← x + μ·F·dt + sqrt(2·μ·T·dt)·N(0,1)    then wrap into [0, SIZE)
```

Bound limbs are not integrated independently; see R3.3–R3.4.

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

**R3.3 — Rod angles are physics, not decisions.** Split the net force on a tip into
a radial part (along the rod) and a tangential part (across it). The tangential part
swings the rod, overdamped like everything else, and the angle clamps at its quadrant
limits. The radial part is carried by the rigid rod to the brain:

```
θ      ← clamp( θ + (μ·F_tangent + sqrt(2·μ·T)·N(0,1)) / L_rod , quadrant limits )
F_brain += F_radial · r̂           // summed over limbs; the body is pushed as one
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

Two attracting rods do not touch: the hard core holds their tips `≈ r_0` apart, so
they rest `≈ r_0 / L_rod` radians from each other. The `gap` only guarantees that
rods in neighbouring quadrants can never coincide, whatever the forces.

**R3.4 — Movement.** The brain particle moves by `μ·(F_hardcore + F_move + Σ F_radial)
+ Brownian`. Every tip is then placed at `L_rod` from the brain at its angle, so the
body translates as a rigid unit. Only the brain pays the motion cost.

---

## 4. Energy

One Food particle carries `E_food`. Every particle has a reserve, capped at `E_cap`.
The ledger must close exactly: `Σ reserves + Σ food in world + total burned` equals
`initial + total injected`, every tick.

**R4.1 — Sun.** Every `T_food` ticks, one Food particle appears at a uniformly
random position.

**R4.2 — Uptake.** A particle within `r_eat` of a Food particle consumes it: the Food
particle is destroyed and `E_food` is added to the consumer's reserve. If several are
in range, the nearest consumes it. A particle whose reserve would exceed `E_cap`
cannot eat (a limb also needs room in its brain). Free particles eat too. Nothing compels a particle to seek food — whether it
ever meets one is decided by `A` (R1.4).

**R4.3 — The inward toll.** A bound limb keeps `k_keep = 10%` of what it takes in
and passes the remainder **inward** to its brain, one hop per tick. Energy never
teleports.

**R4.4 — Costs.** Every tick, every particle pays; spent energy leaves the world as
heat and is recorded as burned:

| Cost | Amount |
|---|---|
| Upkeep | `c_up` per tick, for brains of live organisms and bound limbs. Free particles are inert and pay nothing |
| Motion | `c_mv · μ · \|F_move\|²`, brains only |
| Signal | `c_sig · \|sig\|` per emitting particle |

**R4.5 — Redistribution.** The brain holds its accumulated reserve and sends a
fraction `releaseFrac` of it back out along the rods each tick, split by the brain's
output (R5.2). A limb accepts only up to `E_ref`; the rest of its share stays in the
brain.

---

## 5. Neurons

Every neuron has the same shape: `out = tanh(W·x)`. **Each newly spawned organism gets
fresh random weights** (Gaussian, from the world's seeded stream). Nothing about its
brain is designed: some organisms will forage, some will wander, some will starve.

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

**R5.3** There is no policy. A "feed the hungriest" brain is one point in weight space;
when learning arrives, it is the baseline to beat, not a rule of the world.

---

## 6. Signals

**R6.1** Signal is a decaying scalar **field** on a coarse toroidal grid, not a
particle. A signal particle would need to be massless, chemically inert, and
self-destroying — three exceptions to the laws. A field is one rule.

**R6.2** Each tick: limbs deposit `max(0, sig)` into the cell under them, the
field diffuses once (5-point stencil), then decays by `λ`. Every neuron reads the
cell under it.

This is the only channel between organisms. Influence is stigmergic — written into a
shared medium — so there is no messaging code and no concept of "nearby organism".

---

## 7. Creation and destruction

**R7.1 — Organism spawn.** Every `T_spawn` ticks, one organism appears at a uniformly
random position: a random free brain plus **1 to 4 filled sockets** (count chosen
uniformly), each taking a random free intrinsic particle (not in cooldown), in a
random distinct quadrant, at a random angle within it. Each chosen particle's reserve
is topped up to `E_init`; that energy is created by the spawn and counted as injected
(a second source of energy alongside the sun, so extinction is never permanent). If
the free pool is short, fewer sockets are filled. Organisms are therefore born asymmetric and incomplete, and
R7.3 lets them finish growing from the soup.

**R7.2 — Limb death.** A limb whose reserve reaches 0 **unbinds** and becomes a free
particle again, in cooldown for `cooldown` ticks. The organism carries on with an empty socket.

**R7.3 — Regeneration.** An empty socket captures any free intrinsic particle with
energy `> 0`, not in cooldown, lying
within its own quadrant and within `r_bind` of the rod circle (`|r − L_rod| <
r_bind`, measured from the brain). The particle snaps to `L_rod` and the new rod
takes the angle the particle already had. A socket's capture zone is therefore an
arc, not a point — a body reaches for whatever drifts past the right part of it.

This is the *only* other way a socket gets filled, and it is why healing costs no
extra code: regeneration is binding, running again on a body that already exists.

**R7.4 — Organism death.** A brain whose reserve reaches 0 dissolves: all limbs unbind
(each keeping its own reserve) and the brain becomes a free particle. Corpse-as-food
is deferred.

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
**Initial conditions** are everything the start screen shows, and **every one of them
is a pure function of the seed**: same seed, same world, down to the last tick.

### Laws

| | | |
|---|---|---|
| `SIZE` | 300 | world edge length (small and dense on purpose: everything is visible) |
| `dt` | 1 | tick |
| `mu` | 0.5 | mobility |
| `r_c` | 40 | interaction cutoff |
| `beta` | 0.1 | core fraction → `r_0 = 4` |
| `K_core` | 3.0 | hard-core strength; must exceed `max|A| = 1` |
| `L_rod` | 16 | rod length |
| `gap` | 0.12 rad | angular gap between quadrants (≈7°) |
| `r_bind` | 6 | socket capture tolerance around the rod circle |
| `r_eat` | 6 | uptake radius |
| `cooldown` | 20 | ticks before an unbound limb can be recaptured |
| `E_food` | 10 | energy per food particle |
| `E_cap` | 100 | reserve capacity |
| `E_ref` | 50 | neuron normalization scale; limbs accept brain energy up to this |
| `E_init` | 30 | reserve a particle is topped up to when spawned into an organism |
| `c_up` | 0.02 | upkeep / organism particle / tick |
| `c_mv` | 0.1 | motion cost coefficient |
| `c_sig` | 0.01 | signal cost coefficient |
| `k_keep` | 0.1 | fraction a limb keeps |
| `releaseFrac` | 0.05 | fraction of brain reserve sent outward per tick |
| `F_max` | 1.0 | max brain move force |
| `lambda` | 0.05 | signal decay |
| `D_sig` | 0.2 | signal diffusion |
| `fieldN` | 64 | signal grid resolution |

### Initial conditions — derived from the seed

| | | |
|---|---|---|
| `A` | uniform in `[-1, 1]`, symmetric, `Food×Food = 0` | the chemistry; the main dial |
| `T` | log-uniform `1 … 40` | temperature |
| `foodMode` | `random` · `patchy` · `gradient` | see below |
| `T_food` | 2 … 6 | ticks between food injections |
| `T_spawn` | 60 … 140 | ticks between organism spawns |
| `n_intrinsic` | 30 … 50 | conserved matter pool (types assigned uniformly at random). **Editable** |
| `n_brain` | 4 | conserved brain pool, hence the cap on live organisms. **Editable** |
| `n_start` | 1 … 2 | organisms present at tick 0. **Editable** |
| `n_food0` | 30 | food present at tick 0. **Editable** |
| `max_food` | 120 | the sun pauses while this much food is in the world |
| `n_patch, r_patch, v_patch` | 1…3, 35…65, 0.05…0.2 | only for `patchy` |

**Food modes.** All three place one Food particle per injection; they differ only in
*where*:

- **random** — uniform over the torus. Standing still is optimal.
- **patchy** — `n_patch` discs of radius `r_patch` wander slowly (heading drifts, speed
  `v_patch`); each injection picks a patch uniformly, then a point inside it. Rewards
  following the food.
- **gradient** — density `∝ ((1 + cos(2πx/SIZE))/2)²`: one sunlit band along x.

**Stability constraint.** Overdamped Euler is stable while `μ·|F|_max·dt ≪ r_0`.
With these numbers, `μ·K_core·dt = 1.5` against `r_0 = 4`. Raising `μ` or `K_core`
without lowering `dt` lets particles tunnel through each other.

---

## 10. Interface

**Start screen.** Shows the 5 × 5 matrix as a heatmap and the seed-derived parameters,
all read-only: the chemistry is frozen. Two kinds of input:

- the **seed** (type one, or press `R` to re-roll), which fixes everything above;
- the **starting population** — particles, brains, organisms at start, food at start.
  These default from the seed and can be overridden; changing the seed resets them.

**`Enter` enters the world.**

**World screen.**

- **Tick meter**, default **1 tick / second**. `←` / `→` step the rate through
  `0.25, 0.5, 1, 2, 5, 10, 30, 60, max` ticks/sec. `Space` pauses. `.` single-steps.
  `Esc` returns to the start screen.
- **Stats panel** with sparklines for organisms, food and total energy, plus: born /
  died / oldest / record lifespan, limbs per organism, the energy split (in organisms,
  in free particles, in food) and cumulative burned, and the largest connected cluster
  (particles touching, `r < 2.5 r_0`, with a brain always joined to its limbs).
- **Rendering:** flat shapes only — circles for P1–P4 (coral, amber, mint, blue), a
  white square for a brain, a lime diamond for food. Free particles are smaller and
  translucent; bound limbs are full size with brightness following energy. Each
  organism has a thick rod per limb and a faint disc marking its body. Between ticks
  the renderer interpolates positions, so slow rates glide instead of jumping.

---

## 11. Deliberately not in v0

Each of these is a deferred decision with a reason, not an oversight.

| Not in v0 | Why, and the trigger to add it |
|---|---|
| **Learning, evolution, mutation, reproduction** | v0 is world-building. Brain weights are random per organism so that nothing about a brain is designed |
| **Organism condensation** | Organisms spawn whole (R7.1) rather than assembling from the soup. R7.3 already contains the mechanism — promoting it to full birth is a small change once the world is stable |
| **Corpse food** | Dissolved organisms leave their limbs' energy in free particles instead of dropping Food. Add it when trophic levels are wanted |
| **Evolvable morphology** | Socket count is fixed at 4 and quadrants are fixed in size. Fill count (1–4), tip types, and rod angles already vary |
| **Multiple signal channels** | One channel until something needs two |
| **Brain chemistry (`B` in `A`)** | Would let bodies bind to bodies through existing physics — the cheapest route to multicellularity, and therefore worth trying early |
