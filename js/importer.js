// TS.importer — the "Make a heightmap" dialog: bring in any terrain file, tell the
// sim what its numbers mean, crop/aim it, and write a .tsu.
//
// The file parsing lives in TS.decode; this module owns the part that actually
// matters — a raw heightmap is just numbers, and the sim needs METERS with sea
// level at 0 and real water offshore. Everything here exists to make that
// translation visible while you do it.
//
// Nothing in this file runs until open() is called: no cost to the sim loop.
window.TS = window.TS || {};
TS.importer = (function () {
  'use strict';

  var PREVIEW_N = 256;          // working resolution while you drag things
  var SRC_MAX = 420;            // source preview is downscaled to this many px
  // GMRT download cost scales with AREA, so width is quadratic: ~8 s for a 40 km
  // box at finest detail means ~50 s at 100 km. Cap it before people sit through
  // a two-minute wait that then times out.
  var MAX_KM = 120;
  var SLOW_KM = 80;
  var PAD = 30;                 // breathing room around it, so the incoming-wave
                                // arrows have somewhere to live even when the
                                // crop box is fitted to the whole image
  var G = 9.81;

  var CSS = [
    '#ts-imp { position:fixed; inset:0; z-index:100; display:flex;',
    '  align-items:center; justify-content:center; background:rgba(8,10,13,.72);',
    '  backdrop-filter:blur(3px);',
    '  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    '  font-size:12px; color:#dfe3ea; }',
    '#ts-imp * { box-sizing:border-box; }',
    '#ts-imp .sheet { width:min(1180px,96vw); height:min(830px,94vh); display:flex;',
    '  flex-direction:column; background:#191d24; border:1px solid #2b323d;',
    '  border-radius:10px; box-shadow:0 24px 70px rgba(0,0,0,.6); overflow:hidden; }',

    '#ts-imp .head { display:flex; align-items:center; gap:12px; padding:13px 16px;',
    '  border-bottom:1px solid #262c36; flex:none; }',
    '#ts-imp .head h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:.04em;',
    '  text-transform:uppercase; color:#3ad6c8; }',
    '#ts-imp .head .sub { color:#8b95a6; font-size:11.5px; flex:1; }',
    '#ts-imp .x { background:none; border:none; color:#8b95a6; font-size:20px;',
    '  cursor:pointer; line-height:1; padding:0 4px; }',
    '#ts-imp .x:hover { color:#dfe3ea; }',

    '#ts-imp .body { flex:1; display:flex; min-height:0; }',
    '#ts-imp .left { flex:1; min-width:0; padding:14px 16px; overflow-y:auto;',
    '  border-right:1px solid #262c36; }',
    '#ts-imp .right { width:340px; flex:none; padding:14px 16px; overflow-y:auto; }',
    '#ts-imp .left::-webkit-scrollbar, #ts-imp .right::-webkit-scrollbar { width:9px; }',
    '#ts-imp .left::-webkit-scrollbar-thumb, #ts-imp .right::-webkit-scrollbar-thumb {',
    '  background:#2e3540; border-radius:5px; }',

    '#ts-imp .foot { flex:none; display:flex; align-items:center; gap:10px;',
    '  padding:11px 16px; border-top:1px solid #262c36; background:#161a20; }',
    '#ts-imp .foot .grow { flex:1; min-width:0; }',

    '#ts-imp h3 { margin:16px 0 9px; font-size:10.5px; font-weight:700;',
    '  letter-spacing:.11em; text-transform:uppercase; color:#8b95a6; }',
    '#ts-imp h3:first-child { margin-top:0; }',
    '#ts-imp .lbl { display:flex; justify-content:space-between; align-items:baseline;',
    '  margin-bottom:4px; font-size:11.5px; color:#c3cad6; }',
    '#ts-imp .val { color:#3ad6c8; font-variant-numeric:tabular-nums; font-size:11px; }',
    '#ts-imp .fld { margin-bottom:11px; }',
    '#ts-imp .hint { font-size:10.5px; line-height:1.4; color:#8b95a6; margin-top:5px; }',
    '#ts-imp .row { display:flex; align-items:center; gap:7px; margin-bottom:9px; }',

    '#ts-imp input[type=text], #ts-imp input[type=number], #ts-imp select {',
    '  background:#11141a; color:#dfe3ea; border:1px solid #262c36; border-radius:5px;',
    '  padding:6px 7px; font:inherit; font-size:12px; width:100%; min-height:30px; }',
    '#ts-imp select { cursor:pointer; }',
    '#ts-imp input:focus, #ts-imp select:focus { outline:none; border-color:#1f6f69; }',

    '#ts-imp button.b { background:#232a34; color:#dfe3ea; border:1px solid #262c36;',
    '  border-radius:5px; padding:7px 10px; font:inherit; font-size:12px; cursor:pointer;',
    '  min-height:30px; white-space:nowrap; }',
    '#ts-imp button.b:hover:not(:disabled) { background:#2c3542; }',
    '#ts-imp button.b:disabled { opacity:.42; cursor:default; }',
    '#ts-imp button.b.pri { background:#1f6f69; border-color:#3ad6c8; color:#eafffd;',
    '  font-weight:600; }',
    '#ts-imp button.b.pri:hover:not(:disabled) { background:#28857e; }',
    '#ts-imp button.b.on { background:#1f6f69; border-color:#3ad6c8; color:#eafffd; }',
    '#ts-imp button.b.wide { flex:1; }',
    '#ts-imp button.b.sm { padding:5px 7px; min-height:26px; font-size:11px; }',

    '#ts-imp input[type=range] { -webkit-appearance:none; appearance:none; width:100%;',
    '  height:18px; background:transparent; cursor:pointer; margin:0; display:block; }',
    '#ts-imp input[type=range]::-webkit-slider-runnable-track { height:4px;',
    '  border-radius:2px; background:#2b323d; }',
    '#ts-imp input[type=range]::-moz-range-track { height:4px; border-radius:2px;',
    '  background:#2b323d; }',
    '#ts-imp input[type=range]::-webkit-slider-thumb { -webkit-appearance:none;',
    '  appearance:none; width:14px; height:14px; margin-top:-5px; border-radius:50%;',
    '  background:#3ad6c8; border:none; }',
    '#ts-imp input[type=range]::-moz-range-thumb { width:14px; height:14px;',
    '  border-radius:50%; background:#3ad6c8; border:none; }',

    '#ts-imp label.ck { display:flex; align-items:center; gap:8px; cursor:pointer;',
    '  padding:3px 0; user-select:none; margin-bottom:5px; }',
    '#ts-imp label.ck input { accent-color:#3ad6c8; width:15px; height:15px; margin:0;',
    '  flex:none; cursor:pointer; }',

    '#ts-imp .tabs { display:flex; gap:0; margin-bottom:13px; }',
    '#ts-imp .tabs button { flex:1; border-radius:0; border-right-width:0; }',
    '#ts-imp .tabs button:first-child { border-radius:5px 0 0 5px; }',
    '#ts-imp .tabs button:last-child { border-radius:0 5px 5px 0; border-right-width:1px; }',

    '#ts-imp .drop { border:1.5px dashed #37404e; border-radius:8px; padding:26px 16px;',
    '  text-align:center; color:#8b95a6; line-height:1.6; cursor:pointer; }',
    '#ts-imp .drop:hover, #ts-imp .drop.over { border-color:#3ad6c8; color:#c3cad6;',
    '  background:rgba(58,214,200,.05); }',
    '#ts-imp .drop b { color:#dfe3ea; display:block; font-size:13px; margin-bottom:5px; }',
    '#ts-imp .drop.slim { padding:9px 12px; font-size:11px; }',

    '#ts-imp canvas.wmap { display:block; max-width:100%; height:auto;',
    '  cursor:crosshair; touch-action:none; border:1px solid #262c36;',
    '  border-radius:6px; background:#0d1a26; }',

    '#ts-imp .canvases { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; }',
    // Without a cap the captions below each canvas stretch their column wide
    // enough to push the output preview onto a second row.
    '#ts-imp .canvases > .col { flex:0 1 auto; min-width:0; max-width:490px; }',
    '#ts-imp .canvases > .col.out { max-width:274px; }',
    '#ts-imp .cwrap { position:relative; }',
    '#ts-imp canvas { display:block; border-radius:6px; background:#0e1115;',
    '  border:1px solid #262c36; }',
    '#ts-imp #ts-imp-src { cursor:move; touch-action:none; }',
    '#ts-imp .cap { font-size:10.5px; color:#8b95a6; margin:6px 0 0; line-height:1.4; }',
    '#ts-imp .cap b { color:#c3cad6; font-weight:600; }',

    '#ts-imp .stats { display:grid; grid-template-columns:auto 1fr; gap:3px 10px;',
    '  font-size:11px; margin-top:4px; }',
    '#ts-imp .stats dt { color:#8b95a6; }',
    '#ts-imp .stats dd { margin:0; text-align:right; font-variant-numeric:tabular-nums;',
    '  color:#cfd6e2; }',

    '#ts-imp .msg { display:flex; gap:8px; padding:7px 9px; border-radius:6px;',
    '  margin-bottom:6px; line-height:1.45; font-size:11.5px; }',
    '#ts-imp .msg.warn { background:rgba(229,84,75,.13); color:#f0a9a3;',
    '  border:1px solid rgba(229,84,75,.3); }',
    '#ts-imp .msg.tip { background:rgba(58,214,200,.09); color:#9fd8d2;',
    '  border:1px solid rgba(58,214,200,.22); }',
    '#ts-imp .msg .ic { flex:none; }',
    '#ts-imp .busy { color:#3ad6c8; }',
    '#ts-imp .err { color:#f0a9a3; }'
  ].join('\n');

  // ---------------------------------------------------------------- state ---

  var root = null, ui = {}, opts = {};
  var src = null;               // decoded source (TS.decode output)
  var scalar = null;            // w*h scalar field in source orientation (row 0 = top)
  var scalarRange = { lo: 0, hi: 1 };
  var box = { cx: 0, cy: 0, s: 100, angle: 0 };   // angle: radians CCW on screen
  var cfg = {
    channel: 'lum', invert: false,
    seaRaw: 0, topM: 300, offsetM: 0,
    bathy: true, shelfDepth: 60, shelfSlope: 12, flatten: true,
    // Off by default: this is a hypothesis about why land stays puddled after the
    // solver's face-bed fix, not something that has been shown to help on a real
    // map yet. It also only affects NEW imports.
    fillPits: false, maxFill: 3,
    maxDepth: 200, clampDepth: true,
    N: 1024, widthKm: 20, flipX: false, flipY: false
  };
  var out = null;               // last computed preview { data, N, L, stats, msgs }
  var srcImage = null;          // cached ImageData of the source preview
  var srcScale = 1;             // source px per preview px
  var busyTimer = null;

  // ------------------------------------------------------------- helpers ----

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function add(p, c) { p.appendChild(c); return c; }

  function slider(parent, label, min, max, step, value, fmt, onInput) {
    var f = add(parent, el('div', 'fld'));
    var head = add(f, el('div', 'lbl'));
    add(head, el('span', null, label));
    var o = add(head, el('span', 'val', fmt(value)));
    var inp = add(f, el('input'));
    inp.type = 'range';
    inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    inp.addEventListener('input', function () {
      var v = parseFloat(inp.value);
      o.textContent = fmt(v);
      onInput(v);
    });
    inp.setLabel = function (v) { o.textContent = fmt(v); };
    return inp;
  }

  function checkbox(parent, label, checked, onChange) {
    var lab = add(parent, el('label', 'ck'));
    var inp = add(lab, el('input'));
    inp.type = 'checkbox';
    inp.checked = !!checked;
    add(lab, el('span', null, label));
    inp.addEventListener('change', function () { onChange(inp.checked); });
    return inp;
  }

  function select(parent, label, options, value, onChange) {
    var f = add(parent, el('div', 'fld'));
    if (label) add(add(f, el('div', 'lbl')), el('span', null, label));
    var s = add(f, el('select'));
    options.forEach(function (o) {
      var op = add(s, el('option', null, o[1]));
      op.value = o[0];
    });
    s.value = String(value);
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function button(parent, label, cls, onClick) {
    var b = add(parent, el('button', 'b' + (cls ? ' ' + cls : ''), label));
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function fmtBytes(b) {
    return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' kB';
  }

  // ------------------------------------------------- source -> scalar field --

  // Collapse the source's channels into one number per pixel, in whatever unit
  // the chosen interpretation produces (meters for the RGB terrain encodings).
  function buildScalar() {
    if (!src) { scalar = null; return; }
    var w = src.w, h = src.h, ch = src.channels, d = src.data;
    var n = w * h;
    var s = new Float32Array(n);
    var mode = src.channels === 3 ? cfg.channel : 'lum';
    var i, r, g, b;

    if (ch === 1) {
      s.set(d.subarray(0, n));
    } else if (mode === 'terrainrgb') {
      for (i = 0; i < n; i++) {
        r = d[i * ch]; g = d[i * ch + 1]; b = d[i * ch + 2];
        s[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
      }
    } else if (mode === 'terrarium') {
      for (i = 0; i < n; i++) {
        r = d[i * ch]; g = d[i * ch + 1]; b = d[i * ch + 2];
        s[i] = (r * 256 + g + b / 256) - 32768;
      }
    } else if (mode === 'red') {
      for (i = 0; i < n; i++) s[i] = d[i * ch];
    } else {
      for (i = 0; i < n; i++) {
        s[i] = 0.299 * d[i * ch] + 0.587 * d[i * ch + 1] + 0.114 * d[i * ch + 2];
      }
    }

    if (src.nodata != null) {
      for (i = 0; i < n; i++) if (s[i] === src.nodata) s[i] = 0;
    }
    // .tsu stores row 0 = south; everything else here is north-first.
    if (src.tsuFlipped) {
      var f = new Float32Array(n);
      for (var y = 0; y < h; y++) {
        f.set(s.subarray((h - 1 - y) * w, (h - y) * w), y * w);
      }
      s = f;
    }

    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < n; i++) {
      if (s[i] < lo) lo = s[i];
      if (s[i] > hi) hi = s[i];
    }
    scalar = s;
    scalarRange = { lo: lo, hi: hi };
  }

  // Is the scalar field already elevation in meters?
  function isMeters() {
    if (!src) return false;
    if (src.channels === 3 && (cfg.channel === 'terrainrgb' || cfg.channel === 'terrarium')) {
      return true;
    }
    return src.units === 'm';
  }

  function makeMapper() {
    if (isMeters()) {
      var off = cfg.offsetM, inv = cfg.invert;
      return function (v) { return (inv ? -v : v) - off; };
    }
    // Raw levels: the user places sea level and the height of the highest point,
    // which together fix the scale. Far easier to steer than "meters per unit".
    var sea = cfg.seaRaw;
    var span = scalarRange.hi - sea;
    var mpu = Math.abs(span) > 1e-6 ? cfg.topM / span : 0;
    var inv2 = cfg.invert;
    return function (v) {
      var x = inv2 ? (scalarRange.hi + scalarRange.lo - v) : v;
      return (x - sea) * mpu;
    };
  }

  function metersPerLevel() {
    if (isMeters()) return 0;
    var span = scalarRange.hi - cfg.seaRaw;
    return Math.abs(span) > 1e-6 ? cfg.topM / span : 0;
  }

  // ------------------------------------------------------ crop / sampling ---

  // The crop box is a square in METERS. On a geographic grid the pixels are not
  // square (a degree of longitude shrinks with latitude), so its pixel height is
  // scaled — the same cos(lat) correction fetch_terrain.py makes.
  function yScale() {
    if (src && src.georef && src.georef.mPerPxY) return src.georef.mPerPxX / src.georef.mPerPxY;
    return 1;
  }

  function domainMeters() {
    if (src && src.georef) return 2 * box.s * src.georef.mPerPxX;
    return cfg.widthKm * 1000;
  }

  // Box axes in source-pixel space. Screen y is down, so "up" is negative y.
  function axes() {
    var c = Math.cos(box.angle), s = Math.sin(box.angle);
    var ys = yScale();
    return {
      rx: c, ry: -s * ys,        // box right
      ux: -s, uy: -c * ys        // box up
    };
  }

  function bilinear(f, w, h, x, y) {
    x = x < 0 ? 0 : (x > w - 1 ? w - 1 : x);
    y = y < 0 ? 0 : (y > h - 1 ? h - 1 : y);
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 < w ? x0 + 1 : w - 1, y1 = y0 + 1 < h ? y0 + 1 : h - 1;
    var fx = x - x0, fy = y - y0;
    var a = f[y0 * w + x0] * (1 - fx) + f[y0 * w + x1] * fx;
    var b = f[y1 * w + x0] * (1 - fx) + f[y1 * w + x1] * fx;
    return a * (1 - fy) + b * fy;
  }

  // Sample the crop box into an N x N grid. Output row 0 is the box's BOTTOM
  // edge, which is the sim's south edge — the side the tsunami comes from.
  function sampleBox(N) {
    var w = src.w, h = src.h, ax = axes();
    var g = new Float32Array(N * N);
    var fx = cfg.flipX ? -1 : 1, fy = cfg.flipY ? -1 : 1;
    for (var j = 0; j < N; j++) {
      var b = ((j + 0.5) / N - 0.5) * 2 * box.s * fy;
      for (var i = 0; i < N; i++) {
        var a = ((i + 0.5) / N - 0.5) * 2 * box.s * fx;
        // Box coordinates are pixel EDGES; bilinear wants pixel CENTRES, which
        // sit half a pixel in. Without the -0.5 every import is shifted half a
        // cell and quietly 2-tap blurred even at 1:1 scale. fetch_terrain.py and
        // main.js's own resampler both make this correction.
        var sx = box.cx + a * ax.rx + b * ax.ux - 0.5;
        var sy = box.cy + a * ax.ry + b * ax.uy - 0.5;
        g[j * N + i] = bilinear(scalar, w, h, sx, sy);
      }
    }
    return g;
  }

  // ------------------------------------------------------------ bathymetry --

  // Ocean = at-or-below sea level AND connected to the edge of the map. The
  // connectivity test is what keeps inland lakes and quarries from being gouged
  // into a 60 m shelf. Seeding from all four borders (not just the wave edge)
  // means the seabed appears before you have finished aiming the crop.
  function oceanMask(elev, N) {
    var mask = new Uint8Array(N * N);
    var q = new Int32Array(N * N);
    var head = 0, tail = 0, k, i;
    function seed(idx) {
      if (!mask[idx] && elev[idx] <= 0) { mask[idx] = 1; q[tail++] = idx; }
    }
    for (i = 0; i < N; i++) {
      seed(i);                    // south
      seed((N - 1) * N + i);      // north
      seed(i * N);                // west
      seed(i * N + N - 1);        // east
    }
    while (head < tail) {
      k = q[head++];
      var x = k % N, y = (k / N) | 0;
      if (x > 0 && !mask[k - 1] && elev[k - 1] <= 0) { mask[k - 1] = 1; q[tail++] = k - 1; }
      if (x < N - 1 && !mask[k + 1] && elev[k + 1] <= 0) { mask[k + 1] = 1; q[tail++] = k + 1; }
      if (y > 0 && !mask[k - N] && elev[k - N] <= 0) { mask[k - N] = 1; q[tail++] = k - N; }
      if (y < N - 1 && !mask[k + N] && elev[k + N] <= 0) { mask[k + N] = 1; q[tail++] = k + N; }
    }
    return mask;
  }

  // Chamfer 3-4 distance (in cells) from the nearest non-ocean cell.
  function distanceFromLand(mask, N) {
    var BIG = 1e9;
    var d = new Float32Array(N * N);
    var i, j, k;
    for (k = 0; k < N * N; k++) d[k] = mask[k] ? BIG : 0;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        k = j * N + i;
        if (!d[k]) continue;
        var m = d[k];
        if (j > 0) m = Math.min(m, d[k - N] + 3);
        if (i > 0) m = Math.min(m, d[k - 1] + 3);
        if (j > 0 && i > 0) m = Math.min(m, d[k - N - 1] + 4);
        if (j > 0 && i < N - 1) m = Math.min(m, d[k - N + 1] + 4);
        d[k] = m;
      }
    }
    for (j = N - 1; j >= 0; j--) {
      for (i = N - 1; i >= 0; i--) {
        k = j * N + i;
        if (!d[k]) continue;
        var m2 = d[k];
        if (j < N - 1) m2 = Math.min(m2, d[k + N] + 3);
        if (i < N - 1) m2 = Math.min(m2, d[k + 1] + 3);
        if (j < N - 1 && i < N - 1) m2 = Math.min(m2, d[k + N + 1] + 4);
        if (j < N - 1 && i > 0) m2 = Math.min(m2, d[k + N - 1] + 4);
        d[k] = m2;
      }
    }
    for (k = 0; k < N * N; k++) d[k] /= 3;
    return d;
  }

  function synthBathymetry(elev, N, L) {
    var mask = oceanMask(elev, N);
    var dist = distanceFromLand(mask, N);
    var dx = L / N;
    var slope = cfg.shelfSlope / 1000;        // m of depth per m of distance
    var cap = cfg.shelfDepth;
    var touched = 0;
    for (var k = 0; k < N * N; k++) {
      if (!mask[k]) continue;
      var target = -Math.min(cap, dist[k] * dx * slope);
      if (target < elev[k]) { elev[k] = target; touched++; }
    }
    return touched;
  }

  // Real elevation data is full of one- and two-cell dips that are sampling
  // noise, not landscape. The solver treats a cell face as a wall at the higher
  // of the two beds (which is correct), so every one of those dips traps water
  // forever and the map ends up speckled with permanent puddles. Raise each dip
  // to just above its lowest neighbour — capped, so genuine basins, lagoons and
  // lakes survive untouched. The epsilon leaves a whisker of slope so the filled
  // cell drains instead of becoming a flat pan.
  function fillPits(elev, N, maxFill, passes) {
    var filled = 0, EPS = 0.002;
    for (var p = 0; p < passes; p++) {
      var changed = 0;
      for (var j = 1; j < N - 1; j++) {
        for (var i = 1; i < N - 1; i++) {
          var k = j * N + i, v = elev[k];
          var m = elev[k - 1];
          if (elev[k + 1] < m) m = elev[k + 1];
          if (elev[k - N] < m) m = elev[k - N];
          if (elev[k + N] < m) m = elev[k + N];
          if (v < m) {
            var t = m + EPS;
            if (t > v + maxFill) t = v + maxFill;
            if (t > v) { elev[k] = t; changed++; }
          }
        }
      }
      filled += changed;
      if (!changed) break;
    }
    return filled;
  }

  // The solver pushes the wave in through a forcing strip at row 0. If that strip
  // is dry or paper-thin the wave has nothing to push, so level it to the depth
  // just inland of it.
  function flattenEntry(elev, N) {
    var band = Math.max(3, Math.round(N * 0.02));
    var deepest = 0;
    for (var j = band; j < band * 2 && j < N; j++) {
      for (var i = 0; i < N; i++) {
        var v = elev[j * N + i];
        if (v < deepest) deepest = v;
      }
    }
    if (deepest >= -0.5) return 0;
    var changed = 0, ii, k;
    for (var jj = 0; jj < band; jj++) {          // flat channel at the boundary
      for (ii = 0; ii < N; ii++) {
        k = jj * N + ii;
        if (elev[k] > deepest) { elev[k] = deepest; changed++; }
      }
    }
    for (var jr = band; jr < band * 2 && jr < N; jr++) {   // ramp back to the terrain
      var target = deepest * (1 - (jr - band) / band);
      for (ii = 0; ii < N; ii++) {
        k = jr * N + ii;
        if (elev[k] > target) { elev[k] = target; changed++; }
      }
    }
    return changed;
  }

  // ------------------------------------------------------------- pipeline ---

  function compute(N) {
    var L = domainMeters();
    var raw = sampleBox(N);
    var map = makeMapper();
    var elev = new Float32Array(N * N);
    var k;
    for (k = 0; k < N * N; k++) elev[k] = map(raw[k]);

    var pitted = 0;
    if (cfg.fillPits) pitted = fillPits(elev, N, cfg.maxFill, 6);

    var synthesized = 0;
    if (cfg.bathy) synthesized = synthBathymetry(elev, N, L);
    if (cfg.clampDepth) {
      for (k = 0; k < N * N; k++) if (elev[k] < -cfg.maxDepth) elev[k] = -cfg.maxDepth;
    }
    if (cfg.flatten) flattenEntry(elev, N);

    // --- statistics the warnings are built from
    var lo = Infinity, hi = -Infinity, wet = 0;
    for (k = 0; k < N * N; k++) {
      if (elev[k] < lo) lo = elev[k];
      if (elev[k] > hi) hi = elev[k];
      if (elev[k] < 0) wet++;
    }
    var band = Math.max(3, Math.round(N * 0.02));
    var entryWater = 0, entryDepth = 0;
    for (var i = 0; i < N; i++) {
      var v = elev[i];
      if (v < 0) { entryWater++; entryDepth += -v; }
    }
    entryDepth = entryWater ? entryDepth / entryWater : 0;

    // Always report cell size and timestep for the resolution being EXPORTED,
    // not the coarse preview grid — otherwise the numbers are 4x off.
    var dx = L / cfg.N;
    var maxDepth = Math.max(0, -lo);
    var dt = maxDepth > 0.1 ? 0.4 * dx / Math.sqrt(G * maxDepth) : 0;

    return {
      N: N, L: L, data: elev,
      stats: {
        lo: lo, hi: hi, dx: dx, waterFrac: wet / (N * N),
        entryFrac: entryWater / N, entryDepth: entryDepth,
        maxDepth: maxDepth, dt: dt, synthesized: synthesized, pitted: pitted
      }
    };
  }

  function warnings(r) {
    var s = r.stats, m = [];
    if (s.entryFrac < 0.6) {
      m.push(['warn', Math.round((1 - s.entryFrac) * 100) + '% of the wave-entry edge is ' +
        'land. The wave will hit a wall. Rotate the crop so open water runs along the ' +
        'bottom edge, or move the box seaward.']);
    } else if (s.entryDepth < 8 && s.entryDepth > 0) {
      m.push(['warn', 'The entry edge averages only ' + s.entryDepth.toFixed(1) + ' m deep. ' +
        'Deepen the shelf or clamp less aggressively, or the wave will break immediately.']);
    }
    if (s.waterFrac < 0.06) {
      m.push(['warn', 'Almost no water in this map (' + Math.round(s.waterFrac * 100) +
        '%). Raise sea level until a coastline appears in the preview.']);
    } else if (s.waterFrac > 0.94) {
      m.push(['warn', 'Almost all water — there is no land to flood. Lower sea level.']);
    }
    if (s.hi - Math.max(0, s.lo) < 3 && s.hi < 3) {
      m.push(['warn', 'The land is essentially flat (highest point ' + s.hi.toFixed(1) +
        ' m). Raise "height of the highest point".']);
    }
    if (s.dx > 60) {
      m.push(['tip', 'Cells are ' + Math.round(s.dx) + ' m across — inlets, harbours and ' +
        'barrier beaches narrower than that will not exist. Raise the resolution or ' +
        'crop a smaller area.']);
    }
    if (s.dt > 0 && s.dt < 0.02) {
      m.push(['tip', 'Deep water forces a ~' + (s.dt * 1000).toFixed(0) +
        ' ms timestep, so the run will be slow. Clamping depth to 100–200 m helps a lot.']);
    }
    var mpl = metersPerLevel();
    if (mpl > 0 && src && src.maxValue === 255 && mpl > 0.8) {
      m.push(['tip', 'This is an 8-bit image: each grey level is ' + mpl.toFixed(1) +
        ' m, so the terrain will look terraced. A 16-bit PNG or a real DEM avoids it.']);
    }
    if (cfg.bathy && s.synthesized > 0) {
      m.push(['tip', 'Seabed synthesized for ' + Math.round(s.synthesized / (r.N * r.N) * 100) +
        '% of the map — sloping to ' + cfg.shelfDepth + ' m. Real bathymetry (GMRT tab) ' +
        'will give more truthful run-up.']);
    }
    return m;
  }

  // ------------------------------------------------------------- painting ---

  function terrainColor(B, o, p) {
    var r, g, b;
    if (B < 0) {
      var t = Math.max(0, Math.min(1, 1 + B / 60));
      r = 0.13 + (0.42 - 0.13) * t; g = 0.19 + (0.46 - 0.19) * t; b = 0.26 + (0.44 - 0.26) * t;
      // tint deep water bluer so the shelf reads at a glance
      var dp = Math.max(0, Math.min(1, -B / 120));
      r *= 1 - 0.55 * dp; g *= 1 - 0.25 * dp; b *= 1 + 0.15 * dp;
    } else {
      var sm = function (a, bb, x) {
        var u = Math.max(0, Math.min(1, (x - a) / (bb - a)));
        return u * u * (3 - 2 * u);
      };
      var t1 = sm(0.5, 6, B);
      r = 0.78 + (0.42 - 0.78) * t1; g = 0.71 + (0.52 - 0.71) * t1; b = 0.55 + (0.33 - 0.55) * t1;
      var t2 = sm(35, 110, B);
      r += (0.48 - r) * t2; g += (0.41 - g) * t2; b += (0.31 - b) * t2;
      var t3 = sm(140, 250, B);
      r += (0.58 - r) * t3; g += (0.57 - g) * t3; b += (0.55 - b) * t3;
    }
    o[p] = Math.max(0, Math.min(255, r * 255));
    o[p + 1] = Math.max(0, Math.min(255, g * 255));
    o[p + 2] = Math.max(0, Math.min(255, b * 255));
    o[p + 3] = 255;
  }

  // Shared painter: elevation grid -> ImageData, hillshaded, north-up.
  // flipRows is for the output grid, whose row 0 is the south edge.
  function paintGrid(grid, w, h, cellM, flipRows) {
    var img = new ImageData(w, h);
    var px = img.data;
    var lx = -0.6, ly = 0.8, ln = Math.sqrt(lx * lx + ly * ly);
    lx /= ln; ly /= ln;
    for (var y = 0; y < h; y++) {
      var sy = flipRows ? h - 1 - y : y;
      for (var x = 0; x < w; x++) {
        var k = sy * w + x;
        var B = grid[k];
        var p = (y * w + x) * 4;
        terrainColor(B, px, p);
        // hillshade — the gradient sign flips with the row order
        var xe = x < w - 1 ? grid[k + 1] : B, xw = x > 0 ? grid[k - 1] : B;
        var yn = sy < h - 1 ? grid[k + w] : B, ys = sy > 0 ? grid[k - w] : B;
        var gx = (xe - xw) / (2 * cellM);
        var gy = (yn - ys) / (2 * cellM) * (flipRows ? 1 : -1);
        var shade = Math.max(0.45, Math.min(1.35, 0.85 + 1.6 * (gx * lx + gy * ly)));
        px[p] *= shade; px[p + 1] *= shade; px[p + 2] *= shade;
        // coastline
        var mn = Math.min(B, Math.min(xe, Math.min(xw, Math.min(yn, ys))));
        var mx = Math.max(B, Math.max(xe, Math.max(xw, Math.max(yn, ys))));
        if (mn <= 0 && mx > 0) {
          px[p] = px[p] * 0.35 + 10; px[p + 1] = px[p + 1] * 0.35 + 10;
          px[p + 2] = px[p + 2] * 0.35 + 12;
        }
      }
    }
    return img;
  }

  // Source preview: downscaled, coloured by the CURRENT mapping so the sea-level
  // slider visibly moves the shoreline.
  function paintSource() {
    if (!scalar) return;
    var w = src.w, h = src.h;
    var ys = yScale();
    // True shape: height/width in METERS, not in pixels. On a lat/lon grid a
    // pixel is taller than it is wide, so h/w alone would squash the coastline.
    var aspect = h / (w * ys);
    var pw = Math.min(SRC_MAX, w), ph = Math.round(pw * aspect);
    if (ph > SRC_MAX) { ph = SRC_MAX; pw = Math.round(ph / aspect); }
    srcScale = w / pw;

    var map = makeMapper();
    var small = new Float32Array(pw * ph);
    for (var y = 0; y < ph; y++) {
      var sy = (y + 0.5) / ph * h - 0.5;
      for (var x = 0; x < pw; x++) {
        var sx = (x + 0.5) / pw * w - 0.5;
        small[y * pw + x] = map(bilinear(scalar, w, h, sx, sy));
      }
    }
    var cellM = src.georef ? src.georef.mPerPxX * srcScale : 30 * srcScale;
    srcImage = paintGrid(small, pw, ph, cellM, false);

    var cv = ui.srcCanvas;
    cv.width = pw + PAD * 2; cv.height = ph + PAD * 2;
    cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
    drawSourceOverlay();
  }

  // The crop box, its wave-entry edge, and the compass, drawn over the source.
  function drawSourceOverlay() {
    var cv = ui.srcCanvas;
    if (!cv || !srcImage) return;
    var cx2 = cv.getContext('2d');
    cx2.fillStyle = '#0e1115';
    cx2.fillRect(0, 0, cv.width, cv.height);
    cx2.putImageData(srcImage, PAD, PAD);

    var ys = yScale();
    // source px -> canvas px. The preview's pixel height already carries the
    // aspect correction, so y picks up an extra 1/ys that x does not.
    var kx = 1 / srcScale, ky = kx / ys;
    var ax = axes();
    var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (c) {
      var a = c[0] * box.s, b = c[1] * box.s;
      return [(box.cx + a * ax.rx + b * ax.ux) * kx + PAD,
              (box.cy + a * ax.ry + b * ax.uy) * ky + PAD];
    });

    cx2.save();
    // dim everything outside the box
    cx2.fillStyle = 'rgba(8,10,13,0.55)';
    cx2.beginPath();
    cx2.rect(0, 0, cv.width, cv.height);
    cx2.moveTo(corners[0][0], corners[0][1]);
    for (var i = 3; i >= 1; i--) cx2.lineTo(corners[i][0], corners[i][1]);
    cx2.closePath();
    cx2.fill('evenodd');

    // box outline
    cx2.strokeStyle = '#3ad6c8';
    cx2.lineWidth = 1.5;
    cx2.beginPath();
    cx2.moveTo(corners[0][0], corners[0][1]);
    for (var j = 1; j < 4; j++) cx2.lineTo(corners[j][0], corners[j][1]);
    cx2.closePath();
    cx2.stroke();

    // The wave-entry edge is b = -s (corners 0 -> 1). b = +s is the box's "up",
    // i.e. INLAND — marking that edge pointed everyone at the wrong side of the
    // map. Sampling was always right; only this overlay lied.
    var e0 = corners[0], e1 = corners[1];
    var grd = cx2.createLinearGradient(e0[0], e0[1], e1[0], e1[1]);
    grd.addColorStop(0, 'rgba(90,200,255,.9)');
    grd.addColorStop(0.5, 'rgba(160,230,255,1)');
    grd.addColorStop(1, 'rgba(90,200,255,.9)');
    cx2.strokeStyle = grd;
    cx2.lineWidth = 5;
    cx2.lineCap = 'round';
    cx2.beginPath();
    cx2.moveTo(e0[0], e0[1]);
    cx2.lineTo(e1[0], e1[1]);
    cx2.stroke();

    // Arrows sit OUTSIDE the lit edge and run toward it: the wave comes in from
    // open water, crosses that edge, and heads inland. Drawn inside the box they
    // read as "the wave starts here and leaves", which is backwards.
    var mx = (e0[0] + e1[0]) / 2, my = (e0[1] + e1[1]) / 2;
    var inx = ax.ux * kx, iny = ax.uy * ky;        // box "up" = inland
    var iln = Math.sqrt(inx * inx + iny * iny) || 1;
    inx /= iln; iny /= iln;
    var sx2 = -iny, sy2 = inx;                     // along the lit edge
    var TAIL = 40, TIP = 9, HEAD = 8, WING = 5;    // px, measured outward
    cx2.strokeStyle = 'rgba(160,230,255,.95)';
    cx2.fillStyle = 'rgba(160,230,255,.95)';
    cx2.lineWidth = 2;
    cx2.lineCap = 'butt';
    for (var a2 = -1; a2 <= 1; a2++) {
      var bx = mx + sx2 * a2 * 26, by = my + sy2 * a2 * 26;
      cx2.beginPath();
      cx2.moveTo(bx - inx * TAIL, by - iny * TAIL);
      cx2.lineTo(bx - inx * (TIP + HEAD), by - iny * (TIP + HEAD));
      cx2.stroke();
      cx2.beginPath();
      cx2.moveTo(bx - inx * TIP, by - iny * TIP);                 // point at the edge
      cx2.lineTo(bx - inx * (TIP + HEAD) + sx2 * WING, by - iny * (TIP + HEAD) + sy2 * WING);
      cx2.lineTo(bx - inx * (TIP + HEAD) - sx2 * WING, by - iny * (TIP + HEAD) - sy2 * WING);
      cx2.closePath();
      cx2.fill();
    }

    // corner handles
    cx2.fillStyle = '#3ad6c8';
    corners.forEach(function (c) {
      cx2.beginPath();
      cx2.arc(c[0], c[1], 4, 0, Math.PI * 2);
      cx2.fill();
    });
    cx2.restore();
  }

  function paintOutput() {
    if (!out) return;
    var cv = ui.outCanvas;
    var n = out.N;
    cv.width = n; cv.height = n;
    cv.style.width = '256px'; cv.style.height = '256px';
    var g = cv.getContext('2d');
    g.putImageData(paintGrid(out.data, n, n, out.L / n, true), 0, 0);
    // mark the wave-entry edge along the bottom
    var grd = g.createLinearGradient(0, n, 0, n - n * 0.06);
    grd.addColorStop(0, 'rgba(120,215,255,.75)');
    grd.addColorStop(1, 'rgba(120,215,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, n - n * 0.06, n, n * 0.06);
  }

  // ------------------------------------------------------------ refreshing --

  var pending = null, pendingSrc = false;
  function refresh(sourceChanged) {
    if (!src) return;
    if (sourceChanged) buildScalar();
    // Coalescing must not lose a source repaint: a refresh(false) landing in the
    // same frame as a refresh(true) would otherwise cancel it and leave the
    // source preview blank forever.
    pendingSrc = pendingSrc || !!sourceChanged;
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(function () {
      pending = null;
      if (pendingSrc) paintSource(); else drawSourceOverlay();
      pendingSrc = false;
      out = compute(PREVIEW_N);
      paintOutput();
      renderStats();
      syncBoxReadouts();
    });
  }

  function renderStats() {
    if (!out) return;
    var s = out.stats;
    var bytes = cfg.N * cfg.N * 4;
    ui.stats.innerHTML = '';
    [['domain', (out.L / 1000).toFixed(2) + ' km square'],
     ['cell size', (out.L / cfg.N).toFixed(1) + ' m at ' + cfg.N + '²'],
     ['elevation', s.lo.toFixed(0) + ' … ' + s.hi.toFixed(0) + ' m'],
     ['water', Math.round(s.waterFrac * 100) + '% of the map'],
     ['entry edge', Math.round(s.entryFrac * 100) + '% water, ' +
       s.entryDepth.toFixed(0) + ' m deep'],
     ['est. timestep', s.dt > 0 ? (s.dt * 1000).toFixed(0) + ' ms' : '—'],
     ['file', fmtBytes(bytes) + (TS.tsu.canCompress() ? ' → ~' + fmtBytes(bytes * 0.3) : '')]
    ].forEach(function (p) {
      add(ui.stats, el('dt', null, p[0]));
      add(ui.stats, el('dd', null, p[1]));
    });

    ui.msgs.innerHTML = '';
    warnings(out).forEach(function (m) {
      var d = add(ui.msgs, el('div', 'msg ' + m[0]));
      add(d, el('span', 'ic', m[0] === 'warn' ? '⚠' : '💡'));
      add(d, el('span', null, m[1]));
    });
  }

  // ------------------------------------------------------ box interaction ---

  function bindCanvas(cv) {
    var drag = null;

    // Screen -> source pixels (the inverse of the PAD/kx/ky used when drawing).
    function pos(e) {
      var r = cv.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) * (cv.width / r.width) - PAD) * srcScale,
        y: ((e.clientY - r.top) * (cv.height / r.height) - PAD) * srcScale * yScale()
      };
    }

    cv.addEventListener('pointerdown', function (e) {
      if (!src) return;
      cv.setPointerCapture(e.pointerId);
      var p = pos(e);
      var d = Math.sqrt(Math.pow(p.x - box.cx, 2) + Math.pow((p.y - box.cy) / yScale(), 2));
      var corner = Math.abs(d - box.s * 1.414) < box.s * 0.22;
      drag = {
        mode: e.shiftKey ? 'rotate' : (corner ? 'size' : 'move'),
        x: p.x, y: p.y, cx: box.cx, cy: box.cy, s: box.s, angle: box.angle,
        a0: Math.atan2(-(p.y - box.cy), p.x - box.cx), d0: d
      };
      e.preventDefault();
    });

    cv.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var p = pos(e);
      if (drag.mode === 'move') {
        box.cx = drag.cx + (p.x - drag.x);
        box.cy = drag.cy + (p.y - drag.y);
      } else if (drag.mode === 'size') {
        var d = Math.sqrt(Math.pow(p.x - box.cx, 2) + Math.pow((p.y - box.cy) / yScale(), 2));
        box.s = Math.max(8, drag.s * (d / Math.max(drag.d0, 1)));
      } else {
        var a = Math.atan2(-(p.y - box.cy), p.x - box.cx);
        box.angle = drag.angle + (a - drag.a0);
      }
      clampBox();
      refresh(false);
      syncBoxReadouts();
    });

    function end(e) {
      if (drag && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      drag = null;
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    cv.addEventListener('wheel', function (e) {
      if (!src) return;
      e.preventDefault();
      box.s = Math.max(8, box.s * (e.deltaY > 0 ? 1.08 : 1 / 1.08));
      clampBox();
      refresh(false);
      syncBoxReadouts();
    }, { passive: false });
  }

  function clampBox() {
    var lim = Math.max(src.w, src.h / yScale()) * 1.5;
    box.s = Math.min(box.s, lim);
    box.cx = Math.max(-src.w * 0.5, Math.min(src.w * 1.5, box.cx));
    box.cy = Math.max(-src.h * 0.5, Math.min(src.h * 1.5, box.cy));
  }

  function syncBoxReadouts() {
    if (!src) return;
    if (ui.kmOut) {
      ui.kmOut.textContent = (domainMeters() / 1000).toFixed(2) + ' km';
    }
    if (ui.rotOut) {
      var deg = (box.angle * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      ui.rotOut.textContent = deg.toFixed(0) + '°';
    }
  }

  function fitBox() {
    var ys = yScale();
    box.cx = src.w / 2;
    box.cy = src.h / 2;
    box.angle = 0;
    box.s = Math.min(src.w, src.h / ys) / 2;
    if (src.georef) cfg.widthKm = 2 * box.s * src.georef.mPerPxX / 1000;
  }

  // --------------------------------------------------------- source intake --

  function setSource(s) {
    src = s;
    cfg.channel = s.channels === 3 ? 'lum' : 'lum';
    cfg.invert = false;
    cfg.offsetM = 0;
    buildScalar();
    // Sensible opening guesses so the first preview is already close.
    if (!isMeters()) {
      cfg.seaRaw = scalarRange.lo + (scalarRange.hi - scalarRange.lo) * 0.25;
      cfg.topM = 300;
      cfg.bathy = true;
    } else {
      cfg.bathy = scalarRange.lo > -1;    // real bathymetry already present?
    }
    fitBox();
    buildRight();
    ui.drop.classList.add('slim');
    ui.drop.innerHTML = 'Drop or click to load a different heightmap';
    ui.canvases.style.display = 'flex';
    ui.srcNote.textContent = s.note;
    ui.srcNote.style.display = '';
    ui.useBtn.disabled = false;
    ui.dlBtn.disabled = false;
    refresh(true);
    syncBoxReadouts();
  }

  function loadFile(f) {
    if (!f) return;
    setBusy('reading ' + f.name + '…');
    TS.decode.file(f).then(function (s) {
      setBusy(null);
      setSource(s);
    })['catch'](function (err) {
      setBusy(null);
      showErr(err.message || String(err));
    });
  }

  function stopTick() {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
  }

  // tick: append a running clock. A number that keeps moving is the clearest
  // possible "this is working, not hung" for a request that can take 10 seconds.
  function setBusy(msg, tick) {
    stopTick();
    if (!ui.status) return;
    ui.status.className = 'grow busy';
    ui.status.textContent = msg || '';
    if (msg && tick) {
      var t0 = Date.now();
      busyTimer = setInterval(function () {
        if (!root || !ui.status) { stopTick(); return; }
        ui.status.textContent = msg + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
      }, 100);
    }
  }

  function showErr(msg) {
    stopTick();
    if (!ui.status) return;
    ui.status.className = 'grow err';
    ui.status.textContent = '⚠ ' + msg;
  }

  // ------------------------------------------------------------ GMRT fetch --

  // Rough seconds to download, calibrated on a real 40 km fetch at ~100 m
  // (≈8 s). Data volume goes as (km / mresolution)², so both terms are squared.
  function estimateSeconds(km, mres) {
    return 8 * Math.pow(km / 40, 2) * Math.pow(100 / mres, 2);
  }

  function updateEstimate() {
    if (!ui.gEst) return;
    var km = parseFloat(ui.gKm.value), mres = parseInt(ui.gRes.value, 10) || 100;
    if (!isFinite(km) || km <= 0) { ui.gEst.style.display = 'none'; return; }
    var secs = estimateSeconds(km, mres);
    var pretty = secs < 60 ? Math.max(2, Math.round(secs)) + ' seconds' :
      'over a minute' + (secs > 110 ? ' — possibly two' : '');
    var slow = km > SLOW_KM;
    ui.gEst.className = 'msg ' + (slow ? 'warn' : 'tip');
    ui.gEst.innerHTML = '';
    add(ui.gEst, el('span', 'ic', slow ? '⏳' : '💡'));
    var body = add(ui.gEst, el('span'));
    if (km > MAX_KM) {
      body.textContent = MAX_KM + ' km is the maximum — beyond that GMRT tends to ' +
        'time out before it finishes. Reduce the width.';
    } else if (slow) {
      body.innerHTML = 'A ' + Math.round(km) + ' km area takes about <b>' + pretty +
        '</b> to download. Switching Source detail to Medium would cut that to about ' +
        Math.max(2, Math.round(estimateSeconds(km, 250))) + ' s, and at this size you ' +
        'will barely see the difference unless you run at 2048 or higher.';
    } else {
      body.textContent = 'Roughly ' + pretty + ' to download at this size.';
    }
    ui.gEst.style.display = '';
  }

  function fetchGmrt() {
    var lat = parseFloat(ui.gLat.value), lon = parseFloat(ui.gLon.value);
    var km = parseFloat(ui.gKm.value);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(km) || km <= 0) {
      showErr('Enter a latitude, a longitude and a width in km.');
      return;
    }
    if (km > MAX_KM) {
      ui.gKm.value = MAX_KM;
      updateEstimate();
      showErr(MAX_KM + ' km is the maximum — larger areas time out before GMRT ' +
        'finishes building them. Set to ' + MAX_KM + ' km; press Fetch again to go ahead.');
      return;
    }
    // Fetch a box big enough that the square still fits after any rotation.
    var Lf = km * 1000 * 1.45;
    var dLat = Lf / 2 / TS.decode.M_PER_DEG_LAT;
    var dLon = Lf / 2 / (TS.decode.M_PER_DEG_LON * Math.cos(lat * Math.PI / 180));
    var url = 'https://www.gmrt.org/services/GridServer?' +
      'minlatitude=' + (lat - dLat).toFixed(5) +
      '&maxlatitude=' + (lat + dLat).toFixed(5) +
      '&minlongitude=' + (lon - dLon).toFixed(5) +
      '&maxlongitude=' + (lon + dLon).toFixed(5) +
      '&layer=topo&format=esriascii&mresolution=' + (ui.gRes.value || 100);

    var mres = parseInt(ui.gRes.value, 10) || 100;
    var est = estimateSeconds(km, mres);
    setBusy('Fetching land + seabed from GMRT — expect about ' +
      (est < 60 ? Math.max(2, Math.round(est)) + ' seconds' : 'a minute or more') +
      '…', true);
    ui.gBtn.disabled = true;
    ui.gBtn.textContent = 'Fetching…';
    ui.gNote.textContent = 'Downloading a ' + Math.round(km) + ' km area at ~' + mres +
      ' m detail. The counter at the bottom of the window keeps moving the whole ' +
      'time, so you can always tell it is still working rather than stuck.';
    ui.gNote.style.display = '';

    // Give up eventually rather than spinning forever: three times the estimate,
    // never less than a minute, never more than four.
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var budget = Math.min(240, Math.max(60, est * 3)) * 1000;
    var giveUp = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, budget);

    fetch(url, {
      headers: { Accept: 'text/plain' },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(giveUp);
      return r;
    }).then(function (r) {
      if (!r.ok) throw new Error('GMRT returned HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      if (!/^\s*ncols/i.test(text)) {
        throw new Error('GMRT did not return a grid (the area may be too large — ' +
          'try a smaller width or a coarser resolution)');
      }
      var s = TS.decode.asciiGrid(text, 'GMRT ' + lat.toFixed(2) + ', ' + lon.toFixed(2), 'gmrt');
      s.note = 'GMRT merged topo-bathymetry, ' + s.w + '×' + s.h +
        ' — real seabed, already in meters';
      s.gmrt = { lat: lat, lon: lon };
      ui.gBtn.disabled = false;
      ui.gBtn.textContent = 'Fetch terrain';
      ui.gNote.style.display = 'none';
      setBusy(null);
      setSource(s);
      // Open on exactly the square the user asked for.
      cfg.widthKm = km;
      box.s = km * 1000 / 2 / s.georef.mPerPxX;
      cfg.bathy = false;
      clampBox();
      buildRight();
      refresh(false);
      syncBoxReadouts();
      setTab('source');
    })['catch'](function (err) {
      clearTimeout(giveUp);
      ui.gBtn.disabled = false;
      ui.gBtn.textContent = 'Fetch terrain';
      ui.gNote.style.display = 'none';
      var msg = err.message || String(err);
      if (err.name === 'AbortError') {
        msg = 'GMRT did not answer within ' + Math.round(budget / 1000) +
          ' seconds. Try a smaller width, or a coarser Source detail — both cut the ' +
          'download sharply, since it scales with area.';
      } else if (/Failed to fetch/i.test(msg)) {
        msg += ' — check your connection; GMRT must be reachable.';
      }
      showErr(msg);
    });
  }

  // ------------------------------------------------------------- controls ---

  function buildRight() {
    var p = ui.right;
    p.innerHTML = '';

    if (!src) {
      add(p, el('h3', null, 'What you need'));
      var w = add(p, el('div', 'hint'));
      w.innerHTML =
        'A heightmap is any image or grid where the value of each pixel is a ' +
        'height. Drop one in, or fetch real terrain by coordinates.<br><br>' +
        '<b style="color:#c3cad6">Accepted:</b> PNG (8- or 16-bit), JPG, ESRI ASCII ' +
        '<code>.asc</code>, SRTM <code>.hgt</code>, raw <code>.raw</code>/<code>.r16</code>, ' +
        'and existing <code>.tsu</code> maps.<br><br>' +
        'The one thing images cannot tell us is scale — how many meters tall the ' +
        'terrain is, and where the shoreline sits. You set those next, and watch the ' +
        'coastline move as you do.';
      return;
    }

    // --- meaning of the numbers
    add(p, el('h3', null, 'Elevation'));

    if (src.channels === 3) {
      select(p, 'Colour encoding', [
        ['lum', 'Greyscale brightness'],
        ['red', 'Red channel only'],
        ['terrainrgb', 'Mapbox Terrain-RGB (meters)'],
        ['terrarium', 'Mapzen Terrarium (meters)']
      ], cfg.channel, function (v) {
        cfg.channel = v;
        buildScalar();
        if (isMeters()) cfg.bathy = scalarRange.lo > -1;
        else cfg.seaRaw = scalarRange.lo + (scalarRange.hi - scalarRange.lo) * 0.25;
        buildRight();
        refresh(true);
      });
    }

    if (isMeters()) {
      add(p, el('div', 'hint', 'This source is already elevation in meters (' +
        scalarRange.lo.toFixed(0) + ' … ' + scalarRange.hi.toFixed(0) +
        ' m), so nothing needs scaling.'));
      slider(p, 'Sea-level shift', -30, 30, 0.5, cfg.offsetM,
        function (v) { return (v > 0 ? '+' : '') + v.toFixed(1) + ' m'; },
        function (v) { cfg.offsetM = v; refresh(false); });
      add(p, el('div', 'hint', 'Raise it to simulate a storm surge or high tide ' +
        'arriving on top of the tsunami.')).style.marginTop = '-6px';
    } else {
      var lo = scalarRange.lo, hi = scalarRange.hi;
      var step = (hi - lo) / 500 || 1;
      ui.sea = slider(p, 'Sea level', lo, hi, step, cfg.seaRaw,
        function (v) { return 'level ' + Math.round(v); },
        function (v) { cfg.seaRaw = v; refresh(false); });
      add(p, el('div', 'hint', 'Drag until the coastline in the preview matches the ' +
        'real one. Everything below this level becomes sea.')).style.marginTop = '-6px';
      slider(p, 'Height of the highest point', 20, 3000, 10, cfg.topM,
        function (v) { return Math.round(v) + ' m'; },
        function (v) { cfg.topM = v; refresh(false); });
    }
    checkbox(p, 'Invert (dark = high)', cfg.invert, function (v) {
      cfg.invert = v; refresh(false);
    });

    // --- seabed
    add(p, el('h3', null, 'Seabed'));
    checkbox(p, 'Synthesize a seabed', cfg.bathy, function (v) {
      cfg.bathy = v; buildRight(); refresh(false);
    });
    add(p, el('div', 'hint', cfg.bathy ?
      'Most heightmaps stop at the shoreline — there is nothing under the water. ' +
      'This slopes the sea floor away from every coast so the wave has something ' +
      'to travel through. Inland lakes are left alone.' :
      'Off: the source already contains real depths (or you want a flat bottom).'));
    if (cfg.bathy) {
      slider(p, 'Shelf slope', 1, 60, 1, cfg.shelfSlope,
        function (v) { return v + ' m per km'; },
        function (v) { cfg.shelfSlope = v; refresh(false); });
      slider(p, 'Maximum shelf depth', 10, 400, 5, cfg.shelfDepth,
        function (v) { return Math.round(v) + ' m'; },
        function (v) { cfg.shelfDepth = v; refresh(false); });
    }
    checkbox(p, 'Level the wave-entry strip', cfg.flatten, function (v) {
      cfg.flatten = v; refresh(false);
    });

    add(p, el('h3', null, 'Drainage'));
    checkbox(p, 'Fill spurious pits', cfg.fillPits, function (v) {
      cfg.fillPits = v; buildRight(); refresh(false);
    });
    add(p, el('div', 'hint', cfg.fillPits ?
      'Elevation data is speckled with one- and two-cell dips that are sampling ' +
      'noise rather than real ground. Water settles into every one of them and ' +
      'never leaves, leaving the land covered in permanent puddles after the wave ' +
      'recedes. This raises those dips just enough to drain. Real basins, lagoons ' +
      'and lakes are deeper than the limit below, so they survive.' :
      'Off: every dip in the source data is treated as a real basin, and will ' +
      'hold water permanently.'));
    if (cfg.fillPits) {
      slider(p, 'Deepest pit to fill', 0.2, 12, 0.2, cfg.maxFill,
        function (v) { return v.toFixed(1) + ' m'; },
        function (v) { cfg.maxFill = v; refresh(false); });
    }
    checkbox(p, 'Clamp depth (keeps the sim fast)', cfg.clampDepth, function (v) {
      cfg.clampDepth = v; buildRight(); refresh(false);
    });
    if (cfg.clampDepth) {
      slider(p, 'Deepest allowed', 30, 1000, 10, cfg.maxDepth,
        function (v) { return Math.round(v) + ' m'; },
        function (v) { cfg.maxDepth = v; refresh(false); });
    }

    // --- output
    add(p, el('h3', null, 'Output'));
    if (!src.georef) {
      var f = add(p, el('div', 'fld'));
      add(add(f, el('div', 'lbl')), el('span', null, 'How wide is this area, really?'));
      ui.widthKm = add(f, el('input'));
      ui.widthKm.type = 'number';
      ui.widthKm.min = '0.5'; ui.widthKm.step = '0.5';
      ui.widthKm.value = cfg.widthKm;
      ui.widthKm.addEventListener('input', function () {
        var v = parseFloat(ui.widthKm.value);
        if (isFinite(v) && v > 0) { cfg.widthKm = v; refresh(false); syncBoxReadouts(); }
      });
      add(p, el('div', 'hint', 'Kilometres across the crop box. There is no way to ' +
        'know this from an image, and it decides everything — a 5 km map and a ' +
        '50 km map of the same picture behave completely differently.'));
    } else {
      var g = add(p, el('div', 'row'));
      add(g, el('span', null, 'Crop size'));
      ui.kmOut = add(g, el('span', 'val', '—'));
      ui.kmOut.style.marginLeft = 'auto';
      add(p, el('div', 'hint', 'Set by the crop box — this source is georeferenced, ' +
        'so the scale is known. Scroll on the map to resize.'));
    }

    select(p, 'Resolution', [['256', '256'], ['512', '512'], ['1024', '1024'],
      ['2048', '2048'], ['4096', '4096']], cfg.N, function (v) {
      cfg.N = parseInt(v, 10);
      refresh(false);          // cell size and timestep are quoted at this N
    });
    add(p, el('div', 'hint', 'The grid stored in the file. The sim resamples to ' +
      'whatever resolution you run at, so 1024 is plenty unless your source is ' +
      'genuinely finer.')).style.marginTop = '-6px';

    add(p, el('h3', null, 'Result'));
    ui.stats = add(p, el('dl', 'stats'));
  }

  function buildLeft() {
    var p = ui.left;
    p.innerHTML = '';

    var wip = add(p, el('div', 'msg warn'));
    wip.style.marginBottom = '13px';
    add(wip, el('span', 'ic', '⚠'));
    add(wip, el('span', null, 'Work in progress. Real-world maps can show odd ' +
      'artefacts along steep coastlines — patches of water that sit on the shore ' +
      'and never drain; this is a known issue with how shallow standing water is ' +
      'handled. Gentle coastlines and the built-in procedural terrain are unaffected.'));

    var tabs = add(p, el('div', 'tabs'));
    ui.tabSource = button(tabs, 'Your file', 'on', function () { setTab('source'); });
    ui.tabGmrt = button(tabs, 'Fetch real terrain', null, function () { setTab('gmrt'); });

    // --- your file
    ui.paneSource = add(p, el('div'));
    ui.drop = add(ui.paneSource, el('div', 'drop'));
    ui.drop.innerHTML = '<b>Drop a heightmap here</b>' +
      'PNG · JPG · .asc · .hgt · .raw / .r16 · .tsu<br>or click to choose a file';
    var file = add(ui.paneSource, el('input'));
    file.type = 'file';
    file.accept = '.png,.jpg,.jpeg,.webp,.asc,.txt,.grd,.hgt,.raw,.r16,.bin,.tsu,.tsu2,image/*';
    file.style.display = 'none';
    ui.drop.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) loadFile(file.files[0]);
      file.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      ui.drop.addEventListener(t, function (e) {
        e.preventDefault(); ui.drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      ui.drop.addEventListener(t, function (e) {
        e.preventDefault(); ui.drop.classList.remove('over');
      });
    });
    ui.drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    ui.srcNote = add(ui.paneSource, el('div', 'hint', ''));
    ui.srcNote.style.display = 'none';

    ui.canvases = add(ui.paneSource, el('div', 'canvases'));
    ui.canvases.style.display = 'none';
    ui.canvases.style.marginTop = '12px';

    var cw = add(ui.canvases, el('div', 'col'));
    ui.srcCanvas = add(add(cw, el('div', 'cwrap')), el('canvas'));
    ui.srcCanvas.id = 'ts-imp-src';
    var cap = add(cw, el('p', 'cap'));
    cap.innerHTML = '<b>Drag</b> to move · <b>scroll</b> to resize · ' +
      '<b>shift-drag</b> to rotate. The arrows show the tsunami coming in, and the ' +
      'lit edge is where it enters the map.';

    var orient = add(cw, el('div', 'row'));
    orient.style.marginTop = '8px';
    orient.style.flexWrap = 'wrap';
    add(orient, el('span', null, 'Wave from:'));
    // Positive angle turns the box counter-clockwise, which swings its bottom
    // (wave-entry) edge counter-clockwise too: +90 puts that edge on the east.
    // Same convention as fetch_terrain.py's --wave-from.
    [['S', 0], ['E', 90], ['N', 180], ['W', 270]].forEach(function (o) {
      button(orient, o[0], 'sm', function () {
        box.angle = o[1] * Math.PI / 180;
        refresh(false);
        syncBoxReadouts();
      });
    });
    button(orient, '⟲', 'sm', function () {
      box.angle += Math.PI / 36; refresh(false); syncBoxReadouts();
    }).title = 'Rotate 5° counter-clockwise';
    button(orient, '⟳', 'sm', function () {
      box.angle -= Math.PI / 36; refresh(false); syncBoxReadouts();
    }).title = 'Rotate 5° clockwise';
    ui.rotOut = add(orient, el('span', 'val', '0°'));
    button(orient, 'Fit all', 'sm', function () {
      fitBox(); refresh(false); syncBoxReadouts();
    });
    var flips = add(cw, el('div', 'row'));
    checkbox(flips, 'Flip ↔', cfg.flipX, function (v) { cfg.flipX = v; refresh(false); });
    checkbox(flips, 'Flip ↕', cfg.flipY, function (v) { cfg.flipY = v; refresh(false); });

    var ow = add(ui.canvases, el('div', 'col out'));
    ui.outCanvas = add(add(ow, el('div', 'cwrap')), el('canvas'));
    var ocap = add(ow, el('p', 'cap'));
    ocap.innerHTML = '<b>What the sim will get.</b> North is up; the wave comes in ' +
      'along the lit bottom edge.';
    ui.msgs = add(ow, el('div'));
    ui.msgs.style.marginTop = '10px';

    // --- fetch real terrain
    ui.paneGmrt = add(p, el('div'));
    ui.paneGmrt.style.display = 'none';
    var gi = add(ui.paneGmrt, el('div', 'hint'));
    gi.innerHTML = 'Pulls merged land + seabed elevation straight from the ' +
      '<b>GMRT synthesis</b> (Global Multi-Resolution Topography, ~100 m). No key, ' +
      'no account, no download step — and unlike an image heightmap it has <b>real ' +
      'bathymetry</b>, which is what makes run-up believable.';
    gi.style.marginBottom = '12px';

    // Location picker
    if (TS.worldmap && TS.worldData) {
      var mw = add(ui.paneGmrt, el('div', 'mapwrap'));
      ui.mapCanvas = add(mw, el('canvas'));
      ui.mapCanvas.width = 640; ui.mapCanvas.height = 320;
      ui.mapCanvas.className = 'wmap';
      var mrow = add(ui.paneGmrt, el('div', 'row'));
      mrow.style.marginTop = '8px';
      var mcap = add(mrow, el('div', 'hint'));
      mcap.style.flex = '1';
      mcap.style.marginTop = '0';
      mcap.innerHTML = '<b style="color:#c3cad6">Click the coast</b> you want · ' +
        'scroll to zoom · drag to pan. The teal box is the area you would fetch.';
      button(mrow, 'Zoom to pin', 'sm', function () {
        if (ui.wmap) ui.wmap.zoomToPin(parseFloat(ui.gKm.value) || 40);
      });
      button(mrow, 'Whole world', 'sm', function () {
        if (ui.wmap) ui.wmap.reset();
      });
    }

    var r1 = add(ui.paneGmrt, el('div', 'row'));
    var latF = add(r1, el('div')); latF.style.flex = '1';
    add(add(latF, el('div', 'lbl')), el('span', null, 'Latitude'));
    ui.gLat = add(latF, el('input')); ui.gLat.type = 'text'; ui.gLat.value = '38.70';
    var lonF = add(r1, el('div')); lonF.style.flex = '1';
    add(add(lonF, el('div', 'lbl')), el('span', null, 'Longitude'));
    ui.gLon = add(lonF, el('input')); ui.gLon.type = 'text'; ui.gLon.value = '-9.25';

    var r2 = add(ui.paneGmrt, el('div', 'row'));
    var kmF = add(r2, el('div')); kmF.style.flex = '1';
    add(add(kmF, el('div', 'lbl')), el('span', null, 'Width (km)'));
    ui.gKm = add(kmF, el('input')); ui.gKm.type = 'number';
    ui.gKm.value = '40'; ui.gKm.min = '2'; ui.gKm.max = String(MAX_KM);
    ui.gKm.step = '1';
    var rsF = add(r2, el('div')); rsF.style.flex = '1';
    add(add(rsF, el('div', 'lbl')), el('span', null, 'Source detail'));
    ui.gRes = add(rsF, el('select'));
    [['100', 'Finest (~100 m)'], ['250', 'Medium (~250 m)'], ['500', 'Coarse (~500 m)']]
      .forEach(function (o) {
        var op = add(ui.gRes, el('option', null, o[1]));
        op.value = o[0];
      });

    ui.gEst = add(ui.paneGmrt, el('div', 'msg tip'));
    var r3 = add(ui.paneGmrt, el('div', 'row'));
    ui.gBtn = button(r3, 'Fetch terrain', 'pri wide', fetchGmrt);
    ui.gNote = add(ui.paneGmrt, el('div', 'msg tip'));
    ui.gNote.style.display = 'none';
    var tip = add(ui.paneGmrt, el('div', 'hint'));
    tip.innerHTML = '<b style="color:#c3cad6">Download time grows with area</b> — ' +
      'doubling the width roughly quadruples the wait. The estimate above updates as ' +
      'you change the width and the detail, and a counter runs at the bottom of the ' +
      'window while it works.<br><br>' +
      'Coordinates come from any map — right-click a spot in Google Maps and it ' +
      'copies them. Defaults point at Lisbon, levelled by the 1755 tsunami.<br><br>' +
      MAX_KM + ' km is the cap: past that GMRT usually times out before it finishes. ' +
      'For a big stretch of coast, a coarser Source detail is far more effective than ' +
      'patience.';

    // Two-way binding: clicking the map fills the fields, editing the fields
    // moves the pin (recentring only if it would otherwise land off-screen).
    if (ui.mapCanvas) {
      ui.wmap = TS.worldmap.create(ui.mapCanvas, {
        onPick: function (lat, lon) {
          ui.gLat.value = lat.toFixed(4);
          ui.gLon.value = lon.toFixed(4);
          ui.wmap.setExtentKm(parseFloat(ui.gKm.value) || 0);
        }
      });
      var syncPin = function () {
        ui.wmap.setPin(parseFloat(ui.gLat.value), parseFloat(ui.gLon.value), 'auto');
        ui.wmap.setExtentKm(parseFloat(ui.gKm.value) || 0);
      };
      [ui.gLat, ui.gLon, ui.gKm].forEach(function (inp) {
        inp.addEventListener('input', syncPin);
      });
      syncPin();
    }
    [ui.gKm, ui.gRes].forEach(function (inp) {
      inp.addEventListener('input', updateEstimate);
      inp.addEventListener('change', updateEstimate);
    });
    updateEstimate();
  }

  function setTab(which) {
    var s = which === 'source';
    ui.paneSource.style.display = s ? '' : 'none';
    ui.paneGmrt.style.display = s ? 'none' : '';
    ui.tabSource.classList.toggle('on', s);
    ui.tabGmrt.classList.toggle('on', !s);
  }

  // -------------------------------------------------------------- export ----

  function buildMap(N) {
    var r = compute(N);
    var m = {
      N: N, L: r.L, data: r.data,
      // Strip only real extensions: a GMRT source is named "GMRT 38.70, -9.25",
      // and a blanket /\.[^.]+$/ would eat the longitude.
      name: (src.name || 'heightmap')
        .replace(/\.(png|jpe?g|webp|asc|txt|grd|hgt|raw|r16|bin|tsu2?)$/i, ''),
      source: src.kind === 'gmrt' ? 'GMRT synthesis via Tsunami Lab' :
        'imported from ' + (src.name || 'a heightmap'),
      widthKm: +(r.L / 1000).toFixed(3),
      cellSizeM: +(r.L / N).toFixed(2)
    };
    if (src.gmrt) { m.lat = src.gmrt.lat; m.lon = src.gmrt.lon; }
    else if (src.georef && src.georef.lat != null) {
      m.lat = src.georef.lat; m.lon = src.georef.lon;
    }
    return m;
  }

  // The full-resolution pass can take a second at 4096²; yield first so the
  // button visibly changes state instead of the dialog just freezing.
  function withFullMap(label, fn) {
    setBusy(label);
    setTimeout(function () {
      try {
        var m = buildMap(cfg.N);
        setBusy(null);
        fn(m);
      } catch (e) {
        showErr(e.message || String(e));
      }
    }, 30);
  }

  function doDownload() {
    withFullMap('building ' + cfg.N + '² grid…', function (m) {
      setBusy('compressing…');
      TS.tsu.write(m, {}).then(function (blob) {
        setBusy(null);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m.name.replace(/[^\w.\- ]+/g, '_') + '.tsu';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 20000);
        ui.status.className = 'grow';
        ui.status.textContent = 'Saved ' + a.download + ' (' + fmtBytes(blob.size) + ')';
      })['catch'](function (e) { showErr(e.message || String(e)); });
    });
  }

  function doUse() {
    withFullMap('building ' + cfg.N + '² grid…', function (m) {
      close();
      if (opts.onUse) opts.onUse(m);
    });
  }

  // ---------------------------------------------------------------- shell ---

  function close() {
    stopTick();
    if (ui.wmap) ui.wmap.dispose();
    if (root) root.remove();
    root = null;
    ui = {};
    src = null;
    scalar = null;
    out = null;
    srcImage = null;
  }

  function open(options) {
    if (root) return;
    opts = options || {};
    if (!document.getElementById('ts-imp-style')) {
      var st = document.createElement('style');
      st.id = 'ts-imp-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    root = el('div');
    root.id = 'ts-imp';
    var sheet = add(root, el('div', 'sheet'));

    var head = add(sheet, el('div', 'head'));
    add(head, el('h2', null, '🗺 Make a heightmap'));
    add(head, el('div', 'sub', 'Turn any terrain file into a map this sim can flood'));
    var x = add(head, el('button', 'x', '×'));
    x.type = 'button';
    x.addEventListener('click', close);

    var body = add(sheet, el('div', 'body'));
    ui.left = add(body, el('div', 'left'));
    ui.right = add(body, el('div', 'right'));

    var foot = add(sheet, el('div', 'foot'));
    ui.status = add(foot, el('div', 'grow', ''));
    ui.useBtn = button(foot, 'Use in the sim', 'pri', doUse);
    ui.dlBtn = button(foot, 'Save .tsu', null, doDownload);
    button(foot, 'Cancel', null, close);
    ui.useBtn.disabled = true;
    ui.dlBtn.disabled = true;

    document.body.appendChild(root);
    buildLeft();
    buildRight();
    bindCanvas(ui.srcCanvas);

    // Don't let the sim's spacebar shortcut fire from inside the dialog.
    sheet.addEventListener('keydown', function (e) { e.stopPropagation(); });
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (!root) { document.removeEventListener('keydown', esc); return; }
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  return {
    open: open,
    close: close,
    // Test hook for test-import.html — drives the dialog without a real file picker.
    _test: {
      setSource: function (s) { setSource(s); },
      build: function (n) { return buildMap(n); },
      cfg: cfg, box: box,
      apply: function () { refresh(false); return out; }
    }
  };
})();
