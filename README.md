# Tsunami Lab

A browser-based tsunami inundation sandbox: 2D shallow-water physics (the same
depth-averaged equations real tsunami models use) on a GPU grid, over procedurally
generated coastal terrain, with an orbitable 3D view, an overhead topo view, and a
record-and-scrub replay timeline.

**Run it:** open `index.html` in a modern desktop browser (Chrome/Edge/Firefox).
No install, no server, no network. Requires WebGL2 with float render targets
(any modern desktop GPU).

**Share it:** the folder is GitHub Pages-ready as-is — push it to a repo, enable
Pages, done.

## Using it

1. Pick a terrain seed (🎲 randomizes) and sliders, **Regenerate**.
2. Set the wave (amplitude, period, waveform) and hit **Start**. The tsunami arrives
   from the south (bottom of the topo map, foreground of the 3D view).
3. Watch live in 2D or 3D, or check **Turbo** to skip rendering and simulate at
   maximum speed.
4. Scrub the bottom timeline at any point — during or after the run — to replay any
   moment, from any camera angle. **Live** returns to the running sim.
5. The **max inundation** overlay (2D) shows everywhere water reached, after it
   recedes — the red line is the run-up limit.

3D controls: left-drag orbit · wheel zoom · right-drag (or shift-drag) pan.
Space = start/pause.

- Same seed = same coastline at every resolution: preview a seed at 512, then rerun
  it at 4096.
- Resolution is fidelity, not world size (the domain is always 10.24 km square);
  each doubling costs ~8× the compute. 4096 is a "start it and walk away" run —
  Turbo recommended. It also wants ~1.5 GB of GPU memory.
- Waveforms: **Pulse** = single crest; **N-wave** = leading depression (the sea
  withdraws first — the classic tsunami precursor); **Sustained** = long surge.
- Manning roughness ~0.03 is typical open land; higher = rougher = more energy lost
  as the wave runs inland.

## Real-world terrain

`fetch_terrain.py` (pure stdlib Python) downloads merged land+seabed elevation from
the GMRT synthesis (~100 m resolution, no API key) and writes a `.tsu` file for the
**Load heightmap…** button:

```
python fetch_terrain.py --lat 41.75 --lon -70.10 --width-km 68 \
    --out capecod.tsu --max-depth 200 --wave-from E
```

`--wave-from S|E|W|N` rotates the map so the tsunami arrives from that compass
side (the wave always enters at the bottom edge of the sim). `--max-depth` clamps
abyssal water, which keeps the timestep healthy. Loaded maps set their own domain
size; the resolution dropdown still works (the map is resampled). **Regenerate**
returns to procedural terrain. `capecod.tsu` (wave from the Sound) and
`capecod-atlantic.tsu` (wave from the open Atlantic) ship in this folder.

## How it works (short version)

Kurganov–Petrova central-upwind finite-volume scheme for the shallow-water
equations, well-balanced with wet/dry fronts, SSP-RK2 time stepping, CFL-adaptive
dt via GPU max-reduction, semi-implicit Manning friction. The wave enters through a
forcing/sponge strip at the south boundary that also absorbs outgoing reflections.
All physics runs in WebGL2 fragment shaders on RGBA32F ping-pong textures.
Replay snapshots are downsampled on GPU, quantized to Uint16 on CPU, and
re-interpolated on scrub. See `SPEC.md` for the architecture contract.

Built by Claude (Fable 5 + three Opus 5 subagents) for Michelle, August 2026.
Phase 2 (planned): trees, buildings, seawalls + fragility damage, erosion &
sediment transport, debris, before/after slider.
