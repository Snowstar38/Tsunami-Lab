# Tsunami Lab

A browser-based tsunami inundation sandbox: 2D shallow-water physics (the same
depth-averaged equations real tsunami models use) on a GPU grid, over procedurally
generated coastal terrain, with an orbitable 3D view, an overhead topo view, and a
record-and-scrub replay timeline.

**Run it:** Either go to https://snowstar38.github.io/Tsunami-Lab/ or download the repo
and open `index.html` in a modern desktop browser (Chrome/Edge/Firefox).
No install, no server, no network. Requires WebGL2 with float render targets
(any modern desktop GPU).

**Share it:** the folder is GitHub Pages-ready as-is — push it to a repo, enable
Pages, done. Anyone is free to edit and redistribute the code; I made it to share.

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

2D controls: drag to pan · scroll to zoom (up to 40×) · double-click to reset.
3D controls: left-drag orbit · wheel zoom · right-drag (or shift-drag) pan.
Space = start/pause. Zooming the 2D map works during a live run and while
scrubbing the replay.

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

### Make a heightmap… (work in progress)

> **Known issue:** maps imported from real-world elevation data can show odd
> artefacts along steep coastlines — patches of water that sit on the shore and
> never drain, most visible near cliffs and inlets. The flooding physics is
> sound; the problem is in how shallow standing water is handled. Gentle
> coastlines and the procedural terrain are unaffected.


The **Make a heightmap…** button opens an importer that turns terrain data into a
map this sim can flood. Two ways in:

- **Fetch real terrain** — **click a coastline on the world map**, or type a
  latitude and longitude, and it pulls merged land + seabed elevation straight
  from the GMRT synthesis in the browser. No API key, no account, no download
  step. This is the best option, because it comes with *real bathymetry*.
  Scroll to zoom into the map, drag to pan, and the teal box shows the exact
  footprint of the width you asked for, so you can see how much coast you are
  about to get before you fetch anything. A live estimate tells you how long the
  download will take — it scales with **area**, so doubling the width roughly
  quadruples the wait (≈8 s at 40 km, ≈50 s at 100 km, at finest detail). 120 km
  is the cap; past that GMRT tends to time out. For a big stretch of coast, a
  coarser Source detail helps far more than patience.
- **Your file** — drop in a heightmap: PNG (8- or 16-bit), JPG, ESRI ASCII `.asc`,
  SRTM `.hgt`, raw `.raw`/`.r16`, or an existing `.tsu` you want to re-crop.
  16-bit PNGs are decoded properly (canvas would crush them to 256 height steps).
  RGB tile encodings — Mapbox Terrain-RGB and Mapzen Terrarium — are decoded as
  true meters.

The importer's real job is not reading files, it's **giving the numbers meaning**.
An image heightmap has no vertical datum and no seabed, so you get:

- a **sea level** slider — drag it and watch the coastline move to where it belongs;
- **height of the highest point**, which fixes the vertical scale;
- **seabed synthesis** — slopes the sea floor away from every coast so the wave has
  something to travel through, leaving inland lakes alone;
- a **crop box** you drag, scroll to resize and shift-drag to rotate, with the
  wave-entry edge lit up and arrows showing which way the tsunami will run;
- **Wave from S/E/N/W** buttons that snap the crop so that compass side becomes the
  edge the wave enters from;
- live warnings — a wave-entry edge that is mostly land, cells too coarse to
  resolve an inlet, a depth that will crush the timestep, an 8-bit source that
  will terrace.

The right-hand panel shows what you are actually going to get: domain size, cell
size, water fraction, entry-edge depth, and the estimated timestep. **Use in the
sim** loads it immediately; **Save .tsu** writes a file you can reload or share.

### fetch_terrain.py (command line)

`fetch_terrain.py` (pure stdlib Python) does the same GMRT download from a shell,
which is handy for scripting or very large areas:

```
python fetch_terrain.py --lat 41.75 --lon -70.10 --width-km 68 \
    --out capecod.tsu --max-depth 200 --wave-from E
```

`--wave-from S|E|W|N` rotates the map so the tsunami arrives from that compass
side (the wave always enters at the bottom edge of the sim). `--max-depth` clamps
abyssal water, which keeps the timestep healthy. Loaded maps set their own domain
size; the resolution dropdown still works (the map is resampled). **Regenerate**
returns to procedural terrain. `capecod.tsu` (wave from the Sound) and
`capecod-atlantic.tsu` (wave from the open Atlantic) ship in this folder as
worked examples.

### The .tsu format

`TSU1` — `'TSU1'`, uint32 N, float32 domain width in meters, then N×N float32
elevations (meters, sea level 0, row 0 = the wave-entry edge). Still read.

`TSU2` — what the importer writes: `'TSU2'`, uint32 header length, a UTF-8 JSON
header (grid size, domain width, name, source, coordinates, datum), then the same
float32 payload, deflate-compressed. Real terrain typically lands around 30% of
the raw size, so a 1024² map is ~1.2 MB instead of 4 MB. Both formats load through
the same button.

## How it works (short version)

Kurganov–Petrova central-upwind finite-volume scheme for the shallow-water
equations, well-balanced with wet/dry fronts, SSP-RK2 time stepping, CFL-adaptive
dt via GPU max-reduction, semi-implicit Manning friction. The wave enters through a
forcing/sponge strip at the south boundary that also absorbs outgoing reflections.
All physics runs in WebGL2 fragment shaders on RGBA32F ping-pong textures.
Replay snapshots are downsampled on GPU, quantized to Uint16 on CPU, and
re-interpolated on scrub. See `SPEC.md` for the architecture contract.

World coastlines from [Natural Earth](https://www.naturalearthdata.com/) (1:50m
land polygons, public domain).

Built by Claude (Fable 5 and Opus 5, with three Opus 5 subagents), August 2026.
Phase 2 (planned): trees, buildings, seawalls + fragility damage, erosion &
sediment transport, debris, before/after slider.
