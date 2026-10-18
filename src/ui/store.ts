import type { OrganismFile } from '../core/organism'
import type { Init } from '../core/params'

/**
 * The collection: runs that happened and organisms kept from them, persisted across visits.
 *
 * IndexedDB rather than localStorage, because the point of a collection is that it accumulates
 * and localStorage's few megabytes would break exactly when it became worth having. But browser
 * storage is per-browser, can be cleared by its owner and evicted under pressure, so the whole
 * collection can be written to a file and read back — without that, someone loses months of
 * organisms to a cleared cache.
 */

const DB = 'simplecell'
/**
 * Version 2 starts the collection over.
 *
 * The organisms and runs kept under version 1 were produced by a world whose laws have since
 * changed in ways that make them incomparable: four bonds per particle rather than two, energy
 * moving along bonds, a different brain initialisation, a population set by the ecology, and a
 * ladder whose thresholds are measured in the world's own units. A saved organism from before all
 * that is not a worse organism, it is an organism from a different world — and keeping it in the
 * same list would invite exactly the comparison that cannot be made. The upgrade therefore drops
 * both stores and recreates them.
 */
const VERSION = 3
const RUNS = 'runs'
const ORGANISMS = 'organisms'
const CHECKPOINTS = 'checkpoints'

export interface StoredRun {
  id: string
  savedAt: number
  /** The world, complete enough to run again. */
  init: Init
  ticks: number
  observations: string[]
  /** The hero numbers, kept flat so a list can be rendered without unpacking a run record. */
  summary: {
    organisms: number
    births: number
    budded: number
    deaths: number
    recordAge: number
    bestOrder: number
    bestOrderAge: number
    burned: number
    injected: number
    peakOrganisms: number
    lineages: number
    maxGen: number
  }
  /** A few series, downsampled, so a run can show a shape without storing everything. */
  spark?: { organisms: number[]; food: number[] }
  organismIds: string[]
}

export interface StoredOrganism {
  id: string
  savedAt: number
  name: string
  /** Why it was kept: 'oldest', 'most children', 'most time joined', or 'by hand'. */
  label: string
  runId?: string
  organism: OrganismFile
}

/**
 * A world's state at one tick, saved automatically as a run passes each checkpoint interval.
 *
 * The state lives in `buffer` as raw bytes rather than JSON, which is what makes this affordable:
 * IndexedDB stores an `ArrayBuffer` natively, and the same buffer is *transferred* from the
 * simulation worker instead of being copied, so saving a 20 MB checkpoint does not stall the world.
 *
 * `world` is the identity of the configuration, not of the run. That is on purpose — re-running the
 * same world should offer the checkpoints its earlier runs left behind, which is the entire point.
 */
export interface StoredCheckpoint {
  id: string
  /** `initId` of the configuration. Checkpoints from different worlds never mix. */
  world: string
  tick: number
  savedAt: number
  /** Metadata needed to restore, minus the bytes. */
  meta: unknown
  buffer: ArrayBuffer
  /** For the list: what world this was, in words. */
  label: string
}

/**
 * How many checkpoints to keep per world, oldest dropped first.
 *
 * Bounded by count rather than bytes because the size is dominated by one thing — a world with
 * thousands of brains — and a count is something a person can reason about: "the last eight
 * checkpoints", which at the 5,000-tick interval is the last 40,000 ticks.
 */
export const CHECKPOINTS_PER_WORLD = 8

export type StoreMode = 'idb' | 'memory'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = (e) => {
      const db = req.result
      // a fresh start: anything from before the laws changed is cleared rather than migrated
      if ((e.oldVersion ?? 0) < 2) {
        if (db.objectStoreNames.contains(RUNS)) db.deleteObjectStore(RUNS)
        if (db.objectStoreNames.contains(ORGANISMS)) db.deleteObjectStore(ORGANISMS)
      }
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ORGANISMS)) db.createObjectStore(ORGANISMS, { keyPath: 'id' })
      // Version 3 adds checkpoints. Note it does *not* drop the other two: unlike the version-2
      // upgrade, nothing about the existing runs or organisms became incomparable.
      if (!db.objectStoreNames.contains(CHECKPOINTS)) db.createObjectStore(CHECKPOINTS, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('could not open the collection'))
  })
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('collection request failed'))
  })
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/**
 * A collection that falls back to memory when IndexedDB is unavailable (private browsing, a
 * blocked origin). Falling back keeps the app working; `mode` lets the UI say so plainly rather
 * than pretending things were saved.
 */
export class Collection {
  mode: StoreMode = 'memory'
  private db: IDBDatabase | null = null
  private memRuns = new Map<string, StoredRun>()
  private memOrganisms = new Map<string, StoredOrganism>()
  private memCheckpoints = new Map<string, StoredCheckpoint>()

