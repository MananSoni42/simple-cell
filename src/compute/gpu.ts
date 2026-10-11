import type { ForceBackend } from '../core/backend'
import type { World } from '../core/world'

/* eslint-disable @typescript-eslint/no-explicit-any */
// WebGPU types are not part of the TS DOM lib; the handful of calls used here are typed loosely.

const WGSL = /* wgsl */ `
struct Params { n: u32, nc: u32, size: f32, rc: f32, beta: f32, K: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> minfo: array<vec2<i32>>; // x: type (-1 = dead), y: owner
@group(0) @binding(3) var<storage, read> cellStart: array<i32>;
@group(0) @binding(4) var<storage, read> cellItems: array<i32>;
@group(0) @binding(5) var<storage, read> cellOf: array<i32>;
@group(0) @binding(6) var<storage, read> A: array<f32>;
@group(0) @binding(7) var<storage, read_write> outF: array<vec4<f32>>;

fn midx(t: i32) -> i32 {
  if (t == 4) { return -1; }
  if (t == 5) { return 4; }
  return t;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let mi_ = minfo[i];
  if (mi_.x < 0) { outF[i] = vec4<f32>(0.0); return; }
  let ti = mi_.x;
  let oi = mi_.y;
  let mi = midx(ti);
  let pi = pos[i];
  let c = cellOf[i];
  let nc = i32(P.nc);
  let cx = c % nc;
  let cy = c / nc;
  var s = vec2<f32>(0.0);
  var near = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    let row = ((cy + dy + nc) % nc) * nc;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let cc = row + ((cx + dx + nc) % nc);
      for (var k = cellStart[cc]; k < cellStart[cc + 1]; k = k + 1) {
        let j = cellItems[k];
        if (j == i32(i)) { continue; }
        let mj = minfo[j];
        if (oi >= 0 && oi == mj.y && (ti == 4 || mj.x == 4)) { continue; }
        var d = pos[j] - pi;
        d = d - P.size * round(d / P.size);
        let r2 = dot(d, d);
        if (r2 >= P.rc * P.rc || r2 < 1e-18) { continue; }
        let r = sqrt(r2);
        let u = r / P.rc;
        var f = 0.0;
        if (u < P.beta) {
          f = P.K * (u / P.beta - 1.0);
        } else {
          let mjx = midx(mj.x);
          var a = 0.0;
          if (mi >= 0 && mjx >= 0) { a = A[mi * 5 + mjx]; }
          f = a * (1.0 - abs(2.0 * u - 1.0 - P.beta) / (1.0 - P.beta));
        }
        s = s + d * (f / r);
        if (mj.x == 5) { near = near + 1.0; }
      }
    }
  }
  outF[i] = vec4<f32>(s, near, 0.0);
}`

const USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }

export function gpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Pair forces on the GPU (WebGPU compute). The CPU still builds the cell grid and
 * integrates; each tick uploads positions and reads back one force per particle.
 * Single precision, so results match the CPU to ~1e-4 relative but are not bit-identical.
 */
export class GpuBackend implements ForceBackend {
  readonly name: string
  private pos: Float32Array
  private minfo: Int32Array
  private bufs: Record<string, any> = {}
  private bind: any
  private params: ArrayBuffer

  private constructor(
    private device: any,
    private pipeline: any,
    w: World,
    adapterName: string,
  ) {
    this.name = `gpu${adapterName ? ' ' + adapterName : ''}`
    const n = w.cap
    this.pos = new Float32Array(2 * n)
    this.minfo = new Int32Array(2 * n)
    const mk = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, size), usage })
    const S = USAGE.STORAGE | USAGE.COPY_DST
    this.bufs = {
      params: mk(32, USAGE.UNIFORM | USAGE.COPY_DST),
      pos: mk(8 * n, S),
      minfo: mk(8 * n, S),
      start: mk(4 * w.grid.start.length, S),
      items: mk(4 * n, S),
      cellOf: mk(4 * n, S),
      A: mk(4 * 25, S),
      out: mk(16 * n, USAGE.STORAGE | USAGE.COPY_SRC),
      read: mk(16 * n, USAGE.MAP_READ | USAGE.COPY_DST),
    }
    const entries = ['params', 'pos', 'minfo', 'start', 'items', 'cellOf', 'A', 'out'].map((k, binding) => ({
      binding,
      resource: { buffer: this.bufs[k] },
    }))
    this.bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const p = w.kernelParams
    this.params = new ArrayBuffer(32)
    const dv = new DataView(this.params)
    dv.setUint32(0, n, true)
    dv.setUint32(4, p.nc, true)
    dv.setFloat32(8, p.SIZE, true)
    dv.setFloat32(12, p.r_c, true)
    dv.setFloat32(16, p.beta, true)
    dv.setFloat32(20, p.K_core, true)
    device.queue.writeBuffer(this.bufs.params, 0, this.params)
    device.queue.writeBuffer(this.bufs.A, 0, Float32Array.from(w.A))
  }

  static async create(w: World): Promise<GpuBackend> {
    if (!gpuAvailable()) throw new Error('WebGPU is not available in this browser')
    const adapter = await (navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('no WebGPU adapter')
    const info = adapter.info ?? {}
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
    })
    const module = device.createShaderModule({ code: WGSL })
    const info2 = await module.getCompilationInfo()
    const errs = info2.messages.filter((m: any) => m.type === 'error')
    if (errs.length) throw new Error(errs.map((m: any) => `line ${m.lineNum}: ${m.message}`).join('; '))
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    return new GpuBackend(device, pipeline, w, info.description || info.device || '')
  }

  async compute(w: World): Promise<void> {
    const { device, bufs, pos, minfo } = this
    const n = w.cap
    for (let i = 0; i < n; i++) {
      pos[2 * i] = w.x[i]
      pos[2 * i + 1] = w.y[i]
      minfo[2 * i] = w.alive[i] ? w.type[i] : -1
      minfo[2 * i + 1] = w.owner[i]
    }
    const q = device.queue
    q.writeBuffer(bufs.pos, 0, pos)
    q.writeBuffer(bufs.minfo, 0, minfo)
    q.writeBuffer(bufs.start, 0, w.grid.start)
    q.writeBuffer(bufs.items, 0, w.grid.items)
    q.writeBuffer(bufs.cellOf, 0, w.grid.cellOf)

    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bind)
    pass.dispatchWorkgroups(Math.ceil(n / 64))
    pass.end()
    enc.copyBufferToBuffer(bufs.out, 0, bufs.read, 0, 16 * n)
    q.submit([enc.finish()])

    await bufs.read.mapAsync(1)
    const out = new Float32Array(bufs.read.getMappedRange(0, 16 * n))
    for (let i = 0; i < n; i++) {
      w.fx[i] = out[4 * i]
      w.fy[i] = out[4 * i + 1]
      w.foodNear[i] = out[4 * i + 2]
    }
    bufs.read.unmap()
  }

  dispose(): void {
    for (const b of Object.values(this.bufs)) b.destroy()
    this.device.destroy()
  }
}
