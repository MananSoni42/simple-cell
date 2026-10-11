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

**R1.4a — Quantized bonds.** The non-food 4×4 block is snapped to
`{−1, −0.5, −0.25, 0, 0.25, 0.5, 1}` by default (`quantized`). This is not a stability measure —
the magnitudes are unchanged — it makes chemistries repeatable and comparable, and the matrix
editable by eye. The Food row stays continuous.

**R1.4b — Food couples at half strength.** Every Food entry is multiplied by
`food_coupling = 0.5` at force time, biasing the world toward particle-to-particle structure
rather than food-chasing. The matrix itself stays uniform in `[-1, 1]`.

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
r < r_core  →   F = K · (1 − r_core/r)                            [repulsive, diverges at contact]
r_core ≤ r ≤ r_c → F = A[i][j] · (1 − |2u − 1 − β| / (1 − β))     [tent, u = r/r_c, β = r_core/r_c]
r > r_c     →   F = 0
```

`r_core` depends on the pair, because a brain carries a body:

| pair | exclusion radius | strength |
|---|---|---|
| two ordinary particles | `r_0 = β·r_c = 10` | `K_core` |
| one of them a brain | `r_brain_core = 8` | `K_brain` |
| **both brains** | `r_brain = 16` | `K_brain` |

Positive `F` attracts. Force acts along the minimum-image separation vector. Two
terms with two distinct jobs:

- The **hard core** is universal and not in the matrix, and it **diverges as `r → 0`**. That
  matters: a *bounded* core can be out-pulled by enough attracting neighbours, and particles then
  end up squeezed into the same point. Measured — with a linear core, free particles reached 0.01
  units apart; with this one they hold about 2 units on a 10-unit core.
- The **tent** is where the matrix acts. Note that for `A > 0` the potential minimum
  is at contact (`r_0`), not at the tent's peak: the peak is only where the pull is
  strongest. Spacing and membrane-like structure come from *mixed signs* — types
  that attract each other but repel their own kind.

**R2.2 — Integration.** Free particles, every tick. Food is included only when `foodMoves` is on; otherwise it sits where it landed (it still pulls and pushes others). `T` is a true
temperature in potential-energy units (Einstein relation, `D = μT`):

```
x ← x + μ·F·dt + sqrt(2·μ·T·dt)·N(0,1)    then wrap into [0, SIZE)
```

Bound limbs are not integrated independently; see R3.3–R3.4.

**R2.6 — Sub-stepping.** A tick may be split into `substeps` smaller moves that reuse the same
forces. Brownian increments are independent, so each is `sqrt(n)` smaller while the total
diffusion is unchanged, and the force is applied in `n` pieces. Seeded worlds pick the smallest
count that satisfies R2.4's budget, and editing the temperature raises it to suit. This is how a
hot world keeps working: exclusion needs each *move* to be small compared with a particle, not
merely bounded.

**R2.4 — Motion budget (discrete-time guardrail).** Time is discrete, so a step long enough to
cross a particle would defeat exclusion entirely. Three hard bounds, every tick:

- forces and noise move any particle at most `d_max = 5` per tick, half a core radius (and
  `d_max / substeps` per sub-step) — direction is kept, only the length is cut;
- a Brownian draw is clamped to `z_max = 3` sigma, so no rare tail can teleport anything;
- a rod swings at most `dth_max = 0.25` rad.

A brain may then be pushed up to `d_max` further by R2.5. So a free particle moves ≤ 5 (well
inside `r_0 = 10`: **nothing can tunnel**), a brain ≤ 10, and a limb ≤ 14 as it both rides its
brain and swings. The clamp is meant to be a backstop: the stats panel reports how often it
bites, and if that is more than a few percent the world is too hot (R1.3).

**R2.5 — Organisms keep their distance.** After integrating, any two brains closer than
`r_brain` are pushed apart along their separation (at most `d_max` per tick each). This is a
*constraint*, not a force, because repulsion alone cannot hold: a limb attracted to a neighbour
drags its own brain inward and the step clamp carries it there. New organisms are also placed
`r_brain` clear of every existing body — an overlapping spawn would stay tangled for hundreds of
ticks. Organisms can still touch and bond: through their limbs, which is the point.

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
| Free decay | a free particle loses `decay_free` of its reserve each tick (default 0.2%, half-life ≈ 350 ticks); the tail below 0.01 snaps to zero. Bound particles and food are exempt. Burned, so the ledger stays exact |

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
x = for each of 4 sockets: [ msg_i , onehot4(type_i) , alive_i , food_i ]   // 28
  ⧺ [ reserve/E_ref , signal_here , 1 ]                                     //  3
  ⧺ [ tanh(food pull x) , tanh(food pull y) ]                               //  2
y = W_brain · x                                                             // 33 → 6

food split = softmax(y[0..3])        // how to divide releaseFrac among sockets
F_move     = F_max · tanh(y[4..5])   // where to go
```