  async init(): Promise<StoreMode> {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB')
      this.db = await open()
      this.mode = 'idb'
    } catch {
      this.db = null
      this.mode = 'memory'
    }
    return this.mode
  }

  private async all<T>(store: string, mem: Map<string, T>): Promise<T[]> {
    if (!this.db) return [...mem.values()]
    const tx = this.db.transaction(store, 'readonly')
    return wrap(tx.objectStore(store).getAll() as IDBRequest<T[]>)
  }

  private async put<T extends { id: string }>(store: string, mem: Map<string, T>, value: T): Promise<void> {
    mem.set(value.id, value)
    if (!this.db) return
    const tx = this.db.transaction(store, 'readwrite')
    await wrap(tx.objectStore(store).put(value))
  }

  private async drop(store: string, mem: Map<string, unknown>, id: string): Promise<void> {
    mem.delete(id)
    if (!this.db) return
    const tx = this.db.transaction(store, 'readwrite')
    await wrap(tx.objectStore(store).delete(id))
  }

  /** Every checkpoint for one world configuration, oldest tick first. */
  async checkpoints(world: string): Promise<StoredCheckpoint[]> {
    const all = await this.all<StoredCheckpoint>(CHECKPOINTS, this.memCheckpoints)
    return all.filter((c) => c.world === world).sort((a, b) => a.tick - b.tick)
  }

  /** Every world that has checkpoints, newest first, for a picker. */
  async checkpointWorlds(): Promise<{ world: string; label: string; ticks: number[]; savedAt: number }[]> {
    const all = await this.all<StoredCheckpoint>(CHECKPOINTS, this.memCheckpoints)
    const by = new Map<string, StoredCheckpoint[]>()
    for (const c of all) {
      const list = by.get(c.world)
      if (list) list.push(c)
      else by.set(c.world, [c])
    }
    return [...by.entries()]
      .map(([world, cs]) => ({
        world,
        label: cs[0].label,
        ticks: cs.map((c) => c.tick).sort((a, b) => a - b),
        savedAt: Math.max(...cs.map((c) => c.savedAt)),
      }))
      .sort((a, b) => b.savedAt - a.savedAt)
  }

  /**
   * Saves a checkpoint and drops the world's oldest once there are more than the cap.
   *
   * Re-saving the same tick overwrites rather than accumulating: a world re-run from scratch passes
   * tick 5,000 again, and two checkpoints for the same tick of the same configuration are the same
   * state, so keeping both would spend the budget on duplicates.
   */
  async saveCheckpoint(c: Omit<StoredCheckpoint, 'id'>): Promise<void> {
    await this.put<StoredCheckpoint>(CHECKPOINTS, this.memCheckpoints, { ...c, id: `cp_${c.world}_${c.tick}` })
    const mine = await this.checkpoints(c.world)
    for (const old of mine.slice(0, Math.max(0, mine.length - CHECKPOINTS_PER_WORLD))) {
      await this.drop(CHECKPOINTS, this.memCheckpoints, old.id)
    }
  }

  async deleteCheckpoints(world: string): Promise<void> {
    for (const c of await this.checkpoints(world)) await this.drop(CHECKPOINTS, this.memCheckpoints, c.id)
  }

  runs(): Promise<StoredRun[]> {
    return this.all<StoredRun>(RUNS, this.memRuns).then((r) => r.sort((a, b) => b.savedAt - a.savedAt))
  }

  organisms(): Promise<StoredOrganism[]> {
    return this.all<StoredOrganism>(ORGANISMS, this.memOrganisms).then((o) => o.sort((a, b) => b.savedAt - a.savedAt))
  }

  putRun(run: StoredRun): Promise<void> {
    return this.put(RUNS, this.memRuns, run)
  }

  putOrganism(o: StoredOrganism): Promise<void> {
    return this.put(ORGANISMS, this.memOrganisms, o)
  }

  deleteRun(id: string): Promise<void> {
    return this.drop(RUNS, this.memRuns as Map<string, unknown>, id)
  }

  deleteOrganism(id: string): Promise<void> {
    return this.drop(ORGANISMS, this.memOrganisms as Map<string, unknown>, id)
  }

  async rename(id: string, name: string): Promise<void> {
    const all = await this.organisms()
    const found = all.find((o) => o.id === id)
    if (!found) return
    found.name = name.slice(0, 80)
    found.organism = { ...found.organism, name: found.name }
    await this.putOrganism(found)
  }

  /** Everything, as one file. The only defence against a cleared cache. */
  async exportAll(): Promise<string> {
    return JSON.stringify({ version: VERSION, runs: await this.runs(), organisms: await this.organisms() }, null, 2)
  }

  /**
   * Merges a collection file in, keeping whatever is already here. Anything unreadable is skipped
   * rather than aborting the import, so one bad record cannot cost you the file.
   */
  async importAll(text: string): Promise<{ runs: number; organisms: number; skipped: number }> {
    const raw = JSON.parse(text) as { runs?: StoredRun[]; organisms?: StoredOrganism[] }
    let runs = 0
    let organisms = 0
    let skipped = 0
    for (const r of Array.isArray(raw.runs) ? raw.runs : []) {
      if (r && typeof r.id === 'string' && r.init) {
        await this.putRun(r)
        runs++
      } else skipped++
    }
    for (const o of Array.isArray(raw.organisms) ? raw.organisms : []) {
      if (o && typeof o.id === 'string' && o.organism) {
        await this.putOrganism(o)
        organisms++
      } else skipped++
    }
    return { runs, organisms, skipped }
  }

  async clear(): Promise<void> {
    for (const r of await this.runs()) await this.deleteRun(r.id)
    for (const o of await this.organisms()) await this.deleteOrganism(o.id)
  }
}

export const collection = new Collection()
