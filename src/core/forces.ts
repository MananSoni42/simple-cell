import type { Laws } from './params'

/** Radial pair force at distance r with matrix entry a. Positive = attraction. */
export function pairForce(r: number, a: number, L: Laws): number {
  const u = r / L.r_c
  if (u >= 1) return 0
  if (u < L.beta) return L.K_core * (u / L.beta - 1)
  return a * (1 - Math.abs(2 * u - 1 - L.beta) / (1 - L.beta))
}

/** Pair potential with U(r_c) = 0 and F = -dU/dr. Exact: F is piecewise linear. */
export function pairPotential(r: number, a: number, L: Laws): number {
  const rc = L.r_c
  const bp = [0, L.beta * rc, ((1 + L.beta) / 2) * rc, rc]
  let U = 0
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(bp[k], r)
    const hi = bp[k + 1]
    if (hi <= lo) continue
    U -= 0.5 * (pairForce(lo, a, L) + pairForce(hi, a, L)) * (hi - lo)
  }
  return U
}