**R5.4 — The brain can see food.** Two additions beyond the limb messages: each socket's own
food count, and the **net pull toward food on the whole body** as a vector. The force pass
already computes that pull, so it costs nothing, and it carries a *direction* — which makes
chemotaxis one weight rather than something to infer from four scalars.

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
energy `≥ E_viable` (1), not in cooldown, lying
within its own quadrant and within `r_bind` of the rod circle (`|r − L_rod| <
r_bind`, measured from the brain). The particle snaps to `L_rod` and the new rod
takes the angle the particle already had. A socket's capture zone is therefore an
arc, not a point — a body reaches for whatever drifts past the right part of it.

This is the *only* other way a socket gets filled, and it is why healing costs no
extra code: regeneration is binding, running again on a body that already exists.

**R7.4 — Organism death.** A brain whose reserve reaches 0 dissolves: all limbs unbind
(each keeping its own reserve) and the brain becomes a free particle. Corpse-as-food
is deferred.

**R7.6 — Continuous inflow (option).** With `inflow` on, matter is no longer conserved
and the pool no longer limits organisms. Each spawn (R7.1) activates *fresh* particles —
a new brain and 1–4 new limbs, each endowed with `E_init` (counted as injected) — in
slots reserved for them: brain capacity is `3 × n_brain`, with room for four limbs per
brain. In exchange all matter becomes mortal: free particles pay `c_up` too, and any
particle whose reserve reaches 0 vanishes (its slot returns to the pool, residue
burned). Organisms therefore keep arriving and keep dying, instead of the world
filling up and freezing once every brain is in use.

**R7.7 — Budding (option, on by default).** A brain with reserve `≥ E_repro` and no
cooldown may reproduce, if it can pay and there is room. The child gets one limb per
limb the parent currently has, of the same type and angle, taken from free particles of
that type (pool mode) or from fresh slots (continuous inflow). Every particle of the
child is topped up to `E_birth` (15), and **that energy is taken from the parent**, who must
keep at least `E_hold`. Nothing is injected. The child appears `repro_dist` away,
inherits the parent's brain weights plus Gaussian noise of std `repro_mut`, and
records `parent` and `generation = parent + 1`. Parent and child wait `repro_cooldown`
ticks. In pool mode the supply of free brains and free limbs of the right type limits
the population; reproduction is decoupled from everything else and costs nothing when off.

