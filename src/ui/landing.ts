import { reducedMotion } from './theme'

/** Title screen: what this is, and the two ways in. */
export function mountLanding(root: HTMLElement, go: { explain(): void; setup(): void; library(): void }): void {
  root.innerHTML = `
    <canvas class="drift" id="drift"></canvas>
    <div class="landing">
      <h1>SIMPLECELL</h1>
      <div class="tag">a small world that was not told what to do</div>
      <div class="lede">
        <p>Four kinds of particle, one symmetric table of attractions, and food falling from
        nowhere in particular. Everything else — membranes, bodies that heal, organisms that latch
        together and stay that way — has to arrive on its own, or not at all.</p>
        <p>Nothing here is scripted. There is no fitness function, no goal, and no behaviour
        written down anywhere. The chemistry is yours to set; what it builds is not.</p>
      </div>
      <div class="row">
        <button class="primary" id="l-init">Init world →</button>
        <button id="l-how">How it works</button>
        <button id="l-lib">Collection</button>
      </div>
    </div>`
  root.querySelector('#l-init')!.addEventListener('click', () => go.setup())
  root.querySelector('#l-how')!.addEventListener('click', () => go.explain())
  root.querySelector('#l-lib')!.addEventListener('click', () => go.library())
  drift(root.querySelector<HTMLCanvasElement>('#drift')!)
}

/**
 * Background motion: a few hundred dots on a slow random walk, pulled gently toward their
 * neighbours. Decorative, deliberately almost invisible, and off entirely under reduced motion.
 */
function drift(canvas: HTMLCanvasElement): void {
  if (reducedMotion()) return
  const ctx = canvas.getContext('2d')!
  const COLORS = ['#ff6b81', '#ffc145', '#3ddc97', '#5b8def']
  let w = 0
  let h = 0
  const N = 220
  const px = new Float32Array(N)
  const py = new Float32Array(N)
  const vx = new Float32Array(N)
  const vy = new Float32Array(N)
  const kind = new Uint8Array(N)

  const resize = (): void => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    w = canvas.clientWidth || innerWidth
    h = canvas.clientHeight || innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  addEventListener('resize', resize)
  resize()
  for (let i = 0; i < N; i++) {
    px[i] = Math.random() * w
    py[i] = Math.random() * h
    kind[i] = Math.floor(Math.random() * 4)
  }

  let raf = 0
  const frame = (): void => {
    raf = requestAnimationFrame(frame)
    if (canvas.offsetParent === null) return // the page is hidden; nothing to draw
    ctx.clearRect(0, 0, w, h)
    for (let i = 0; i < N; i++) {
      vx[i] = vx[i] * 0.96 + (Math.random() - 0.5) * 0.14
      vy[i] = vy[i] * 0.96 + (Math.random() - 0.5) * 0.14
      px[i] = (px[i] + vx[i] + w) % w
      py[i] = (py[i] + vy[i] + h) % h
      ctx.globalAlpha = 0.3
      ctx.fillStyle = COLORS[kind[i]]
      ctx.beginPath()
      ctx.arc(px[i], py[i], 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  frame()
  addEventListener('pagehide', () => cancelAnimationFrame(raf))
}
