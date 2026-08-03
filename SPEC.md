# Tsunami Simulator — Phase 1 Spec

Browser-based tsunami inundation simulator. 2D shallow-water equations on a GPU grid
(WebGL2 fragment-shader ping-pong), procedural coastal terrain, overhead topo view and
orbitable 3D heightfield view, record-and-scrub replay.

**Phase 1 scope**: terrain gen, water solver, wave source, 2D + 3D rendering, replay/scrub, UI.
**Phase 2 (NOT now)**: trees/buildings/seawalls + fragility, erosion & sediment, debris
particles, before/after slider. Do not implement phase-2 features.

## Delivery constraints

- Runs from `file://` locally AND on GitHub Pages. Therefore: **plain `<script>` tags, no
  ES modules, no imports, no external libraries, no build step, no network fetches.**
- Each JS file is an IIFE in strict mode that attaches one namespace object to the global
  `TS` object: `window.TS = window.TS || {}; TS.foo = (function(){ 'use strict'; ... })();`
- Target: modern desktop Chrome/Edge/Firefox with WebGL2 + `EXT_color_buffer_float`
  (required; `main.js` shows an error banner if missing). Try to enable
  `OES_texture_float_linear`; fall back to NEAREST filtering if absent.
- Plain ES2020. No TypeScript, no JSX.

## Files & ownership

```
tsunami-sim/
  index.html      (lead)   layout, CSS shell, script tags in order:
                           gl, terrain, solver, render2d, camera, render3d, replay, ui, main
  SPEC.md         (this file)
  js/gl.js        (lead)   WebGL helpers — ALREADY WRITTEN, read it, use it
  js/solver.js    (lead)   shallow-water solver + wave forcing + max-inundation accumulation
  js/render2d.js  (lead)   overhead topo view
  js/main.js      (lead)   orchestration, sim loop, mode switching
  js/terrain.js   (agent A) procedural terrain generator (pure JS, no GL)
  js/camera.js    (agent B) orbit camera + minimal mat4 utils
  js/render3d.js  (agent B) 3D heightfield terrain + water surface rendering
  js/replay.js    (agent C) snapshot recording, quantized storage, interpolated playback
  js/ui.js        (agent C) control sidebar + timeline DOM (no GL calls in ui.js)
```

Agents: write ONLY your assigned files. The lead integrates.

## World & units

- Square grid, `N` cells per side, `N ∈ {256, 512, 1024, 2048, 4096}`.
- Physical domain is FIXED at `L = 10240` meters regardless of N; cell size `dx = L / N`
  (10 m at 1024). Resolution changes fidelity, not world size. **Terrain generation must be
  resolution-independent**: same seed → same landforms at every N (use normalized
  coordinates in [0,1], never per-cell randomness).
- Heights in meters, **sea level = 0**. Negative terrain = seabed. Velocities m/s. g = 9.81.
- Grid indexing: row-major `Float32Array`, `index = j * N + i`. `i` = x = east (+right),
  `j` = y = north (+up on the topo map). **Row j = 0 is the SOUTH edge = open ocean.**
  The tsunami arrives from the south. Coastline runs roughly east–west somewhere around
  j ≈ 0.35N–0.55N; land and hills to the north.
- 3D world space: `worldX = i * dx` (east), `worldY = elevation` (up),
  `worldZ = (N - 1 - j) * dx` (so north is −Z, a right-handed y-up scene). Vertical
  exaggeration is applied at render time only.

## GPU state convention (everyone renders from this)

One RGBA32F texture, N×N:

| channel | meaning |
|---|---|
| r | `h`  — water depth (m, ≥ 0; 0 = dry) |
| g | `hu` — x-discharge (m²/s) |
| b | `hv` — y-discharge (m²/s) |
| a | `B`  — terrain elevation (m, sea level 0) |

Water surface elevation = `B + h`. A cell is "wet" if `h > 0.02`. Renderers consume ONLY
a texture in this layout — which is what makes live textures and replay textures
interchangeable (replay frames are downsampled but same channel layout).

Max-inundation texture (solver-owned, RG32F): r = max depth ever, g = max momentum flux
`h·(u²+v²)` ever.

## Module APIs

### TS.gl (written — see js/gl.js)
Helpers for program compilation, float textures, FBOs, fullscreen-quad drawing, ping-pong
pairs. Read the file; use `TS.gl.createTexture`, `TS.gl.program`, `TS.gl.drawQuad`, etc.