**R7.5 — Matter is conserved** *(default, `inflow` off).* Intrinsic and brain particles are allocated once at
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
| `SIZE` | 300 × scale | world edge length. Counts and rates below scale with area, so density is constant |
| `dt` | 1 | tick |
| `mu` | 0.5 | mobility |
| `r_c` | 40 | interaction cutoff |
| `beta` | 0.25 | core fraction → `r_0 = 10` |
| `K_core` | 3.0 | hard-core strength; must exceed `max|A| = 1` |
| `r_brain_core` · `r_brain` · `K_brain` | 8 · 16 · 12 | a brain's body radius against anything, against another brain, and its strength |
| `food_coupling` | 0.5 | scales every Food row/column entry |
| `d_max` · `dth_max` · `z_max` | 5 · 0.25 · 3 | motion budget (R2.4) |
| `substeps_max` | 16 | cap on automatic sub-stepping (R2.6) |
| `life_window` · `life_buckets` | 10000 · 100 | trailing window for mean-lifespan reporting |
| aggregate sampling · stable age | every 10 ticks · 300 ticks | organism-contact sampling, and how old a bond must be to count as lasting (R8) |
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
| `fieldN` | 64 × scale (max 256) | signal grid resolution |
| `E_repro` · `E_hold` · `E_birth` | 60 · 20 · 15 | budding threshold; reserve a parent must keep; reserve each child particle starts with |
| `E_viable` | 1 | minimum reserve for a free particle to be captured as a limb |
| `repro_cooldown` · `repro_dist` | 80 · 42 | ticks between buds; child placement distance |

### Initial conditions — derived from the seed

| | | |
|---|---|---|
| `A` | uniform in `[-1, 1]`, symmetric, `Food×Food = 0` | the chemistry; the main dial |
| `T` | log-uniform `1 … 4` | temperature. Capped by the R2.4 budget: `sqrt(2·μ·T)` must stay under a fifth of `r_0`. Hotter worlds can be typed in and are flagged on the start screen; a true gas phase needs sub-stepping, which we have not built |
| `foodMode` | `random` · `patchy` · `gradient` | see below |
| `T_food` | 2 … 6 | ticks between food injections |
| `T_spawn` | 60 … 140 | ticks between organism spawns |
| `n_intrinsic` | 30 … 50 | conserved matter pool (types assigned uniformly at random). **Editable** |
| `n_brain` | 4 | conserved brain pool, hence the cap on live organisms. **Editable** |
| `n_start` | 1 … 2 | organisms present at tick 0. **Editable** |
| `n_food0` | 30 | food present at tick 0. **Editable** |
| `max_food` | 120 | the sun pauses while this much food is in the world |
| `scale` | 1 | world edge multiplier (1, 2, 4 … 32). Counts × scale², and each injection / spawn event repeats scale² times. **Editable** |
| `decay_free` | 0.2% / tick | free-particle decay. **Editable** (0 = off) |
| `foodMoves` | off | food drifts and responds to forces. **Editable** |
| `repro` · `repro_mut` | on · 0.05 | budding (R7.7) and mutation std. **Editable** (on/off) |
| `inflow` | off | continuous organism inflow (R7.6). **Editable** |
| `quantized` | on | snap the 4×4 to the bond set (R1.4a). **Editable** |
| `substeps` | from `T` | integration sub-steps (R2.6). **Editable**, with an auto button |
| `n_patch, r_patch, v_patch` | 1…3, 35…65, 0.05…0.2 | only for `patchy` |

**Food modes.** All three place one Food particle per injection; they differ only in
*where*:

- **random** — uniform over the torus. Standing still is optimal.
- **patchy** — `n_patch` discs of radius `r_patch` wander slowly (heading drifts, speed
  `v_patch`); each injection picks a patch uniformly, then a point inside it. Rewards
  following the food.
- **gradient** — density `∝ ((1 + cos(2πx/SIZE))/2)²`: one sunlit band along x.

**Stability budget.** Three quantities have to hold at once, and the start screen shows all
three, amber when one is breached:

```
noise step    sqrt(2·μ·T/n) ≤ 0.1 · r_0     (n = substeps)
force step    μ·K_core/n     ≤ 0.35 · r_0
structure     T              ≤ bond depth ≈ r_c·(1−β)/2 = 15
```

The first two are about *numerical safety* — steps short enough that exclusion holds — and
sub-stepping fixes them. The third is the melting point, which sub-stepping does **not** move: a
world hotter than one bond is legitimately melted, not broken, so the start screen reports it as
information rather than a fault.

**Known limit.** The melting transition is weak in practice: measured mean cluster size falls
only from 12 (T=3) to 6.7 (T=120) against an unbonded baseline of 2.4. A genuine gas phase is
still missing.

