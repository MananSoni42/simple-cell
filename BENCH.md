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
