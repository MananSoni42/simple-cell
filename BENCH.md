# Benchmarks

Machine: Apple M4 Pro (14 cores), 48 GB, Chrome (headless). Numbers are per tick on a
warmed-up world (seed 3, 150 ticks in), default options. Two tools:

- `npm run profile -- 8 16 32` — single-thread cost of each phase, in Node.
- `bench.html?scale=16&ticks=12` — each force backend in the browser, checked against the serial kernel.

Correctness gate for pure optimizations: `npm test` includes `tests/golden.test.ts`, which pins six
worlds bit-for-bit (`tests/golden.json`, rewritten with `npm run golden`).

## Baseline (after free-particle decay, before optimization)

Single thread, ms per tick (Node):

| Scale | Live of slots | Total | Forces | Uptake | Integrate | Grid builds | Field | Other |
|---|---|---|---|---|---|---|---|---|
| 8× | 4.8k / 11k | 2.79 | 1.74 | 0.32 | 0.25 | 0.15 | 0.20 | 0.13 |
| 16× | 19k / 44k | 10.82 | 7.67 | 1.36 | 0.91 | 0.51 | 0.19 | 0.18 |
| 32× | 77k / 176k | 45.38 | 31.90 | 6.06 | 3.81 | 2.26 | 0.24 | 1.11 |

Browser backends, ticks per second:

| Scale | serial | 2 threads | 4 | 8 | 14 | GPU |
|---|---|---|---|---|---|---|
| 8× | 611 | 601 | 828 | 937 | 1064 | 727 |
| 16× | 148 | 150 | 201 | 270 | 311 | 259 |
| 32× | 35 | 36 | 52 | 67 | 79 | 78 |

Observations that drive the optimization plan: forces are ~70% of a serial tick at ~27 ns per
candidate pair; two threads barely beat serial because the contiguous index split puts almost all
live particles in the first slice; and the app itself reaches far fewer ticks/s than the benchmark
because stepping shares each frame with drawing.

## After phase 1 (bit-exact: packed cell-ordered kernel, static food skipped, matter-first uptake)

All six golden worlds still end in exactly the same state.

Single thread, ms per tick (Node):

| Scale | Total | was | Forces | was | Uptake | was |
|---|---|---|---|---|---|---|
| 8× | 1.85 | 2.79 | 0.88 | 1.74 | 0.18 | 0.32 |
| 16× | 6.42 | 10.82 | 3.61 | 7.67 | 0.73 | 1.36 |
| 32× | 25.90 | 45.38 | 14.27 | 31.90 | 3.17 | 6.06 |

Browser, 16×, ticks per second: serial 148 → 215, 2 threads 150 → 296, 4 → 350, 8 → 392,
14 → 395 (was 311). Threads now split evenly because the kernel runs over the dense list of live
particles instead of raw slot indices.

## After phase 2 (simulation in its own worker, triple-buffered frames)

The page now only draws; results are bit-identical (the core is untouched). Ticks per second the
app actually sustains (requested rate maxed), measured from the stats panel:

| World | Threads | Before | After |
|---|---|---|---|
| 8× | 8 | 238 | 624 |
| 16× | 14 | – | 174 (1024 organisms, 27k food) |