Before this was enforced, mid-range temperatures moved particles further than their own
diameter on about half of all ticks: exclusion failed, brains sat 0.3 units apart, and nothing
stayed assembled. R2.4 and R2.5 are the enforcement; this table is the budget.

---

## 10. Interface

**Start screen.** Shows the 5 × 5 matrix as a heatmap and the seed-derived parameters,
all read-only: the chemistry is frozen. Two kinds of input:

- the **seed** (type one, or press `R` to re-roll), which fixes everything above;
- the **starting population** — particles, brains, organisms at start, food at start;
- the **chemistry matrix** itself: drag a cell vertically, use the arrow keys, or double-click to
  type. Edits mirror across the diagonal (the matrix is symmetric by law), clamp to `[-1, 1]`,
  and snap to the bond set while `quantized` is on. Food×Food stays 0;
- **temperature** and **free-particle decay**, with the stability budget shown live;
- **export / import**: download the config as JSON, copy it, or load one back. The whole config
  also lives in the URL hash, so a world is a link.

All of these default from the seed; re-rolling or retyping the seed resets them.

**World options** (all editable): scale, reproduction, food drifts, continuous inflow.

**Compute** (editable): thread count (1 … cores) and **GPU forces**. They change only
*where* pair forces are computed, never what the world does (see below).

**`Enter` enters the world.**

**World screen.**

- **Controls** (buttons along the bottom, with keys): **Start** resumes, **Pause** holds
  (`Space` toggles), **Stop** discards the world and returns to the start screen (`Esc`),
  **0.5×** / **2×** halve or double the speed (`←` / `→`) between 1/8 and **8192** ticks/s.
  The default is **1 tick / second**; the panel also shows the rate actually achieved.
  `.` single-steps.
- **Camera:** wheel zooms about the cursor (up to 80×), drag pans, double-click resets.
  Only what is on screen is drawn, and particles smaller than a pixel become dots.
- **Mean lifespan** as a two-line graph — particles and organisms — of the average completed
  lifespan per bucket over a trailing `life_window` (10k ticks, 100 buckets). Gaps are left
  where nothing died in a bucket rather than bridged. The all-time
  `min / median / mean / p90 / max` is printed underneath. A particle is *live* while it is
  active with reserve `> 0`: a life starts when it is spawned or refed from empty and ends when
  it runs dry, and a slot that dies and is reborn in the same tick counts as two lives.
- **Lineages**: a spawned organism founds a lineage and its descendants inherit it. The panel
  shows lineages alive, the biggest one, children produced, the most by any one organism, and
  the oldest and record ages.
- **Stats panel** with sparklines for organisms, food and total energy, plus: born /
  died / budded, free matter, limbs per organism, the energy split (in organisms, in free
  particles, in food), cumulative burned, and how often the motion clamp bit
- **Rendering:** flat shapes only — circles for P1–P4 (coral, amber, mint, blue), a
  square for a brain, a lime diamond for food. Free particles are smaller and
  translucent. Each organism has a thick rod per limb and a faint disc marking its
  body. **Energy is drawn on the organism:** a brain is a gauge that fills from the
  bottom, a limb is a dim disc with a bright core that grows with its reserve, and
  either turns red when nearly empty. Between ticks the renderer interpolates, and it
  rebuilds every limb from its brain's interpolated position and angle, so rods and
  tips always move as one rigid body.

---

## 11. Deliberately not in v0

Each of these is a deferred decision with a reason, not an oversight.

| Not in v0 | Why, and the trigger to add it |
|---|---|
| **Learning and selection design** | Paused. Budding with mutation exists so lineages can be watched, but nothing steers it: no learning rules, no recombination, no evolved reproduction timing |
| **Organism condensation** | Organisms spawn whole (R7.1) rather than assembling from the soup. R7.3 already contains the mechanism — promoting it to full birth is a small change once the world is stable |
| **Corpse food** | Dissolved organisms leave their limbs' energy in free particles instead of dropping Food. Add it when trophic levels are wanted |
| **Evolvable morphology** | Socket count is fixed at 4 and quadrants are fixed in size. Fill count (1–4), tip types, and rod angles already vary |
| **Multiple signal channels** | One channel until something needs two |
| **Brain chemistry (`B` in `A`)** | Would let bodies bind to bodies through existing physics — the cheapest route to multicellularity, and therefore worth trying early |

