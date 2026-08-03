// TS.replay — snapshot recording (GPU downsample + Uint16 quantization) and
// interpolated playback. See SPEC.md "TS.replay (agent C)".
//
// Frames store the full RGBA state layout (h, hu, hv, B) at recordN x recordN so a
// replay texture is interchangeable with the live state texture for every renderer.
window.TS = window.TS || {};
TS.replay = (function () {
  'use strict';

  // --- downsample pass -------------------------------------------------------
  // Box-averages a taps x taps neighbourhood of the source state texture into one
  // destination texel. Averaging h and B independently is fine for a coarse view.
  var DOWNSAMPLE_FS = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'uniform sampler2D u_state;',
    'uniform float u_scale;',   // srcN / dstN
    'uniform int u_srcN;',
    'uniform int u_taps;',      // 1, 2 or 4
    'out vec4 o_color;',
    'void main() {',
    '  vec2 dst = gl_FragCoord.xy - 0.5;',              // integer destination cell
    '  ivec2 base = ivec2(floor(dst * u_scale));',      // top-left source cell of footprint
    '  int stride = max(int(u_scale) / u_taps, 1);',
    '  vec4 sum = vec4(0.0);',
    '  float n = 0.0;',
    '  for (int b = 0; b < 4; b++) {',
    '    if (b >= u_taps) break;',
    '    for (int a = 0; a < 4; a++) {',
    '      if (a >= u_taps) break;',
    '      ivec2 p = clamp(base + ivec2(a, b) * stride, ivec2(0), ivec2(u_srcN - 1));',
    '      sum += texelFetch(u_state, p, 0);',
    '      n += 1.0;',
    '    }',
    '  }',
    '  o_color = sum / n;',
    '}'
  ].join('\n');

  var CH = 4;
  var Q_MAX = 65535;

  var cfg = null;          // { N, recordN, maxMemMB, taps }
  var down = null;         // { prog, tex, fbo }
  var readScratch = null;  // Float32Array(recordN*recordN*4), reused by capture
  var lerpScratch = null;  // Float32Array(recordN*recordN*4), reused by getTextureAt
  var playbackTex = null;
  var frames = [];         // { simTime, mins:Float32Array(4), scales:Float32Array(4), data:Uint16Array }
  var bytesPerFrame = 0;
  var totalBytes = 0;
  var interval = 1;        // current capture interval in sim seconds (main consults this)

  // playback cache
  var cacheI = -1, cacheJ = -1, cacheT = NaN;

  function releaseGL(gl) {
    if (down) {
      gl.deleteFramebuffer(down.fbo);
      gl.deleteTexture(down.tex);
      gl.deleteProgram(down.prog.prog);
      down = null;
    }
    if (playbackTex) { gl.deleteTexture(playbackTex); playbackTex = null; }
  }

  function configure(gl, opts) {
    opts = opts || {};
    var N = opts.N | 0;
    var recordN = Math.min(opts.recordN | 0 || Math.min(N, 512), N);
    if (!(N > 0) || !(recordN > 0)) throw new Error('TS.replay.configure: bad N/recordN');

    releaseGL(gl);
    clear();

    var ratio = N / recordN;
    cfg = {
      N: N,
      recordN: recordN,
      maxMemMB: opts.maxMemMB > 0 ? opts.maxMemMB : 256,
      taps: ratio >= 4 ? 4 : (ratio >= 2 ? 2 : 1),
      scale: ratio
    };
    interval = opts.intervalSimSeconds > 0 ? opts.intervalSimSeconds : 1;

    var tex = TS.gl.createTexture(gl, recordN, recordN, gl.RGBA32F, null, gl.NEAREST);
    down = {
      prog: TS.gl.program(gl, TS.gl.QUAD_VS, DOWNSAMPLE_FS),
      tex: tex,
      fbo: TS.gl.createFBO(gl, tex)
    };
    // Requesting LINEAR: TS.gl.createTexture downgrades to NEAREST when
    // OES_texture_float_linear is missing, so this is always safe.
    playbackTex = TS.gl.createTexture(gl, recordN, recordN, gl.RGBA32F, null, gl.LINEAR);

    var px = recordN * recordN * CH;
    readScratch = new Float32Array(px);
    lerpScratch = new Float32Array(px);
    bytesPerFrame = px * 2 + 64; // Uint16 payload + per-frame bookkeeping
  }

  // --- capture ---------------------------------------------------------------

  // Quantize one readback into a frame record. Constant channels get scale 0 so
  // decoding yields exactly the min.
  function quantize(src, simTime) {
    var n = cfg.recordN * cfg.recordN;
    var mins = new Float32Array(CH);
    var scales = new Float32Array(CH);
    var data = new Uint16Array(n * CH);
    for (var c = 0; c < CH; c++) {
      var lo = Infinity, hi = -Infinity, i, v;
      for (i = 0; i < n; i++) {
        v = src[i * CH + c];
        if (!isFinite(v)) v = 0; // never let a NaN poison the whole channel range
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = 0; hi = 0; }
      var span = hi - lo;
      var scale = span > 0 ? span / Q_MAX : 0;
      var inv = scale > 0 ? 1 / scale : 0;
      mins[c] = lo;
      scales[c] = scale;
      for (i = 0; i < n; i++) {
        v = src[i * CH + c];
        if (!isFinite(v)) v = lo;
        var q = (v - lo) * inv + 0.5; // +0.5 => round
        data[i * CH + c] = q <= 0 ? 0 : (q >= Q_MAX ? Q_MAX : q | 0);
      }
    }
    return { simTime: simTime, mins: mins, scales: scales, data: data };
  }

  // Render stateTex into the recordN FBO, read it back, store it quantized.
  // NOTE: this leaves gl.viewport() set to recordN x recordN — main sets the
  // viewport before every draw, so nothing is restored here. The FBO and the
  // texture unit are unbound before returning.
  function capture(gl, stateTex, simTime) {
    if (!cfg) return false;
    // Sim was reset (time ran backwards): start a fresh recording rather than
    // storing an out-of-order frame that would break the binary search.
    if (frames.length && simTime <= frames[frames.length - 1].simTime) {
      if (simTime < frames[frames.length - 1].simTime) clear();
      else return false; // duplicate timestamp
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, down.fbo);
    gl.viewport(0, 0, cfg.recordN, cfg.recordN);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    TS.gl.drawQuad(gl, down.prog, function (g, u) {
      TS.gl.bindTex(g, 0, stateTex, u.u_state);
      g.uniform1f(u.u_scale, cfg.scale);
      g.uniform1i(u.u_srcN, cfg.N);
      g.uniform1i(u.u_taps, cfg.taps);
    });
    // RGBA/FLOAT readback of an RGBA32F color attachment: valid in WebGL2 with
    // EXT_color_buffer_float (which TS.gl.getContext requires).
    gl.readPixels(0, 0, cfg.recordN, cfg.recordN, gl.RGBA, gl.FLOAT, readScratch);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    frames.push(quantize(readScratch, simTime));
    totalBytes += bytesPerFrame;
    cacheI = cacheJ = -1; cacheT = NaN;

    // Budget guard: when the next frame would not fit, halve the capture rate and
    // thin the existing frames to match, so a long unattended run keeps recording
    // all the way to the end at a coarser but *uniform* interval — instead of
    // filling the budget early and having the tail of the event go unrecorded.
    var budget = cfg.maxMemMB * 1024 * 1024;
    if (totalBytes + bytesPerFrame > budget) {
      interval *= 2;
      thinFrames();
      console.warn('TS.replay: memory budget ' + cfg.maxMemMB + ' MB reached — ' +
        'capture interval now ' + interval + ' s, kept ' + frames.length + ' frames');
    }
    return true;
  }

  // Drop every other frame (keeping the first and, where possible, the last) so the
  // remaining spacing matches the doubled interval. Halves memory in place.
  function thinFrames() {
    if (frames.length < 3) return;
    var kept = [];
    for (var i = 0; i < frames.length; i += 2) kept.push(frames[i]);
    var lastOrig = frames[frames.length - 1];
    if (kept[kept.length - 1] !== lastOrig) kept.push(lastOrig);
    frames = kept;
    totalBytes = frames.length * bytesPerFrame;
    cacheI = cacheJ = -1; cacheT = NaN;
  }

  // --- playback --------------------------------------------------------------

  // Index of the last frame with simTime <= t (assumes frames sorted ascending).
  function findBracket(t) {
    var lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (frames[mid].simTime <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function decodeInto(f, out) {
    var n = out.length;
    var m0 = f.mins[0], m1 = f.mins[1], m2 = f.mins[2], m3 = f.mins[3];
    var s0 = f.scales[0], s1 = f.scales[1], s2 = f.scales[2], s3 = f.scales[3];
    var d = f.data;
    for (var i = 0; i < n; i += 4) {
      out[i] = m0 + d[i] * s0;
      out[i + 1] = m1 + d[i + 1] * s1;
      out[i + 2] = m2 + d[i + 2] * s2;
      out[i + 3] = m3 + d[i + 3] * s3;
    }
  }

  function lerpInto(fa, fb, u, out) {
    var n = out.length;
    var a = fa.data, b = fb.data;
    var am0 = fa.mins[0], am1 = fa.mins[1], am2 = fa.mins[2], am3 = fa.mins[3];
    var as0 = fa.scales[0], as1 = fa.scales[1], as2 = fa.scales[2], as3 = fa.scales[3];
    var bm0 = fb.mins[0], bm1 = fb.mins[1], bm2 = fb.mins[2], bm3 = fb.mins[3];
    var bs0 = fb.scales[0], bs1 = fb.scales[1], bs2 = fb.scales[2], bs3 = fb.scales[3];
    for (var i = 0; i < n; i += 4) {
      var v0 = am0 + a[i] * as0;
      var v1 = am1 + a[i + 1] * as1;
      var v2 = am2 + a[i + 2] * as2;
      var v3 = am3 + a[i + 3] * as3;
      out[i] = v0 + (bm0 + b[i] * bs0 - v0) * u;
      out[i + 1] = v1 + (bm1 + b[i + 1] * bs1 - v1) * u;
      out[i + 2] = v2 + (bm2 + b[i + 2] * bs2 - v2) * u;
      out[i + 3] = v3 + (bm3 + b[i + 3] * bs3 - v3) * u;
    }
  }

  function upload(gl) {
    gl.bindTexture(gl.TEXTURE_2D, playbackTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cfg.recordN, cfg.recordN,
      gl.RGBA, gl.FLOAT, lerpScratch);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function getTextureAt(gl, simT) {
    if (!cfg || frames.length === 0) return null;
    var first = frames[0].simTime;
    var last = frames[frames.length - 1].simTime;
    var t = simT < first ? first : (simT > last ? last : simT);

    if (frames.length === 1) {
      if (cacheI === 0 && cacheJ === 0) return playbackTex;
      decodeInto(frames[0], lerpScratch);
      upload(gl);
      cacheI = cacheJ = 0; cacheT = t;
      return playbackTex;
    }

    var i = findBracket(t);
    var j = Math.min(i + 1, frames.length - 1);
    if (i === cacheI && j === cacheJ && Math.abs(t - cacheT) < 1e-4) return playbackTex;

    var fa = frames[i], fb = frames[j];
    var span = fb.simTime - fa.simTime;
    if (j === i || span <= 0) {
      decodeInto(fa, lerpScratch);
    } else {
      lerpInto(fa, fb, (t - fa.simTime) / span, lerpScratch);
    }
    upload(gl);
    cacheI = i; cacheJ = j; cacheT = t;
    return playbackTex;
  }

  // --- misc ------------------------------------------------------------------

  function memoryUsedMB() {
    return totalBytes / (1024 * 1024);
  }

  function clear() {
    frames.length = 0;
    totalBytes = 0;
    cacheI = cacheJ = -1;
    cacheT = NaN;
  }

  var api = {
    configure: configure,
    capture: capture,
    getTextureAt: getTextureAt,
    memoryUsedMB: memoryUsedMB,
    clear: clear
  };

  Object.defineProperty(api, 'frameCount', {
    get: function () { return frames.length; }
  });
  Object.defineProperty(api, 'duration', {
    // Recorded sim seconds; 0 until there are two frames to span.
    get: function () {
      return frames.length < 2 ? 0 : frames[frames.length - 1].simTime - frames[0].simTime;
    }
  });
  Object.defineProperty(api, 'startTime', {
    get: function () { return frames.length ? frames[0].simTime : 0; }
  });
  Object.defineProperty(api, 'intervalSimSeconds', {
    // Grows (doubles) when the memory budget is reached; main should re-read it
    // rather than caching the configured value.
    get: function () { return interval; },
    set: function (v) { if (v > 0) interval = v; }
  });
  Object.defineProperty(api, 'recordN', {
    get: function () { return cfg ? cfg.recordN : 0; }
  });

  return api;
})();