### TS.terrain (agent A — pure JS, no WebGL)

```js
TS.terrain.generate(params) -> Float32Array   // length N*N, meters, row-major as above
// params = {
//   N: 1024,             // grid size
//   seed: 12345,         // integer; deterministic
//   coastComplexity: 0.5,// 0..1  smooth straight coast -> ragged headlands/bays/inlets
//   hilliness: 0.5,      // 0..1  flat plain -> steep hills (up to ~250 m) inland
//   barrierIslands: true,// low sandy island chain offshore with lagoon behind
//   riverValley: true,   // a river valley cutting from the hills to the sea (below-0
//                        //   channel bed near mouth so water can funnel up it)
// }
```

Requirements:
- Deterministic per seed. Resolution-independent (normalized coords; include your own
  small seeded PRNG + smooth value/simplex noise + fBm; domain warping encouraged).
- Offshore: continental shelf sloping from about −60 m at the south edge up to the shore,
  with plausible submarine relief (the interesting funneling happens underwater).
- Coast: position varies with x (headlands, bays, maybe a narrow inlet at high
  complexity). Coastal plain 0–10 m elevation for a while inland, then hills per
  `hilliness`. Barrier islands: crest ~1–3 m above sea level, lagoon ~2–5 m deep behind.
- No NaNs, no absurd spikes; smooth enough that a fluid solver won't explode (avoid
  single-cell walls/pits at any N).
- Aim for "recognizably like Tōhoku ria/plain coastlines" variety across seeds.

### TS.solver (lead)

```js
TS.solver.init(gl, { N, dx, terrain /* Float32Array */ })
TS.solver.reset()                       // re-initialize water to still sea level, t=0
TS.solver.setTerrain(terrainFloat32)    // re-upload + reset
TS.solver.setParams({ manning, waveAmplitude, wavePeriod, waveform })
                                        // waveform: 'pulse' | 'nwave' | 'sustained'
TS.solver.stepBatch(nSteps) -> { simTime, dt, unstable /* bool */ }
TS.solver.stateTexture                  // WebGLTexture, RGBA32F layout above (current)
TS.solver.maxTexture                    // RG32F max-inundation
TS.solver.simTime                       // seconds
```

### TS.camera (agent B)

```js
TS.camera.create(canvas, { L }) -> cam  // L = domain meters; sets sane initial orbit
cam.update()                            // per-frame
cam.viewProj -> Float32Array(16)        // column-major proj*view, for uniformMatrix4fv
cam.eye -> [x,y,z]                      // world-space eye position (meters)
cam.resize(w, h)
```

Controls: left-drag orbit (yaw/pitch, clamp pitch ~[5°, 89°]), wheel zoom (toward
target), right-drag or shift-drag pan (target moves in ground plane, clamped to domain).
Perspective projection, near/far suited to a 10 km domain (e.g. near 5, far 60000).
Also export `TS.mat4` (in camera.js): `perspective`, `lookAt`, `multiply` — the minimum
needed, column-major Float32Array(16).

### TS.render3d (agent B)

```js
TS.render3d.init(gl, { N, dx })         // build meshes/programs once (mesh vertex grid
                                        //   ~min(N,512) per side; index buffer; vertex
                                        //   shader samples the state texture for heights)
TS.render3d.resize(w, h)
TS.render3d.draw(gl, { stateTex, cam, exaggeration, time })
```

- Terrain pass: vertices displaced by `B` (state alpha) × exaggeration. Fragment: normal
  from state-texture height differences; hypsometric ramp (sand near 0, greens for plain,
  browns/grey higher, seabed muted blue-grey when exposed) with lambert light from a
  fixed sun direction and subtle slope darkening.
- Water pass (after terrain, alpha blend on): vertices at `(B + h)` × exaggeration;
  in fragment, `discard` where h < 0.02. Color deep navy → shallow aqua by depth;
  whitecap/foam tint where speed `|hu,hv|/h` exceeds ~3 m/s; fresnel-ish alpha (more
  transparent looking down into shallow water); one specular glint from the sun.
- Depth test on for both passes; water writes depth. No shadows. Clear is main's job.
- Sample state texture in the VERTEX shader (WebGL2 supports vertex texture fetch);
  LINEAR filtering if float-linear ext is on (main sets that up), else NEAREST is fine.

### TS.replay (agent C)

