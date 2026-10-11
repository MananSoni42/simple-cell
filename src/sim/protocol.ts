import type { Perf } from '../compute/select'
import type { Init } from '../core/params'
import type { ClusterStats, Census, LifeStats } from '../core/metrics'
import type { FrameBuffers, FrameLayout } from './frames'

export type ToSim =
  | { kind: 'start'; init: Init; perf: Perf }
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
  cluster: ClusterStats
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
