import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GOLDEN, runGolden } from './golden'

const file = new URL('./golden.json', import.meta.url)

describe.skipIf(!existsSync(file))('golden worlds', () => {
  const pinned = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  for (const c of GOLDEN) {
    it(`${c.name} ends in exactly the pinned state`, () => {
      expect(runGolden(c)).toEqual(pinned[c.name])
    })
  }
})
