// TS.main — orchestration: boot, sim loop, mode switching. Lead-owned. See SPEC.md.
window.TS = window.TS || {};
TS.main = (function () {
  'use strict';

  var PROC_L = 10240;            // procedural domain size, meters
  var L = PROC_L;                // current domain size (real maps set their own)
  var loadedMap = null;          // { name, N, L, data } when a .tsu heightmap is active
  var lastTerrain = null;        // the grid actually handed to the solver

  var settings = {
    seed: 470237, coastComplexity: 0.55, hilliness: 0.5,
    barrierIslands: true, riverValley: true,
    N: 512, waveAmplitude: 8, wavePeriod: 240, waveform: 'pulse', waveTrough: 0.35,
    manning: 0.03, exaggeration: 2, viewMode: '3d', turbo: false, overlayMax: false,
    viewRot: 0, outline: true
  };

  var canvas, gl, cam;
  var mode = 'live';             // 'live' | 'replay'
  var running = false;
  var replayT = 0, replayPlaying = false, replaySpeed = 4;
  var stepsPerFrame = 8;
  var lastCaptureT = -1e9, statusAt = 0, lastFrameAt = 0;
  var stepsAccum = 0, stepsAccumAt = 0, measuredSps = 0;

  // 2D topo view transform. Kept here rather than in camera.js, which owns the
  // 3D orbit only; both are driven from the same canvas.
  var view2d = { zoom: 1, x: 0, y: 0 };

  function resetView2d() { view2d.zoom = 1; view2d.x = 0; view2d.y = 0; }

  function bindView2d() {
    var drag = null;
    var PAN_LIMIT = 0.5;     // the view centre can travel to the domain edge

    function sideCss() { return Math.min(canvas.clientWidth, canvas.clientHeight); }
    function clampPan() {
      view2d.x = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, view2d.x));
      view2d.y = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, view2d.y));
    }
    // Letterbox-normalized cursor position, y up to match gl_FragCoord.
    function cursor(e) {
      var r = canvas.getBoundingClientRect();
      var s = sideCss();
      return {
        x: (e.clientX - r.left - (r.width - s) / 2) / s,
        y: 1 - (e.clientY - r.top - (r.height - s) / 2) / s
      };
    }
    function on2d(e) { return settings.viewMode === '2d' && e.target === canvas; }

    // Capture phase on window fires before camera.js's own canvas listeners, so
    // panning the topo map doesn't secretly spin the 3D orbit at the same time.
    window.addEventListener('pointerdown', function (e) {
      if (!on2d(e)) return;
      drag = { x: e.clientX, y: e.clientY, px: view2d.x, py: view2d.y };
      canvas.style.cursor = 'grabbing';
      e.stopPropagation();
    }, true);

    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (settings.viewMode !== '2d') { drag = null; return; }
      var s = sideCss() * view2d.zoom;
      view2d.x = drag.px - (e.clientX - drag.x) / s;
      view2d.y = drag.py + (e.clientY - drag.y) / s;
      clampPan();
      e.stopPropagation();
    }, true);

    function endDrag(e) {
      if (!drag) return;
      drag = null;
      canvas.style.cursor = '';
      e.stopPropagation();
    }
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);

    window.addEventListener('wheel', function (e) {
      if (!on2d(e)) return;
      e.preventDefault();
      e.stopPropagation();
      var c = cursor(e);
      var z0 = view2d.zoom;
      var z1 = Math.max(1, Math.min(40, z0 * (e.deltaY > 0 ? 1 / 1.12 : 1.12)));
      if (z1 === z0) return;
      // Hold the point under the cursor still while the scale changes.
      view2d.x += (c.x - 0.5) * (1 / z0 - 1 / z1);
      view2d.y += (c.y - 0.5) * (1 / z0 - 1 / z1);
      view2d.zoom = z1;
      if (z1 === 1) { view2d.x = 0; view2d.y = 0; } else clampPan();
    }, { capture: true, passive: false });

    window.addEventListener('dblclick', function (e) {
      if (!on2d(e)) return;
      resetView2d();
      e.stopPropagation();
    }, true);
  }

  function dx() { return L / settings.N; }

  function fatal(msg) {
    if (TS.ui && TS.ui.showError) TS.ui.showError(msg);
    else document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;top:0;left:0;right:0;background:#a22;color:#fff;padding:10px;font:14px system-ui;z-index:99">' + msg + '</div>');
  }

  // Bilinear resample a square row-major grid to a new size (used to fit loaded
  // heightmaps to whatever sim resolution is selected).
  function resample(src, sn, dn) {
    if (sn === dn) return src;
    var out = new Float32Array(dn * dn);
    for (var j = 0; j < dn; j++) {
      var sy = Math.min(Math.max((j + 0.5) / dn * sn - 0.5, 0), sn - 1);
      var y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sn - 1), fy = sy - y0;
      for (var i = 0; i < dn; i++) {
        var sx = Math.min(Math.max((i + 0.5) / dn * sn - 0.5, 0), sn - 1);
        var x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sn - 1), fx = sx - x0;
        var a = src[y0 * sn + x0] * (1 - fx) + src[y0 * sn + x1] * fx;
        var b = src[y1 * sn + x0] * (1 - fx) + src[y1 * sn + x1] * fx;
        out[j * dn + i] = a * (1 - fy) + b * fy;
      }
    }
    return out;
  }

  // Adopt a heightmap — from a .tsu file or straight out of the importer.
  function useMap(map) {
    loadedMap = map;
    resetView2d();
    TS.ui.setLoadedMap(map.name, map.L / 1000);
    rebuildAll();
  }

  function regenTerrain(done) {
    TS.ui.setStatus({
      simTime: 0, dt: 0, stepsPerSec: 0, fps: 0, recordedS: 0, memMB: 0,
      running: false, mode: 'live'
    });
    // let the UI paint before the synchronous generate (seconds at 4096)
    setTimeout(function () {
      var data;
      if (loadedMap) {
        L = loadedMap.L;
        data = resample(loadedMap.data, loadedMap.N, settings.N);
      } else {
        L = PROC_L;
        var t0 = performance.now();
        data = TS.terrain.generate({
          N: settings.N, seed: settings.seed,
          coastComplexity: settings.coastComplexity, hilliness: settings.hilliness,
          barrierIslands: settings.barrierIslands, riverValley: settings.riverValley
        });
        console.log('terrain: ' + settings.N + '^2 in ' + ((performance.now() - t0) | 0) + ' ms');
      }
      lastTerrain = data;
      done(data);
    }, 30);
  }

  var PRESET_KEYS = ['seed', 'coastComplexity', 'hilliness', 'barrierIslands',
    'riverValley', 'N', 'waveAmplitude', 'wavePeriod', 'waveform', 'waveTrough',
    'manning'];

  function userPresets() {
    try { return JSON.parse(localStorage.getItem('tsunamiPresets') || '[]'); }
    catch (e) { return []; }
  }
  function allPresets() {
    var out = [];
    (TS.presets || []).forEach(function (p, i) {
      out.push({ id: 'b' + i, name: p.name, builtin: true, preset: p });
    });
    userPresets().forEach(function (p, i) {
      out.push({ id: 'u' + i, name: p.name, builtin: false, preset: p });
    });
    return out;
  }
  function refreshPresets(sel) { TS.ui.setPresetList(allPresets(), sel); }
  function snapshotPreset(name) {
    var s = {};
    PRESET_KEYS.forEach(function (k) { s[k] = settings[k]; });
    return { name: name, settings: s };
  }

  function rebuildCamera() {
    if (cam && cam.dispose) cam.dispose();
    cam = TS.camera.create(canvas, { L: L });
    cam.resize(canvas.width, canvas.height);
  }

  function rebuildAll() {
    running = false; mode = 'live'; replayPlaying = false;
    var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (settings.N > maxTex) {
      fatal('Your GPU supports textures up to ' + maxTex + ' — ' + settings.N +
        ' is not available on this machine.');
      return;
    }
    regenTerrain(function (data) {
      rebuildCamera();
      TS.solver.init(gl, { N: settings.N, dx: dx(), terrain: data });
      TS.solver.setParams({
        manning: settings.manning, waveAmplitude: settings.waveAmplitude,
        wavePeriod: settings.wavePeriod, waveform: settings.waveform,
        waveTrough: settings.waveTrough
      });
      TS.replay.configure(gl, {
        N: settings.N, recordN: Math.min(settings.N, 512),
        intervalSimSeconds: 2, maxMemMB: 1500
      });
      TS.render3d.init(gl, { N: settings.N, dx: dx() });
      lastCaptureT = -1e9;
      TS.ui.setReplayRange(0);
      pushStatus();
      if (location.hash.indexOf('auto') >= 0) { mode = 'live'; running = true; }
    });
  }

  function resetSim() {
    running = false; mode = 'live'; replayPlaying = false; replayT = 0;
    TS.solver.reset();
    TS.replay.clear();
    lastCaptureT = -1e9;
    TS.ui.setReplayRange(0);
    pushStatus();
  }

  function pushStatus() {
    TS.ui.setStatus({
      simTime: mode === 'replay' ? replayT : TS.solver.simTime,
      dt: TS.solver.simTime > 0 ? currentDt : 0,
      stepsPerSec: measuredSps,
      fps: fpsEstimate,
      recordedS: TS.replay.duration,
      memMB: TS.replay.memoryUsedMB(),
      running: running, mode: mode
    });
  }

  var currentDt = 0, fpsEstimate = 0;

  function resize() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph;
      cam.resize(pw, ph);
      TS.render3d.resize(pw, ph);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var frameDt = Math.min((now - lastFrameAt) / 1000, 0.1);
    lastFrameAt = now;
    fpsEstimate = fpsEstimate * 0.9 + (frameDt > 0 ? 0.1 / frameDt : 0);

    resize();

    if (mode === 'live' && running) {
      var t0 = performance.now();
      var r = TS.solver.stepBatch(Math.round(stepsPerFrame));
      var ms = performance.now() - t0;
      currentDt = r.dt;
      stepsAccum += Math.round(stepsPerFrame);
      if (now - stepsAccumAt > 1000) {
        measuredSps = Math.round(stepsAccum * 1000 / (now - stepsAccumAt));
        stepsAccum = 0; stepsAccumAt = now;
      }
      if (r.unstable) {
        running = false;
        fatal('Simulation went unstable (this can happen with extreme terrain + wave ' +
          'combinations). Hit Reset — or lower the wave amplitude / raise Manning roughness.');
      }
      // adapt batch size toward the frame budget; also cap by sim-seconds per frame
      // so live view stays watchable (and timing pathologies can't spiral the batch)
      var budget = settings.turbo ? 120 : 30;
      if (ms > budget * 1.3) stepsPerFrame = Math.max(2, stepsPerFrame * 0.8);
      else if (ms < budget * 0.6) stepsPerFrame = Math.min(4096, stepsPerFrame * 1.25);
      var simCap = (settings.turbo ? 20 : 2.5) / Math.max(r.dt, 1e-3);
      stepsPerFrame = Math.max(2, Math.min(stepsPerFrame, simCap));
      // record
      if (r.simTime >= lastCaptureT + TS.replay.intervalSimSeconds) {
        TS.replay.capture(gl, TS.solver.stateTexture, r.simTime);
        lastCaptureT = r.simTime;
        TS.ui.setReplayRange(TS.replay.duration);
      }
    }

    if (mode === 'replay' && replayPlaying) {
      replayT += replaySpeed * frameDt;
      if (replayT >= TS.replay.duration) { replayT = TS.replay.duration; replayPlaying = false; }
      TS.ui.setScrubPosition && TS.ui.setScrubPosition(replayT);
    }

    // draw (turbo skips rendering while the sim is running)
    if (!(settings.turbo && running && mode === 'live')) {
      var stateTex = mode === 'replay'
        ? TS.replay.getTextureAt(gl, replayT)
        : TS.solver.stateTexture;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (stateTex) {
        if (settings.viewMode === '2d') {
          TS.render2d.draw(gl, {
            stateTex: stateTex, maxTex: TS.solver.maxTexture,
            showMax: settings.overlayMax, rot: settings.viewRot,
            outline: settings.outline,
            zoom: view2d.zoom, panX: view2d.x, panY: view2d.y,
            width: canvas.width, height: canvas.height, dx: dx(), L: L
          });
        } else {
          cam.update();
          gl.enable(gl.DEPTH_TEST);
          gl.clearColor(0.55, 0.68, 0.8, 1);   // hazy sky
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          TS.render3d.draw(gl, {
            stateTex: stateTex, cam: cam, outline: settings.outline,
            exaggeration: settings.exaggeration, time: now / 1000
          });
        }
      } else {
        gl.clearColor(0.078, 0.09, 0.11, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    if (now - statusAt > 250) { statusAt = now; pushStatus(); }
  }

  function boot() {
    canvas = document.getElementById('view');
    if (location.hash.indexOf('2d') >= 0) settings.viewMode = '2d';
    // dev hooks: #auto,2d,c=1,h=1,seed=42,load=capecod.tsu
    // longest names first: 'trough' must win before the 'h' alternative matches it
    location.hash.replace(/(trough|seed|rot|c|h)=([\d.]+)/g, function (_, k, v) {
      if (k === 'c') settings.coastComplexity = parseFloat(v);
      else if (k === 'h') settings.hilliness = parseFloat(v);
      else if (k === 'rot') settings.viewRot = parseInt(v, 10) % 4;
      else if (k === 'trough') settings.waveTrough = parseFloat(v);
      else settings.seed = parseInt(v, 10);
      return _;
    });
    var mLoad = location.hash.match(/load=([\w.\-]+)/);
    if (mLoad) {
      // headless testing only; from file:// this needs --allow-file-access-from-files
      var xhr = new XMLHttpRequest();
      xhr.open('GET', mLoad[1]);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        TS.tsu.read(xhr.response, mLoad[1]).then(useMap)['catch'](function () {});
      };
      xhr.send();
    }
    window.onerror = function (msg, src, line) {
      fatal('JS error: ' + msg + ' @ ' + (src || '').split('/').pop() + ':' + line);
      return false;
    };
    var missing = ['gl', 'tsu', 'terrain', 'solver', 'render2d', 'camera', 'render3d',
      'replay', 'ui'].filter(function (m) { return !TS[m]; });
    if (missing.length) { fatal('Missing modules: ' + missing.join(', ')); return; }

    gl = TS.gl.getContext(canvas);
    if (!gl) {
      TS.ui.init(makeCallbacks(), settings);
      fatal('WebGL2 with float render targets is required (a modern desktop browser + GPU).');
      return;
    }

    cam = TS.camera.create(canvas, { L: L });
    TS.ui.init(makeCallbacks(), settings);
    bindView2d();
    refreshPresets();
    rebuildAll();
    lastFrameAt = performance.now();
    stepsAccumAt = lastFrameAt;
    requestAnimationFrame(frame);
  }

  function makeCallbacks() {
    return {
      onRegenerate: function (p) {
        settings.seed = p.seed;
        settings.coastComplexity = p.coastComplexity;
        settings.hilliness = p.hilliness;
        settings.barrierIslands = p.barrierIslands;
        settings.riverValley = p.riverValley;
        loadedMap = null;
        TS.ui.setLoadedMap(null);
        rebuildAll();
      },
      onLoadTerrain: function (file) {
        var rd = new FileReader();
        rd.onload = function () {
          TS.tsu.read(rd.result, file.name).then(useMap)['catch'](function (e) {
            TS.ui.showError('Could not load heightmap: ' + e.message);
          });
        };
        rd.onerror = function () { TS.ui.showError('Could not read file.'); };
        rd.readAsArrayBuffer(file);
      },
      // Export whatever terrain is loaded right now — including a map that came
      // from the importer and was never saved, and procedural terrain, so a run
      // you like can always be handed to someone else.
      onSaveMap: function () {
        if (!lastTerrain) { TS.ui.showError('No terrain to save yet.'); return; }
        var name = loadedMap ? loadedMap.name.replace(/\.tsu2?$/i, '') :
          'procedural-' + settings.seed + '-c' + settings.coastComplexity +
          '-h' + settings.hilliness;
        // Prefer the map as it was imported: running at 512 must not save a
        // downsampled copy of a 1024 map.
        var src = loadedMap || { N: settings.N, L: L, data: lastTerrain };
        var map = {
          N: src.N, L: src.L, data: src.data, name: name,
          source: loadedMap ? (loadedMap.meta && loadedMap.meta.source) || 'imported'
                            : 'Tsunami Lab procedural terrain',
          widthKm: +(src.L / 1000).toFixed(3), cellSizeM: +(src.L / src.N).toFixed(2)
        };
        if (loadedMap && loadedMap.meta) {
          if (loadedMap.meta.lat != null) map.lat = loadedMap.meta.lat;
          if (loadedMap.meta.lon != null) map.lon = loadedMap.meta.lon;
        } else if (loadedMap) {
          if (loadedMap.lat != null) map.lat = loadedMap.lat;
          if (loadedMap.lon != null) map.lon = loadedMap.lon;
        }
        TS.tsu.write(map, {}).then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name.replace(/[^\w.\- ]+/g, '_') + '.tsu';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 20000);
        })['catch'](function (e) {
          TS.ui.showError('Could not save the map: ' + e.message);
        });
      },
      onOpenImporter: function () {
        if (!TS.importer) { TS.ui.showError('The heightmap importer failed to load.'); return; }
        running = false;
        pushStatus();          // otherwise the sidebar still claims "Running"
        TS.importer.open({ onUse: useMap });
      },
      onResolutionChange: function (n) { settings.N = n; rebuildAll(); },
      onWaveChange: function (w) {
        settings.waveAmplitude = w.amplitude; settings.wavePeriod = w.period;
        settings.waveform = w.waveform;
        if (w.trough != null) settings.waveTrough = w.trough;
        TS.solver.setParams({
          waveAmplitude: w.amplitude, wavePeriod: w.period, waveform: w.waveform,
          waveTrough: settings.waveTrough
        });
      },
      onManningChange: function (n) { settings.manning = n; TS.solver.setParams({ manning: n }); },
      onStart: function () { mode = 'live'; running = true; replayPlaying = false; pushStatus(); },
      onPause: function () { running = false; pushStatus(); },
      onReset: function () { resetSim(); },
      onViewMode: function (m) { settings.viewMode = m; },
      onRotateView: function () {
        settings.viewRot = (settings.viewRot + 1) % 4;
        if (settings.viewMode !== '2d') { settings.viewMode = '2d'; }
      },
      onResetView: function () {
        resetView2d();
        if (settings.viewMode !== '2d') { settings.viewMode = '2d'; }
      },
      onOutlineChange: function (b) { settings.outline = b; },
      onPresetSelect: function (id) {
        var hit = null;
        allPresets().forEach(function (p) { if (p.id === id) hit = p; });
        if (!hit || !hit.preset.settings) return;
        PRESET_KEYS.forEach(function (k) {
          if (hit.preset.settings[k] !== undefined) settings[k] = hit.preset.settings[k];
        });
        // rebuild the sidebar so every control shows the preset's values
        TS.ui.init(makeCallbacks(), settings);
        refreshPresets(id);
        if (loadedMap) TS.ui.setLoadedMap(loadedMap.name, loadedMap.L / 1000);
        rebuildAll();
      },
      onPresetSave: function (name) {
        var l = userPresets();
        l.push(snapshotPreset(name));
        try { localStorage.setItem('tsunamiPresets', JSON.stringify(l)); } catch (e) {}
        refreshPresets('u' + (l.length - 1));
      },
      onPresetDelete: function (id) {
        if (id.charAt(0) !== 'u') {
          TS.ui.showError('Built-in presets (★) can only be removed by editing js/presets.js.');
          return;
        }
        var l = userPresets();
        l.splice(parseInt(id.slice(1), 10), 1);
        try { localStorage.setItem('tsunamiPresets', JSON.stringify(l)); } catch (e) {}
        refreshPresets();
      },
      onPresetExport: function (id) {
        var hit = null;
        allPresets().forEach(function (p) { if (p.id === id) hit = p; });
        var txt = JSON.stringify(hit ? hit.preset : snapshotPreset('My preset'), null, 2);
        var manual = function () { window.prompt('Copy this preset JSON (paste into js/presets.js to share):', txt); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () {
            TS.ui.showError('Preset JSON copied — paste it into js/presets.js to share it. (Not an error, just borrowing the banner.)');
          }, manual);
        } else manual();
      },
      onExaggeration: function (x) { settings.exaggeration = x; },
      onOverlayMaxExtent: function (b) { settings.overlayMax = b; },
      onTurbo: function (b) { settings.turbo = b; },
      onScrub: function (t) {
        if (TS.replay.duration <= 0) return;
        mode = 'replay'; running = false; replayPlaying = false;
        replayT = Math.max(0, Math.min(t, TS.replay.duration));
        pushStatus();
      },
      onLive: function () { mode = 'live'; replayPlaying = false; pushStatus(); },
      onReplayPlay: function (speed) {
        if (TS.replay.duration <= 0) return;
        replaySpeed = speed || 4;
        if (mode !== 'replay') { mode = 'replay'; running = false; replayT = 0; }
        if (replayT >= TS.replay.duration) replayT = 0;
        replayPlaying = true; pushStatus();
      },
      onReplayPause: function () { replayPlaying = false; pushStatus(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  return { settings: settings };
})();