---

## 12. Compute backends

Pair forces are the only part of a tick that grows with the number of particles times
their neighbours, so they alone are pluggable (`ForceBackend`). Everything else — grid
build, integration, energy, organisms — runs on the main thread.

| Backend | How | Notes |
|---|---|---|
| serial | one loop over all particles | default; bit-exact; used by the test suite |
| threads | Web Workers share the world's memory (`SharedArrayBuffer`); the main thread computes one slice | identical results to serial; needs the page to be cross-origin isolated (the dev server sets the headers) |
| GPU | WebGPU compute kernel; the CPU uploads positions and cell grid, reads back one force per particle | single precision: matches serial to ~1e-4 relative, not bit-exact |

All three run the same per-particle kernel (`forcekernel.ts` and its WGSL port), where
each particle sums over *all* its neighbours. That is what makes the work splittable
with no write conflicts. Measured on an Apple M4 Pro (14 cores), see `bench.html`:

| World | Particles + food | serial | 14 threads | GPU |
|---|---|---|---|---|
| 8× (2400²) | ~11k slots | 597 tick/s | 920 tick/s | 625 tick/s |
| 16× (4800²) | ~44k slots | 145 tick/s | 292 tick/s | 186 tick/s |
| 32× (9600²) | ~176k slots | 35 tick/s | 71 tick/s | 68 tick/s |

Speedup is about 2×, not 14×: the non-force part of a tick (about half the time) is
still serial. Small worlds are faster on the serial backend.

---

## 13. Organism aggregates

Two organisms are **in contact** when any of their limbs are within `2.5·r_0`. Contacts are
sampled every 10 ticks and the tick each pair first appeared is remembered, so a contact has an
**age**. An **aggregate** is a connected group of two or more organisms; a **lasting** aggregate
uses only bonds older than 300 ticks. That is what turns "always connected" into a tunable
number instead of a word.

Reported in the stats panel: groups now, the biggest group's sub-organism count, the mean,
how many organisms are joined, total and lasting bonds, the biggest lasting group, and the oldest
bond's age. Measured in a crowded world: 3 groups, biggest 5 sub-organisms, 2 lasting groups,
oldest bond 870 ticks.

Because brains are held `r_brain` apart (R2.5), every one of these is mediated by limbs — a
genuine particle-to-particle join, not two bodies occupying the same place.

---

## 14. Rewind

One primitive does the work: a **snapshot** is the complete world — every per-particle array, the
scalars, the brain weights, the patches, the signal field, the food free-list, the RNG position
and the lineage counter. Restoring one reproduces not just the same state but the **same
future**, which is the test: a restored world and the original run 400 more ticks and still hash
identically.

The simulation worker keeps a ring of snapshots. Two things keep it affordable: the buffers are
**allocated once and overwritten in place**, and the sampling interval is derived from the *tick
rate* so the world takes ~20 snapshots per second of wall clock however fast it is running.
Both matter — allocating one per tick produced 0.5–3.5 GB/s of garbage at high rates and could
bring the tab down. Measured at the 8192 ticks/s cap: 20 snapshots/s, under 2% of a core,
and no garbage at all.

The world screen has a rewind button, a scrub slider over the held history, and
`Backspace`/`J`; the panel shows how many ticks are held.

The same primitive is what state save/load and long-run checkpointing will be built on.

---

## 15. The explainer page

"How it works" on the start screen (`H`) draws the whole model on one page: the body plan and its
quadrants, the chemistry matrix and the hard core, both neurons with every input and output
labelled, the energy path, the life cycle, and why time is clamped. Everything on it is generated
from the live constants, so it cannot drift away from the rules.
