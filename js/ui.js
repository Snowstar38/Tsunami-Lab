// TS.ui — control sidebar + bottom timeline. Pure DOM: no WebGL calls live here.
// index.html supplies only #sidebar, #timeline and #view; this file injects all of
// the UI styling and fills those containers. See SPEC.md "TS.ui (agent C)".
window.TS = window.TS || {};
TS.ui = (function () {
  'use strict';

  var SIDEBAR_W = 300;

  var CSS = [
    ':root { --ts-bg:#14171c; --ts-panel:#191d24; --ts-line:#262c36; --ts-fg:#dfe3ea;',
    '  --ts-dim:#8b95a6; --ts-acc:#3ad6c8; --ts-acc-dim:#1f6f69; --ts-warn:#e5544b; }',
    '#sidebar, #timeline { font-family: system-ui, -apple-system, "Segoe UI", Roboto,',
    '  "Helvetica Neue", Arial, sans-serif; font-size:12px; color:var(--ts-fg);',
    '  -webkit-font-smoothing:antialiased; box-sizing:border-box; }',
    '#sidebar *, #timeline * { box-sizing:border-box; }',

    '#sidebar { position:fixed; top:0; right:0; bottom:0; width:' + SIDEBAR_W + 'px;',
    '  background:var(--ts-panel); border-left:1px solid var(--ts-line);',
    '  overflow-y:auto; overflow-x:hidden; padding:0 0 20px; z-index:20; }',
    '#sidebar::-webkit-scrollbar { width:9px; }',
    '#sidebar::-webkit-scrollbar-thumb { background:#2e3540; border-radius:5px; }',
    '#sidebar::-webkit-scrollbar-track { background:transparent; }',

    '.ts-title { padding:14px 14px 10px; font-size:13px; font-weight:600;',
    '  letter-spacing:.04em; color:var(--ts-acc); text-transform:uppercase; }',
    '.ts-group { border-top:1px solid var(--ts-line); padding:11px 14px 14px; }',
    '.ts-group > h3 { margin:0 0 10px; font-size:10.5px; font-weight:700;',
    '  letter-spacing:.11em; text-transform:uppercase; color:var(--ts-dim); }',
    '.ts-row { display:flex; align-items:center; gap:8px; margin-bottom:9px; }',
    '.ts-row:last-child { margin-bottom:0; }',
    '.ts-lbl { display:flex; justify-content:space-between; align-items:baseline;',
    '  margin-bottom:4px; font-size:11.5px; color:#c3cad6; }',
    '.ts-val { color:var(--ts-acc); font-variant-numeric:tabular-nums; font-size:11px; }',
    '.ts-field { margin-bottom:11px; }',
    '.ts-field:last-child { margin-bottom:0; }',
    '.ts-hint { margin-top:5px; font-size:10.5px; line-height:1.35; color:var(--ts-dim); }',

    // inputs
    '.ts-num, .ts-sel { background:#11141a; color:var(--ts-fg); border:1px solid var(--ts-line);',
    '  border-radius:5px; padding:6px 7px; font:inherit; font-size:12px; width:100%;',
    '  min-height:30px; }',
    '.ts-num:focus, .ts-sel:focus { outline:none; border-color:var(--ts-acc-dim); }',
    '.ts-sel { cursor:pointer; }',

    '.ts-btn { background:#232a34; color:var(--ts-fg); border:1px solid var(--ts-line);',
    '  border-radius:5px; padding:7px 10px; font:inherit; font-size:12px; cursor:pointer;',
    '  min-height:30px; white-space:nowrap; transition:background .12s, border-color .12s; }',
    '.ts-btn:hover:not(:disabled) { background:#2c3542; }',
    '.ts-btn:active:not(:disabled) { background:#333d4c; }',
    '.ts-btn:disabled { opacity:.42; cursor:default; }',
    '.ts-btn.primary { background:var(--ts-acc-dim); border-color:var(--ts-acc);',
    '  color:#eafffd; font-weight:600; }',
    '.ts-btn.primary:hover:not(:disabled) { background:#28857e; }',
    '.ts-btn.on { background:var(--ts-acc-dim); border-color:var(--ts-acc); color:#eafffd; }',
    '.ts-btn.wide { flex:1; }',
    '.ts-btn.icon { padding:7px 9px; font-size:14px; line-height:1; }',

    '.ts-check { display:flex; align-items:center; gap:8px; cursor:pointer;',
    '  padding:3px 0; user-select:none; }',
    '.ts-check input { accent-color:var(--ts-acc); width:15px; height:15px; cursor:pointer;',
    '  margin:0; flex:none; }',

    // sliders
    '.ts-range { -webkit-appearance:none; appearance:none; width:100%; height:18px;',
    '  background:transparent; cursor:pointer; margin:0; display:block; }',
    '.ts-range:disabled { opacity:.4; cursor:default; }',
    '.ts-range::-webkit-slider-runnable-track { height:4px; border-radius:2px; background:#2b323d; }',
    '.ts-range::-moz-range-track { height:4px; border-radius:2px; background:#2b323d; }',
    '.ts-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px;',
    '  height:14px; margin-top:-5px; border-radius:50%; background:var(--ts-acc);',
    '  border:none; box-shadow:0 0 0 1px #10131800; }',
    '.ts-range::-moz-range-thumb { width:14px; height:14px; border-radius:50%;',
    '  background:var(--ts-acc); border:none; }',
    '.ts-range:focus { outline:none; }',
    '.ts-range:focus::-webkit-slider-thumb { box-shadow:0 0 0 3px rgba(58,214,200,.25); }',

    // segmented view toggle
    '.ts-seg { display:flex; gap:0; }',
    '.ts-seg .ts-btn { flex:1; border-radius:0; border-right-width:0; }',
    '.ts-seg .ts-btn:first-child { border-radius:5px 0 0 5px; }',
    '.ts-seg .ts-btn:last-child { border-radius:0 5px 5px 0; border-right-width:1px; }',

    // status readout
    '.ts-stat { display:grid; grid-template-columns:auto 1fr; gap:3px 10px;',
    '  font-size:11px; margin-top:10px; padding-top:10px; border-top:1px dashed #242a34; }',
    '.ts-stat dt { color:var(--ts-dim); }',
    '.ts-stat dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; color:#cfd6e2; }',

    // timeline
    '#timeline { position:fixed; left:0; right:' + SIDEBAR_W + 'px; bottom:0; height:46px;',
    '  display:flex; align-items:center; gap:9px; padding:0 13px; z-index:20;',
    '  background:rgba(15,18,23,.82); backdrop-filter:blur(6px);',
    '  border-top:1px solid rgba(255,255,255,.07); }',
    '#ts-scrub { flex:1 1 auto; min-width:60px; }',
    '#ts-time { font-variant-numeric:tabular-nums; font-size:11.5px; color:#c3cad6;',
    '  white-space:nowrap; min-width:86px; text-align:right; }',
    '#ts-live.attn { background:var(--ts-acc); border-color:var(--ts-acc); color:#06231f;',
    '  font-weight:600; }',
    '.ts-speed { width:auto; min-width:62px; padding:5px 6px; }',

    // error banner
    '#ts-error { position:fixed; top:0; left:0; right:' + SIDEBAR_W + 'px; z-index:40;',
    '  display:none; align-items:flex-start; gap:10px; padding:10px 13px;',
    '  background:rgba(150,32,26,.94); color:#fff; font-size:12.5px; line-height:1.45;',
    '  font-family:system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  border-bottom:1px solid #e5544b; }',
    '#ts-error.show { display:flex; }',
    '#ts-error .msg { flex:1; }',
    '#ts-error button { background:transparent; border:none; color:#fff; font-size:16px;',
    '  line-height:1; cursor:pointer; padding:0 2px; opacity:.8; }',
    '#ts-error button:hover { opacity:1; }',

    '@media (max-width:720px) { #sidebar { width:250px; }',
    '  #timeline, #ts-error { right:250px; } }'
  ].join('\n');

  // --- tiny DOM helpers ------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function add(parent, child) { parent.appendChild(child); return child; }

  function group(parent, title) {
    var g = add(parent, el('div', 'ts-group'));
    add(g, el('h3', null, title));
    return g;
  }

  // Labelled range input with a live value readout. fmt(v) -> readout string.
  function slider(parent, label, min, max, step, value, fmt, onInput) {
    var f = add(parent, el('div', 'ts-field'));
    var head = add(f, el('div', 'ts-lbl'));
    add(head, el('span', null, label));
    var out = add(head, el('span', 'ts-val', fmt(value)));
    var inp = add(f, el('input', 'ts-range'));
    inp.type = 'range';
    inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    inp.addEventListener('input', function () {
      var v = parseFloat(inp.value);
      out.textContent = fmt(v);
      onInput(v);
    });
    return inp;
  }

  function checkbox(parent, label, checked, onChange) {
    var lab = add(parent, el('label', 'ts-check'));
    var inp = add(lab, el('input'));
    inp.type = 'checkbox';
    inp.checked = !!checked;
    add(lab, el('span', null, label));
    inp.addEventListener('change', function () { onChange(inp.checked); });
    return inp;
  }

  // options: array of [value, label]
  function select(parent, label, options, value, onChange) {
    var f = add(parent, el('div', 'ts-field'));
    if (label) {
      var head = add(f, el('div', 'ts-lbl'));
      add(head, el('span', null, label));
    }
    var sel = add(f, el('select', 'ts-sel'));
    options.forEach(function (o) {
      var opt = add(sel, el('option', null, o[1]));
      opt.value = o[0];
      return opt;
    });
    sel.value = String(value);
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  function button(parent, label, cls, onClick) {
    var b = add(parent, el('button', 'ts-btn' + (cls ? ' ' + cls : ''), label));
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // index.html supplies these; create them if a host page forgot, so the UI still
  // comes up instead of throwing during init.
  function container(id) {
    var n = document.getElementById(id);
    if (!n) {
      n = el('div');
      n.id = id;
      document.body.appendChild(n);
    }
    return n;
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var sec = Math.floor(s - m * 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function noop() {}

  // Fill in any callback main didn't provide so the UI never throws.
  var CALLBACK_NAMES = ['onRegenerate', 'onResolutionChange', 'onWaveChange',
    'onManningChange', 'onStart', 'onPause', 'onReset', 'onViewMode', 'onExaggeration',
    'onOverlayMaxExtent', 'onScrub', 'onLive', 'onReplayPlay', 'onReplayPause', 'onTurbo',
    'onLoadTerrain', 'onOpenImporter', 'onRotateView', 'onResetView', 'onOutlineChange',
    'onPresetSelect', 'onPresetSave', 'onPresetDelete', 'onPresetExport'];

  // --- state -----------------------------------------------------------------

  var cb = {};
  var d = {};                 // resolved defaults
  var ctl = {};               // control element references
  var running = false;
  var playing = false;        // replay transport state
  var replayDuration = 0;

  function waveParams() {
    return {
      amplitude: parseFloat(ctl.amp.value),
      period: parseFloat(ctl.period.value),
      waveform: ctl.waveform.value,
      trough: parseFloat(ctl.trough.value)
    };
  }

  function terrainParams() {
    return {
      N: parseInt(ctl.res.value, 10),
      seed: parseInt(ctl.seed.value, 10) || 0,
      coastComplexity: parseFloat(ctl.coast.value),
      hilliness: parseFloat(ctl.hills.value),
      barrierIslands: ctl.islands.checked,
      riverValley: ctl.river.checked
    };
  }

  function speed() { return parseFloat(ctl.speed.value) || 1; }

  function setPlaying(on) {
    playing = on;
    ctl.play.textContent = on ? '⏸' : '▶';
    ctl.play.title = on ? 'Pause replay' : 'Play replay';
    ctl.play.classList.toggle('on', on);
  }

  // --- build -----------------------------------------------------------------

  function buildSidebar(root) {
    root.innerHTML = '';
    add(root, el('div', 'ts-title', '🌊 Tsunami'));

    // Presets
    var gp = group(root, 'Presets');
    ctl.preset = select(gp, 'Preset', [['', '— select a preset —']], '',
      function (v) { if (v) cb.onPresetSelect(v); });
    var pRow = add(gp, el('div', 'ts-row'));
    button(pRow, 'Save', 'wide', function () {
      var n = window.prompt('Preset name:');
      if (n) cb.onPresetSave(n);
    });
    button(pRow, 'Delete', 'wide', function () {
      if (ctl.preset.value) cb.onPresetDelete(ctl.preset.value);
    });
    button(pRow, 'Export', 'wide', function () { cb.onPresetExport(ctl.preset.value); });

    // Terrain
    var g = group(root, 'Terrain');
    var seedRow = add(g, el('div', 'ts-row'));
    var seedWrap = add(seedRow, el('div'));
    seedWrap.style.flex = '1';
    add(seedWrap, el('div', 'ts-lbl')).appendChild(el('span', null, 'Seed'));
    ctl.seed = add(seedWrap, el('input', 'ts-num'));
    ctl.seed.type = 'number';
    ctl.seed.step = '1';
    ctl.seed.value = d.seed;
    var dice = button(seedRow, '🎲', 'icon', function () {
      ctl.seed.value = Math.floor(Math.random() * 1000000);
      cb.onRegenerate(terrainParams());
    });
    dice.title = 'Random seed + regenerate';
    dice.style.alignSelf = 'flex-end';

    ctl.coast = slider(g, 'Coast complexity', 0, 1, 0.01, d.coastComplexity,
      function (v) { return v.toFixed(2); }, noop);
    ctl.hills = slider(g, 'Hilliness', 0, 1, 0.01, d.hilliness,
      function (v) { return v.toFixed(2); }, noop);
    ctl.islands = checkbox(g, 'Barrier islands', d.barrierIslands, noop);
    ctl.river = checkbox(g, 'River valley', d.riverValley, noop);
    var regenRow = add(g, el('div', 'ts-row'));
    regenRow.style.marginTop = '10px';
    button(regenRow, 'Regenerate', 'wide primary', function () {
      cb.onRegenerate(terrainParams());
    });

    // Real-world heightmaps: a saved .tsu, or build one from any terrain file.
    var loadRow = add(g, el('div', 'ts-row'));
    loadRow.style.marginTop = '6px';
    var file = add(loadRow, el('input'));
    file.type = 'file';
    file.accept = '.tsu,.tsu2';
    file.style.display = 'none';
    button(loadRow, 'Load heightmap…', 'wide', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) cb.onLoadTerrain(file.files[0]);
      file.value = '';
    });
    var makeRow = add(g, el('div', 'ts-row'));
    button(makeRow, '🗺 Make a heightmap…', 'wide', function () { cb.onOpenImporter(); });
    add(g, el('div', 'ts-hint', 'Import your own terrain, or fetch real land + ' +
      'seabed by coordinates.'));
    ctl.mapname = add(g, el('div', 'ts-hint', ''));
    ctl.mapname.style.display = 'none';

    // Simulation
    g = group(root, 'Simulation');
    ctl.res = select(g, 'Resolution', [
      ['256', '256'], ['512', '512'], ['1024', '1024'],
      ['2048', '2048 — slow'], ['4096', '4096 — very slow, walk away 🌊'],
      ['8192', '8192 — extreme (~6 GB GPU mem)']
    ], d.N, function (v) { cb.onResolutionChange(parseInt(v, 10)); });
    add(g, el('div', 'ts-hint', 'same seed = same coastline at every resolution'))
      .style.marginTop = '-6px';

    ctl.amp = slider(g, 'Wave amplitude', 1, 30, 0.1, d.waveAmplitude,
      function (v) { return v.toFixed(1) + ' m'; },
      function () { cb.onWaveChange(waveParams()); });
    ctl.period = slider(g, 'Wave period', 60, 600, 5, d.wavePeriod,
      function (v) { return Math.round(v) + ' s'; },
      function () { cb.onWaveChange(waveParams()); });
    ctl.waveform = select(g, 'Waveform', [
      ['pulse', 'Pulse'], ['nwave', 'N-wave'], ['sustained', 'Sustained'],
      ['train', 'Wave train']
    ], d.waveform, function () { cb.onWaveChange(waveParams()); });
    ctl.trough = slider(g, 'Trough depth (N-wave / train)', 0, 1, 0.05,
      d.waveTrough != null ? d.waveTrough : 0.35,
      function (v) { return Math.round(v * 100) + '%'; },
      function () { cb.onWaveChange(waveParams()); });
    ctl.manning = slider(g, 'Manning roughness', 0.01, 0.08, 0.001, d.manning,
      function (v) { return v.toFixed(3); },
      function (v) { cb.onManningChange(v); });

    // Run
    g = group(root, 'Run');
    var runRow = add(g, el('div', 'ts-row'));
    ctl.start = button(runRow, 'Start', 'wide primary', function () { cb.onStart(); });
    ctl.pause = button(runRow, 'Pause', 'wide', function () { cb.onPause(); });
    ctl.reset = button(runRow, 'Reset', 'wide', function () { cb.onReset(); });
    ctl.turbo = checkbox(g, 'Turbo (skip rendering)', d.turbo,
      function (v) { cb.onTurbo(v); });

    var dl = add(g, el('dl', 'ts-stat'));
    ctl.stat = {};
    [['simTime', 'sim time'], ['dt', 'dt'], ['steps', 'steps/s'], ['fps', 'fps'],
     ['recorded', 'recorded'], ['mem', 'replay mem']].forEach(function (p) {
      add(dl, el('dt', null, p[1]));
      ctl.stat[p[0]] = add(dl, el('dd', null, '—'));
    });

    // View
    g = group(root, 'View');
    var seg = add(g, el('div', 'ts-seg ts-field'));
    ctl.view2d = button(seg, '2D topo', null, function () { setViewMode('2d', true); });
    ctl.view3d = button(seg, '3D', null, function () { setViewMode('3d', true); });
    ctl.exag = slider(g, 'Vertical exaggeration', 1, 5, 0.1, d.exaggeration,
      function (v) { return v.toFixed(1) + '×'; },
      function (v) { cb.onExaggeration(v); });
    ctl.overlay = checkbox(g, 'Max-inundation overlay (2D)', d.overlayMax,
      function (v) { cb.onOverlayMaxExtent(v); });
    ctl.outline = checkbox(g, 'Original coastline', d.outline !== false,
      function (v) { cb.onOutlineChange(v); });
    var rotRow = add(g, el('div', 'ts-row'));
    button(rotRow, 'Rotate 2D ⟳', 'wide', function () { cb.onRotateView(); });
    button(rotRow, 'Reset view', 'wide', function () { cb.onResetView(); });
    add(g, el('div', 'ts-hint', '2D: drag to pan · scroll to zoom · double-click to reset.'));
  }

  function setViewMode(mode, fire) {
    ctl.view2d.classList.toggle('on', mode === '2d');
    ctl.view3d.classList.toggle('on', mode === '3d');
    if (fire) cb.onViewMode(mode);
  }

  function buildTimeline(root) {
    root.innerHTML = '';
    ctl.live = button(root, 'Live', null, function () {
      setPlaying(false);
      cb.onLive();
    });
    ctl.live.id = 'ts-live';
    ctl.live.title = 'Return to the running simulation';

    ctl.play = button(root, '▶', 'icon', function () {
      if (replayDuration <= 0) return;
      setPlaying(!playing);
      if (playing) cb.onReplayPlay(speed()); else cb.onReplayPause();
    });
    ctl.play.id = 'ts-replay-toggle';

    ctl.speed = add(root, el('select', 'ts-sel ts-speed'));
    ctl.speed.id = 'ts-speed';
    [1, 4, 16, 60].forEach(function (s) {
      var o = add(ctl.speed, el('option', null, s + '×'));
      o.value = String(s);
    });
    ctl.speed.addEventListener('change', function () {
      if (playing) cb.onReplayPlay(speed()); // retarget playback rate live
    });

    ctl.scrub = add(root, el('input', 'ts-range'));
    ctl.scrub.id = 'ts-scrub';
    ctl.scrub.type = 'range';
    ctl.scrub.min = 0; ctl.scrub.max = 0; ctl.scrub.step = 0.05; ctl.scrub.value = 0;
    ctl.scrub.addEventListener('input', function () {
      var t = parseFloat(ctl.scrub.value);
      updateTimeLabel(t);
      cb.onScrub(t);
    });

    ctl.time = add(root, el('div', null, '0:00 / 0:00'));
    ctl.time.id = 'ts-time';

    setReplayRange(0);
  }

  function updateTimeLabel(t) {
    ctl.time.textContent = fmtTime(t) + ' / ' + fmtTime(replayDuration);
  }

  function buildError() {
    var bar = el('div');
    bar.id = 'ts-error';
    var msg = add(bar, el('div', 'msg'));
    var x = add(bar, el('button', null, '×'));
    x.type = 'button';
    x.title = 'Dismiss';
    x.addEventListener('click', function () { bar.classList.remove('show'); });
    document.body.appendChild(bar);
    ctl.error = bar;
    ctl.errorMsg = msg;
  }

  // --- public API ------------------------------------------------------------

  function init(callbacks, defaults) {
    callbacks = callbacks || {};
    CALLBACK_NAMES.forEach(function (n) {
      cb[n] = typeof callbacks[n] === 'function' ? callbacks[n] : noop;
    });

    defaults = defaults || {};
    // Copy every incoming setting, THEN fill gaps. Enumerating keys here instead
    // silently drops any setting added later (waveTrough and outline both were).
    d = {};
    for (var dk in defaults) {
      if (Object.prototype.hasOwnProperty.call(defaults, dk)) d[dk] = defaults[dk];
    }
    var FALLBACK = {
      seed: 12345, coastComplexity: 0.5, hilliness: 0.5, barrierIslands: true,
      riverValley: true, N: 1024, waveAmplitude: 8, wavePeriod: 300,
      waveform: 'nwave', waveTrough: 0.35, manning: 0.03, exaggeration: 2,
      viewMode: '2d', turbo: false, overlayMax: false, outline: true
    };
    for (var fk in FALLBACK) {
      if (d[fk] == null) d[fk] = FALLBACK[fk];
    }

    if (!document.getElementById('ts-ui-style')) {
      var style = document.createElement('style');
      style.id = 'ts-ui-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    buildSidebar(container('sidebar'));
    buildTimeline(container('timeline'));
    buildError();
    setViewMode(d.viewMode, false);
    setStatus({ running: false, mode: 'live' });

    if (init.keysBound) return;
    init.keysBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault(); // also stops the page scrolling
      if (running) cb.onPause(); else cb.onStart();
    });
  }

  function setStatus(s) {
    s = s || {};
    if (!ctl.stat) return;
    if (s.simTime != null) ctl.stat.simTime.textContent = fmtTime(s.simTime);
    if (s.dt != null) ctl.stat.dt.textContent = s.dt < 0.01 ?
      (s.dt * 1000).toFixed(2) + ' ms' : s.dt.toFixed(3) + ' s';
    if (s.stepsPerSec != null) ctl.stat.steps.textContent = Math.round(s.stepsPerSec) + '';
    if (s.fps != null) ctl.stat.fps.textContent = s.fps.toFixed(0);
    if (s.recordedS != null) ctl.stat.recorded.textContent = fmtTime(s.recordedS);
    if (s.memMB != null) ctl.stat.mem.textContent = s.memMB.toFixed(1) + ' MB';

    if (s.running != null) {
      running = !!s.running;
      ctl.start.textContent = running ? 'Running' : 'Start';
      ctl.start.disabled = running;
      ctl.start.classList.toggle('primary', !running);
      ctl.pause.disabled = !running;
    }

    if (s.mode != null) {
      var replay = s.mode === 'replay';
      // Highlight Live only when we've left live, so it reads as "click to return".
      ctl.live.classList.toggle('attn', replay);
      if (!replay && playing) setPlaying(false);
    }

    // Follow the playhead while replay is driving, but never fight a drag.
    if (s.simTime != null && s.mode === 'replay' && document.activeElement !== ctl.scrub) {
      ctl.scrub.value = s.simTime;
      updateTimeLabel(s.simTime);
    }
  }

  function setReplayRange(durationS) {
    replayDuration = durationS > 0 ? durationS : 0;
    ctl.scrub.max = replayDuration;
    var none = replayDuration <= 0;
    ctl.scrub.disabled = none;
    ctl.play.disabled = none;
    ctl.speed.disabled = none;
    if (none && playing) setPlaying(false);
    updateTimeLabel(parseFloat(ctl.scrub.value) || 0);
  }

  function showError(msg) {
    if (!ctl.error) buildError();
    ctl.errorMsg.textContent = msg;
    ctl.error.classList.add('show');
  }

  function setPresetList(items, selected) {
    if (!ctl.preset) return;
    ctl.preset.innerHTML = '';
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = '— select a preset —';
    ctl.preset.appendChild(o0);
    items.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.builtin ? ' ★' : '');
      ctl.preset.appendChild(o);
    });
    ctl.preset.value = selected || '';
  }

  function setLoadedMap(name, km) {
    if (!ctl.mapname) return;
    if (name) {
      ctl.mapname.textContent = 'Loaded: ' + name + ' (' + km.toFixed(0) +
        ' km) — Regenerate returns to procedural';
      ctl.mapname.style.display = '';
    } else {
      ctl.mapname.style.display = 'none';
    }
  }

  return {
    init: init,
    setStatus: setStatus,
    setReplayRange: setReplayRange,
    setLoadedMap: setLoadedMap,
    setPresetList: setPresetList,
    showError: showError
  };
})();