```js
TS.replay.configure(gl, { N, recordN, intervalSimSeconds, maxMemMB })
   // recordN = snapshot resolution (≤ N, default min(N,512)); downsample on GPU
TS.replay.capture(gl, stateTex, simTime)   // called by main when interval elapsed:
   // render stateTex into a recordN FBO (use TS.gl helpers + a tiny passthrough shader,
   // LINEAR-ish downsample via manual 2x2 or 4x4 tap average in the shader),
   // readPixels (RGBA float), quantize to Uint16 per channel with per-frame min/max,
   // store CPU-side. If memory would exceed maxMemMB, double intervalSimSeconds from
   // then on (log it) rather than dropping frames silently.
TS.replay.frameCount, TS.replay.duration   // seconds of recorded sim time
TS.replay.memoryUsedMB()
TS.replay.getTextureAt(gl, simT) -> WebGLTexture
   // RGBA32F recordN×recordN in the standard state layout; linear-interpolate between
   // the two bracketing frames on CPU into a scratch Float32Array, upload. Cache the
   // last request (same bracketing pair + close t ⇒ reuse work where easy).
TS.replay.clear()
```

All four channels (h, hu, hv, B) are captured so replay frames render through the exact
same 2D/3D paths as live frames.

### TS.ui (agent C — DOM only, zero WebGL)

```js
TS.ui.init(callbacks, defaults) // build sidebar + timeline, wire events
TS.ui.setStatus({ simTime, dt, stepsPerSec, fps, recordedS, memMB, running, mode })
TS.ui.setReplayRange(durationS)         // enable/resize scrubber
TS.ui.showError(msg)                    // red banner (e.g., no WebGL2, instability)
```

`callbacks` (all provided by main):
`onRegenerate(terrainParams)`, `onResolutionChange(N)`, `onWaveChange({amplitude,
period, waveform})`, `onManningChange(n)`, `onStart()`, `onPause()`, `onReset()`,
`onViewMode('2d'|'3d')`, `onExaggeration(x)`, `onOverlayMaxExtent(bool)`,
`onScrub(simT)` (entering replay mode), `onLive()` (back to live),
`onReplayPlay(speed)` / `onReplayPause()`, `onTurbo(bool)` (skip rendering while
simulating for max speed).

Controls, grouped, in a fixed right sidebar (~300 px, dark theme, system-ui font,
sliders show live values):

- **Terrain**: seed number input + 🎲 randomize button; coast complexity slider;
  hilliness slider; barrier islands checkbox; river valley checkbox; Regenerate button.
- **Simulation**: resolution select (256–4096, warn label "slow" at 2048+); wave
  amplitude slider 1–20 m; wave period slider 60–600 s; waveform select (pulse /
  N-wave / sustained); Manning roughness slider 0.01–0.08 (default 0.03).
- **Run**: Start / Pause / Reset buttons; Turbo checkbox; status lines (sim time m:ss,
  dt, steps/s, fps, recorded duration, replay memory).
- **View**: 2D topo / 3D toggle; vertical exaggeration slider 1–5 (default 2);
  max-inundation overlay checkbox (2D).
- **Timeline** (bottom bar overlaying the canvas, full width minus sidebar): scrubber
  slider over recorded duration + time label; ▶/⏸ replay; speed select (1×/4×/16×/60×);
  "Live" button to return to the running/current sim. Scrubbing while sim runs is
  allowed — main handles pausing.

Inject a `<style>` tag from ui.js for all UI styling; index.html only provides
`<div id="sidebar">`, `<div id="timeline">`, `<canvas id="view">` and basic page CSS.
Dark background (#14171c-ish), unobtrusive, readable. No frameworks.

## Numerical notes (context; solver is lead-owned)

Central-upwind (Kurganov-Petrova) finite-volume scheme, well-balanced with wet/dry
handling, SSP-RK2 time stepping, semi-implicit Manning friction, CFL-adaptive dt via GPU
max-reduction, southern sponge/forcing strip generating the incoming wave and absorbing
reflections. ~2 fragment passes per step over N×N. At N=4096 a 20-minute event is
minutes-to-tens-of-minutes of wall time; the UI must stay responsive (Turbo mode just
skips drawing, never blocks the main thread more than ~30 ms per rAF tick).

## Style

- Readable > clever. Small helper functions. Comments only where the code can't say it
  (units, coordinate conventions, why a numerical trick is needed).
- No console spam in the steady state; `console.warn` for real anomalies only.
- Everything degrades with a visible error message rather than a silent black canvas.
