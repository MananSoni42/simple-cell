import { describe, expect, it } from 'vitest'
import { CHEMISTRIES, WORLD_KINDS, buildRecipe, randomRecipe } from '../src/ui/recipes'
import { FOOD_ROW, N_MATRIX } from '../src/core/types'
import { QUANTA, stability } from '../src/core/params'
import { World } from '../src/core/world'

/**
 * The picker promises that two chips plus a seed give a world that is *characteristic* and *sound*.
 * Both halves are testable: the matrix has to obey the laws every matrix obeys, the world has to be
 * inside its stable range, and two seeds of the same character have to differ.
 */
describe('a world from two dials', () => {
  it('builds every combination into a world that can actually run', () => {
    for (const c of CHEMISTRIES) {
      for (const k of WORLD_KINDS) {
        const init = buildRecipe({ chemistry: c.key, world: k.key, seed: 11, scale: 1 })
        const s = stability(init)
        expect(s.ok, `${c.key}/${k.key} moves ${s.sigma.toFixed(2)} per sub-step`).toBe(true)
        const w = new World(init)
        for (let i = 0; i < 50; i++) w.step()
        for (let i = 0; i < w.cap; i++) {
          expect(Number.isFinite(w.x[i]) && Number.isFinite(w.y[i])).toBe(true)
        }
      }
    }
  })

  it('keeps every matrix symmetric, quantized, and zero on food-food', () => {
    for (const c of CHEMISTRIES) {
      for (const seed of [1, 2, 99, 12345]) {
        const A = buildRecipe({ chemistry: c.key, world: 'patchy', seed, scale: 1 }).A
        expect(A[FOOD_ROW][FOOD_ROW]).toBe(0)
        for (let i = 0; i < N_MATRIX; i++) {
          for (let j = 0; j < N_MATRIX; j++) {
            expect(A[i][j]).toBe(A[j][i])
            expect(QUANTA as readonly number[]).toContain(A[i][j])
          }
        }
      }
    }
  })

  it('gives different worlds for different seeds, and the same world for the same seed', () => {
    const one = buildRecipe({ chemistry: 'sticky', world: 'patchy', seed: 4, scale: 1 })
    const same = buildRecipe({ chemistry: 'sticky', world: 'patchy', seed: 4, scale: 1 })
    const other = buildRecipe({ chemistry: 'sticky', world: 'patchy', seed: 5, scale: 1 })
    expect(JSON.stringify(one.A)).toBe(JSON.stringify(same.A))
    // the whole point of a character rather than a preset: re-rolling has to change something
    const varied = new Set(
      Array.from({ length: 12 }, (_, i) => JSON.stringify(buildRecipe({ chemistry: 'sticky', world: 'patchy', seed: i + 1, scale: 1 }).A)),
    )
    expect(varied.size).toBeGreaterThan(3)
    expect(one.seed).not.toBe(other.seed)
  })

  it('each chemistry really has the character it claims', () => {
    const matrixFor = (key: string, seed: number): number[][] => buildRecipe({ chemistry: key, world: 'patchy', seed, scale: 1 }).A
    const matterPairs = (A: number[][]): number[] => {
      const out: number[] = []
      for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) out.push(A[i][j])
      return out
    }
    for (const seed of [3, 17, 404]) {
      // clumpy: matter attracts matter nearly everywhere
      const clumpy = matterPairs(matrixFor('clumpy', seed))
      expect(clumpy.filter((v) => v > 0).length).toBeGreaterThan(clumpy.length / 2)
      // skittish: the opposite, with at most a couple of exceptions
      const skittish = matterPairs(matrixFor('skittish', seed))
      expect(skittish.filter((v) => v < 0).length).toBeGreaterThan(skittish.length / 2)
      // sticky: self-repulsion is what spreads matter into sheets rather than balls
      const sticky = matrixFor('sticky', seed)
      expect([0, 1, 2, 3].some((i) => sticky[i][i] < 0)).toBe(true)
      // hungry: every kind chases food
      const hungry = matrixFor('hungry', seed)
      expect([0, 1, 2, 3].every((i) => hungry[i][4] > 0)).toBe(true)
    }
  })

  it('never rolls the two characters that make a dull first world', () => {
    for (let seed = 0; seed < 300; seed++) {
      const r = randomRecipe(seed)
      expect(r.chemistry).not.toBe('random')
      expect(r.chemistry).not.toBe('skittish')
      expect(r.world).not.toBe('plenty')
      expect(r.scale).toBe(1)
    }
    const drawn = new Set(Array.from({ length: 60 }, (_, i) => `${randomRecipe(i).chemistry}/${randomRecipe(i).world}`))
    expect(drawn.size).toBeGreaterThan(6)
  })

  it('sets food so that a world is neither starving nor saturated by accident', () => {
    for (const k of WORLD_KINDS) {
      const init = buildRecipe({ chemistry: 'sticky', world: k.key, seed: 8, scale: 1 })
      expect(init.n_food0).toBeLessThanOrEqual(init.max_food)
      expect(init.n_start).toBeGreaterThan(0)
      expect(init.n_start).toBeLessThanOrEqual(init.n_brain)
    }
  })
})
