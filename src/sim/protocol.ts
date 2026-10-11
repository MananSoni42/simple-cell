import type { Perf } from '../compute/select'
import type { Init } from '../core/params'
import type { AggregateStats } from '../core/aggregates'
import type { Census, LifeStats } from '../core/metrics'
import type { OrderStats } from '../core/orders'
import type { FrameBuffers, FrameLayout } from './frames'

export type ToSim =
  | { kind: 'start'; init: Init; perf: Perf }
  | { kind: 'rewind'; ticks: number } // step back to the newest snapshot at least this far back
  | { kind: 'seek'; tick: number }
  | { kind: 'feed'; x: number; y: number; n: number; radius: number }
  | { kind: 'rate'; rate: number }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'step' }

export interface StatsSnapshot {
  tick: number
  seed: number
  size: number
  foodMode: string
  foodMoves: boolean
  T: number
  cap: number
  backend: string
  tps: number
  census: Census
  life: LifeStats
  aggregates: AggregateStats
  bondCount: number
  orders: OrderStats
  clampedPct: number
  /** Ticks of history held, and the oldest tick we can rewind to. */
  historyTicks: number
  oldestTick: number // how often the per-tick step guardrail bit
  burned: number
  births: number
  budded: number
  deaths: number
  recordAge: number
}

export type FromSim =
  | { kind: 'ready'; layout: FrameLayout; frames: FrameBuffers[]; header: Int32Array; note: string }
  | { kind: 'stats'; stats: StatsSnapshot }
  | { kind: 'error'; message: string }
