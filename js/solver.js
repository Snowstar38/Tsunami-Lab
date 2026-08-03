// TS.solver — 2D shallow-water solver (Kurganov-Petrova central-upwind, well-balanced,
// wet/dry, SSP-RK2, semi-implicit Manning friction). Lead-owned. See SPEC.md.
//
// State texture RGBA32F: r=h (depth, m), g=hu, b=hv (m^2/s), a=B (terrain elev, m).
// The wave enters through a forcing/sponge strip along the south edge (row j=0).
window.TS = window.TS || {};
TS.solver = (function () {
  'use strict';

  var CFL = 0.22;            // conservative for 2D central-upwind + RK2
  var H_DRY = 1e-3;          // below this depth (m), momentum is zeroed
  var MAX_SPEED = 500.0;     // readback above this => declared unstable
  var DT_EVERY = 16;         // recompute dt (with GPU->CPU readback) every N steps
  var MAX_EVERY = 10;        // accumulate max-inundation every N steps

  var COMMON = [
    'precision highp float;',
    'precision highp int;',
    'const float G = 9.81;',
    'const float H_DRY = ' + H_DRY.toExponential() + ';',
    // Desingularized velocity: smooth u = hu/h that -> 0 as h -> 0 (KP07 style).
    // VEPS^0.25 ~ 0.03 m is the depth below which velocities are damped.
    'const float VEPS = 1e-6;',
    'float dvel(float h, float q) {',
    '  float h4 = h*h*h*h;',
    '  return 1.41421356 * h * q / sqrt(h4 + max(h4, VEPS));',
    '}'
  ].join('\n');

  // ---- step shader: one SSP-RK2 stage over the whole grid ----
  var STEP_FS = [
    '#version 300 es',
    COMMON,
    'uniform sampler2D u_state;   // stage input U',
    'uniform sampler2D u_prev;    // U^n (used when u_blend=0.5)',
    'uniform float u_blend;       // 0.0: out=U+dt*L(U); 0.5: out=0.5*prev+0.5*(U+dt*L(U))',
    'uniform float u_dt, u_dx, u_manning, u_time;',
    'uniform int u_N, u_spongeW, u_sideW;',
    'uniform float u_waveAmp, u_wavePeriod;',
    'uniform float u_trough;     // leading-trough depth as a fraction of amplitude',
    'uniform int u_waveform;     // 0 pulse, 1 nwave, 2 sustained, 3 train',
    'out vec4 o;',

    'vec4 S(ivec2 p) { return texelFetch(u_state, clamp(p, ivec2(0), ivec2(u_N - 1)), 0); }',

    'float mm(float a, float b, float c) {',
    '  return (a > 0.0 && b > 0.0 && c > 0.0) ? min(a, min(b, c))',
    '       : (a < 0.0 && b < 0.0 && c < 0.0) ? max(a, max(b, c)) : 0.0;',
    '}',
    // Limited slope of q=(w,hu,hv) in one cell given its neighbors along an axis.
    'vec3 slope3(vec3 l, vec3 c, vec3 r) {',
    '  const float TH = 1.3;',
    '  return vec3(',
    '    mm(TH * (c.x - l.x), 0.5 * (r.x - l.x), TH * (r.x - c.x)),',
    '    mm(TH * (c.y - l.y), 0.5 * (r.y - l.y), TH * (r.y - c.y)),',
    '    mm(TH * (c.z - l.z), 0.5 * (r.z - l.z), TH * (r.z - c.z)));',
    '}',

    // Central-upwind flux through one face. q = (w, qn, qt, h) where w = B+h, qn is the
    // face-normal discharge, qt transverse, h the cell depth. Returns flux for (h, qn, qt).
    // Dry cells (h < RECON_DRY) skip the w-reconstruction: a limited w-slope on dry
    // terrain otherwise fabricates phantom face depths (w - Bf > 0) and leaks mass.
    'const float RECON_DRY = 0.01;',
    'vec3 cuFlux(vec4 qLL, vec4 qL, vec4 qR, vec4 qRR, float Bf) {',
    '  vec3 Um = qL.xyz + 0.5 * slope3(qLL.xyz, qL.xyz, qR.xyz);',
    '  vec3 Up = qR.xyz - 0.5 * slope3(qL.xyz, qR.xyz, qRR.xyz);',
    '  float hm = (qL.w < RECON_DRY) ? max(qL.w, 0.0) : max(Um.x - Bf, 0.0);',
    '  float hp = (qR.w < RECON_DRY) ? max(qR.w, 0.0) : max(Up.x - Bf, 0.0);',
    // Floor the reconstruction with the plain (first-order) face depth. On land
    // beside dry cells the limited w-slope follows the TERRAIN downhill, so the
    // reconstructed surface at the lower face can fall below the face bed and
    // the cell reports zero depth there — it stops draining and holds its water
    // forever. Falling back to "how much water actually stands above this face,
    // capped by what the cell holds" restores drainage. At rest both expressions
    // are identical, so the well-balanced lake property is untouched.
    '  hm = max(hm, min(qL.w, qL.x - Bf));',
    '  hp = max(hp, min(qR.w, qR.x - Bf));',
    '  if (hm < H_DRY && hp < H_DRY) return vec3(0.0);',   // no flux between dry faces
    '  float um = dvel(hm, Um.y), tm = dvel(hm, Um.z);',
    '  float up = dvel(hp, Up.y), tp = dvel(hp, Up.z);',
    '  float qnm = hm * um, qtm = hm * tm;',
    '  float qnp = hp * up, qtp = hp * tp;',
    '  float cm = sqrt(G * hm), cp = sqrt(G * hp);',
    '  float ap = max(max(um + cm, up + cp), 0.0);',
    '  float am = min(min(um - cm, up - cp), 0.0);',
    '  float ad = ap - am;',
    '  if (ad < 1e-8) return vec3(0.0);',
    '  vec3 Fm = vec3(qnm, qnm * um + 0.5 * G * hm * hm, qtm * um);',
    '  vec3 Fp = vec3(qnp, qnp * up + 0.5 * G * hp * hp, qtp * up);',
    '  return (ap * Fm - am * Fp) / ad + (ap * am / ad) * (vec3(hp, qnp, qtp) - vec3(hm, qnm, qtm));',
    '}',

    // Incoming wave: target surface elevation (m) at the south boundary vs time.
    'float rcos(float t, float t0, float dur) {',
    '  float x = (t - t0) / dur;',
    '  return (x > 0.0 && x < 1.0) ? 0.5 * (1.0 - cos(6.28318530718 * x)) : 0.0;',
    '}',
    'float waveEta(float t) {',
    '  float A = u_waveAmp, P = u_wavePeriod;',
    '  if (u_waveform == 0) return A * rcos(t, 0.0, P);',
    '  if (u_waveform == 1) return -u_trough * A * rcos(t, 0.0, 0.6 * P) + A * rcos(t, 0.45 * P, P);',
    '  if (u_waveform == 3) {',
    // Wave train: ~3.5 oscillations under a sin^2 envelope, so the biggest crest
    // is in the middle (real tsunami trains often peak on the 2nd/3rd wave).
    // Troughs are scaled by u_trough: at 1.0 the sea empties fully between waves.
    '    float T = 3.5 * P;',
    '    if (t >= T) return 0.0;',
    '    float env = sin(3.14159265 * t / T);',
    '    float s = sin(6.28318530718 * t / P);',
    '    if (s < 0.0) s *= u_trough;',
    '    return A * env * env * s;',
    '  }',
    '  float up = smoothstep(0.0, 0.3 * P, t);',
    '  float dn = 1.0 - smoothstep(2.0 * P, 2.5 * P, t);',
    '  return A * up * dn;',
    '}',

    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy);',
    '  vec4 C  = S(p);',
    '  vec4 W  = S(p + ivec2(-1, 0)), WW = S(p + ivec2(-2, 0));',
    '  vec4 E  = S(p + ivec2( 1, 0)), EE = S(p + ivec2( 2, 0));',
    '  vec4 Sc = S(p + ivec2(0, -1)), SS = S(p + ivec2(0, -2));',
    '  vec4 Nc = S(p + ivec2(0,  1)), NN = S(p + ivec2(0,  2));',
    '  float B = C.a;',

    // q = (w, normal discharge, transverse discharge, h) per axis
    '  vec4 qC_x  = vec4(C.r  + C.a,  C.g,  C.b,  C.r);',
    '  vec4 qW_x  = vec4(W.r  + W.a,  W.g,  W.b,  W.r);',
    '  vec4 qWW_x = vec4(WW.r + WW.a, WW.g, WW.b, WW.r);',
    '  vec4 qE_x  = vec4(E.r  + E.a,  E.g,  E.b,  E.r);',
    '  vec4 qEE_x = vec4(EE.r + EE.a, EE.g, EE.b, EE.r);',
    '  vec4 qC_y  = vec4(C.r  + C.a,  C.b,  C.g,  C.r);',
    '  vec4 qS_y  = vec4(Sc.r + Sc.a, Sc.b, Sc.g, Sc.r);',
    '  vec4 qSS_y = vec4(SS.r + SS.a, SS.b, SS.g, SS.r);',
    '  vec4 qN_y  = vec4(Nc.r + Nc.a, Nc.b, Nc.g, Nc.r);',
    '  vec4 qNN_y = vec4(NN.r + NN.a, NN.b, NN.g, NN.r);',

    // Face bed = the HIGHER of the two cells (Audusse hydrostatic reconstruction),
    // not their average. With an average, a face between a 0 m valley and a 10 m
    // ridge sits at 5 m, so 6 m of water in the valley pours straight THROUGH the
    // ridge and onto its crest — then runs down the far side forever, because the
    // sea keeps refilling the valley. Harmless where neighbours differ by
    // centimetres (procedural terrain, Cape Cod); catastrophic on real mountains
    // where they differ by tens of metres.
    //
    // Well-balancedness is preserved: at rest w = const, both sides reconstruct to
    // max(-Bf, 0) whatever Bf is, and the source term below uses these SAME face
    // values, so the flux and source still cancel exactly. See test-solver.html.
    '  float BfE = max(C.a, E.a),  BfW = max(W.a, C.a);',
    '  float BfN = max(C.a, Nc.a), BfS = max(Sc.a, C.a);',

    '  vec3 FE = cuFlux(qW_x,  qC_x, qE_x,  qEE_x, BfE);',
    '  vec3 FW = cuFlux(qWW_x, qW_x, qC_x,  qE_x,  BfW);',
    '  vec3 GN = cuFlux(qS_y,  qC_y, qN_y,  qNN_y, BfN);',
    '  vec3 GS = cuFlux(qSS_y, qS_y, qC_y,  qN_y,  BfS);',

    // Open-boundary guard: the zero-gradient edges must never IMPORT mass. The
    // mirrored ghost cell is an infinite reservoir — a wave that overtops the rim
    // and slopes back inward otherwise becomes a perpetual river.
    '  if (p.y == u_N - 1) GN.x = max(GN.x, 0.0);',
    '  if (p.x == u_N - 1) FE.x = max(FE.x, 0.0);',
    '  if (p.x == 0)       FW.x = min(FW.x, 0.0);',

    // Well-balanced bed-slope source using this cell\'s own reconstructions
    // (same dry-cell guard as cuFlux so source and fluxes stay in balance).
    '  float hEx, hWx, hNy, hSy;',
    '  if (C.r < RECON_DRY) {',
    '    hEx = hWx = hNy = hSy = max(C.r, 0.0);',
    '  } else {',
    '    vec3 sx = slope3(qW_x.xyz, qC_x.xyz, qE_x.xyz);',
    '    vec3 sy = slope3(qS_y.xyz, qC_y.xyz, qN_y.xyz);',
    '    hEx = max(qC_x.x + 0.5 * sx.x - BfE, 0.0);',
    '    hWx = max(qC_x.x - 0.5 * sx.x - BfW, 0.0);',
    '    hNy = max(qC_y.x + 0.5 * sy.x - BfN, 0.0);',
    '    hSy = max(qC_y.x - 0.5 * sy.x - BfS, 0.0);',
    // Same floor as cuFlux, so the bed-slope source keeps using the identical
    // face depths the fluxes did.
    '    hEx = max(hEx, min(C.r, qC_x.x - BfE));',
    '    hWx = max(hWx, min(C.r, qC_x.x - BfW));',
    '    hNy = max(hNy, min(C.r, qC_y.x - BfN));',
    '    hSy = max(hSy, min(C.r, qC_y.x - BfS));',
    '  }',
    '  float Sx = -G * 0.5 * (hEx + hWx) * (BfE - BfW) / u_dx;',
    '  float Sy = -G * 0.5 * (hNy + hSy) * (BfN - BfS) / u_dx;',

    '  vec3 U = vec3(C.r, C.g, C.b);',
    '  vec3 rhs = vec3(',
    '    -(FE.x - FW.x) / u_dx - (GN.x - GS.x) / u_dx,',
    '    -(FE.y - FW.y) / u_dx - (GN.z - GS.z) / u_dx + Sx,',   // hu: transverse comp of G
    '    -(FE.z - FW.z) / u_dx - (GN.y - GS.y) / u_dx + Sy);',  // hv: normal comp of G
    '  vec3 U1 = U + u_dt * rhs;',

    // Friction (semi-implicit Manning) + dry handling + sanity clamp.
    '  U1.x = max(U1.x, 0.0);',
    '  if (U1.x < H_DRY) {',
    '    U1.yz = vec2(0.0);',
    '  } else {',
    '    float sp = length(vec2(dvel(U1.x, U1.y), dvel(U1.x, U1.z)));',
    '    float fac = 1.0 + u_dt * G * u_manning * u_manning * sp / pow(U1.x, 1.33333);',
    '    U1.yz /= fac;',
    '    float sp2 = length(U1.yz) / U1.x;',
    '    if (sp2 > 60.0) U1.yz *= 60.0 / sp2;',   // physical bores stay well under this
    '  }',

    '  vec3 Uo = (u_blend > 0.0) ? mix(U1, texelFetch(u_prev, p, 0).rgb, u_blend) : U1;',

    // South forcing/sponge strip: relax toward the incoming-wave state; also absorbs
    // outgoing reflections so the wave doesn\'t bounce back into the domain.
    '  if (p.y < u_spongeW && B < -0.5) {',
    '    float fr = 1.0 - float(p.y) / float(u_spongeW);',
    '    float eta = waveEta(u_time);',
    '    float hT = max(eta - B, 0.0);',
    '    float vT = eta * sqrt(G / max(-B, 1.0));',   // linear long-wave particle velocity
    '    float r = clamp(u_dt / 2.0, 0.0, 1.0) * fr * fr;',
    '    Uo.x = mix(Uo.x, hT, r);',
    '    Uo.z = mix(Uo.z, hT * vT, r);',
    '    Uo.y = mix(Uo.y, 0.0, r);',
    '  }',

    // East/west edges: weak absorbing sponge over ocean cells. Without it the side
    // boundaries act as mirror-walls for oblique wave energy, which piles up and
    // shoots anomalously high run-up along the edge columns.
    '  float de = min(float(p.x), float(u_N - 1 - p.x));',
    '  if (de < float(u_sideW)) {',
    '    float fr2 = 1.0 - de / float(u_sideW);',
    '    if (B < -0.5) {',
    // Depth-aware: full strength in the nearshore (where reflected run-up is the
    // artifact), fading to ~30% in deep open water so the sponge stops visibly
    // eating the wave crest far from land.
    '      float fac = mix(1.0, 0.3, smoothstep(15.0, 50.0, -B));',
    '      float r2 = clamp(u_dt / 6.0, 0.0, 1.0) * fr2 * fr2 * fac;',
    '      Uo.x = mix(Uo.x, max(-B, 0.0), r2);',
    '      Uo.yz = mix(Uo.yz, vec2(0.0), r2);',
    '    } else {',
    // On land the taper is steeper (cubic), just enough to stop the mirror-wall
    // from flinging run-up along the edge without eating legitimate flooding.
    '      float r3 = clamp(u_dt / 6.0, 0.0, 1.0) * fr2 * fr2 * fr2;',
    '      Uo.x = mix(Uo.x, 0.0, r3);',
    '      Uo.yz = mix(Uo.yz, vec2(0.0), r3);',
    '    }',
    '  }',

    '  Uo.x = max(Uo.x, 0.0);',
    '  if (any(isnan(Uo)) || any(isinf(Uo))) Uo = vec3(max(C.r, 0.0), 0.0, 0.0);',
    '  o = vec4(Uo, B);',
    '}'
  ].join('\n');

  // ---- init shader: still water at sea level over terrain ----
  var INIT_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_terrain;',
    'out vec4 o;',
    'void main() {',
    '  float B = texelFetch(u_terrain, ivec2(gl_FragCoord.xy), 0).r;',
    '  o = vec4(max(-B, 0.0), 0.0, 0.0, B);',
    '}'
  ].join('\n');

  // ---- local wave speed (for CFL) ----
  var SPEED_FS = [
    '#version 300 es',
    COMMON,
    'uniform sampler2D u_state;',
    'out vec4 o;',
    'void main() {',
    '  vec4 s = texelFetch(u_state, ivec2(gl_FragCoord.xy), 0);',
    '  float v = 0.0;',
    '  if (s.r > H_DRY) v = length(vec2(dvel(s.r, s.g), dvel(s.r, s.b))) + sqrt(G * s.r);',
    '  o = vec4(v, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // ---- 4x4 max reduction ----
  var REDUCE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_src;',
    'uniform int u_srcSize;',
    'out vec4 o;',
    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy) * 4;',
    '  float m = 0.0;',
    '  for (int y = 0; y < 4; y++)',
    '    for (int x = 0; x < 4; x++)',
    '      m = max(m, texelFetch(u_src, min(p + ivec2(x, y), ivec2(u_srcSize - 1)), 0).r);',
    '  o = vec4(m, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // ---- max-inundation accumulation: r = max depth, g = max h*(u^2+v^2) ----
  var MAXACC_FS = [
    '#version 300 es',
    COMMON,
    'uniform sampler2D u_state;',
    'uniform sampler2D u_maxPrev;',
    'out vec4 o;',
    'void main() {',
    '  ivec2 p = ivec2(gl_FragCoord.xy);',
    '  vec4 s = texelFetch(u_state, p, 0);',
    '  vec2 prev = texelFetch(u_maxPrev, p, 0).rg;',
    '  float u = dvel(s.r, s.g), v = dvel(s.r, s.b);',
    '  o = vec4(max(prev.x, s.r), max(prev.y, s.r * (u * u + v * v)), 0.0, 1.0);',
    '}'
  ].join('\n');

  // ---- module state ----
  var gl = null, N = 0, dx = 0;
  var params = { manning: 0.03, waveAmplitude: 8, wavePeriod: 240, waveform: 'pulse', waveTrough: 0.35 };
  var WAVEFORMS = { pulse: 0, nwave: 1, sustained: 2, train: 3 };
  var progStep, progInit, progSpeed, progReduce, progMax;
  var texCur, texAux1, texAux2, fboCur, fboAux1, fboAux2;
  var terrainTex, maxPP, speedUnit, reduceChain;
  var resources = [];           // for cleanup on re-init
  var stepCount = 0, spongeW = 0, sideW = 0, unstable = false;
  var api = { simTime: 0, stateTexture: null, maxTexture: null, terrainTexture: null };

  function track(kind, obj) { resources.push({ kind: kind, obj: obj }); return obj; }

  function dispose() {
    for (var i = 0; i < resources.length; i++) {
      var r = resources[i];
      if (r.kind === 't') gl.deleteTexture(r.obj);
      else if (r.kind === 'f') gl.deleteFramebuffer(r.obj);
    }
    resources = [];
  }

  function makeUnit(fmt, filter) {
    var t = track('t', TS.gl.createTexture(gl, N, N, fmt, null, filter));
    return { tex: t, fbo: track('f', TS.gl.createFBO(gl, t)) };
  }

  function init(glCtx, opts) {
    gl = glCtx;
    if (resources.length) dispose();
    N = opts.N; dx = opts.dx;
    spongeW = Math.max(6, Math.round(N * 0.02));
    sideW = Math.max(10, Math.round(N * 0.04));

    if (!progStep) {
      progStep = TS.gl.program(gl, TS.gl.QUAD_VS, STEP_FS);
      progInit = TS.gl.program(gl, TS.gl.QUAD_VS, INIT_FS);
      progSpeed = TS.gl.program(gl, TS.gl.QUAD_VS, SPEED_FS);
      progReduce = TS.gl.program(gl, TS.gl.QUAD_VS, REDUCE_FS);
      progMax = TS.gl.program(gl, TS.gl.QUAD_VS, MAXACC_FS);
    }

    // State textures use LINEAR when available: the solver only texelFetches (filter
    // irrelevant to physics) but renderers sample smoothly.
    var f = gl.floatLinear ? gl.LINEAR : gl.NEAREST;
    var a = makeUnit(gl.RGBA32F, f), b = makeUnit(gl.RGBA32F, f), c = makeUnit(gl.RGBA32F, f);
    texCur = a.tex; fboCur = a.fbo;
    texAux1 = b.tex; fboAux1 = b.fbo;
    texAux2 = c.tex; fboAux2 = c.fbo;

    terrainTex = track('t', TS.gl.createTexture(gl, N, N, gl.R32F, opts.terrain, f));
    maxPP = {
      src: makeUnit(gl.RG32F, f),
      dst: makeUnit(gl.RG32F, f),
      swap: function () { var t = this.src; this.src = this.dst; this.dst = t; }
    };
    // R32F for the CFL scratch textures (saves 4x memory at big N); only the tiny
    // final level is RGBA32F because readPixels of float is only guaranteed for RGBA.
    speedUnit = makeUnit(gl.R32F, gl.NEAREST);

    reduceChain = [];
    var s = N;
    while (s > 8) {
      s = Math.ceil(s / 4);
      var fmt = s <= 8 ? gl.RGBA32F : gl.R32F;
      var t = track('t', TS.gl.createTexture(gl, s, s, fmt, null, gl.NEAREST));
      reduceChain.push({ size: s, tex: t, fbo: track('f', TS.gl.createFBO(gl, t)) });
    }
    api.readBuf = new Float32Array(8 * 8 * 4);

    api.terrainTexture = terrainTex;
    reset();
  }

  function pass(prog, fbo, size, setUniforms) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, size, size);
    TS.gl.drawQuad(gl, prog, setUniforms);
  }

  function reset() {
    api.simTime = 0; stepCount = 0; unstable = false;
    dt = 0.9 * CFL * dx / Math.sqrt(9.81 * 80);   // safe pre-wave estimate
    pass(progInit, fboCur, N, function (g2, u) {
      TS.gl.bindTex(g2, 0, terrainTex, u.u_terrain);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, maxPP.src.fbo);
    gl.viewport(0, 0, N, N);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    api.stateTexture = texCur;
    api.maxTexture = maxPP.src.tex;
  }

  var dt = 0.05;

  function stageUniforms(inputTex, blend, u) {
    TS.gl.bindTex(gl, 0, inputTex, u.u_state);
    TS.gl.bindTex(gl, 1, texCur, u.u_prev);
    gl.uniform1f(u.u_blend, blend);
    gl.uniform1f(u.u_dt, dt);
    gl.uniform1f(u.u_dx, dx);
    gl.uniform1f(u.u_manning, params.manning);
    gl.uniform1f(u.u_time, api.simTime);
    gl.uniform1i(u.u_N, N);
    gl.uniform1i(u.u_spongeW, spongeW);
    gl.uniform1i(u.u_sideW, sideW);
    gl.uniform1f(u.u_waveAmp, params.waveAmplitude);
    gl.uniform1f(u.u_wavePeriod, params.wavePeriod);
    gl.uniform1f(u.u_trough, params.waveTrough);
    gl.uniform1i(u.u_waveform, WAVEFORMS[params.waveform] || 0);
  }

  function updateDt() {
    pass(progSpeed, speedUnit.fbo, N, function (g2, u) {
      TS.gl.bindTex(g2, 0, texCur, u.u_state);
    });
    var srcTex = speedUnit.tex, srcSize = N;
    for (var i = 0; i < reduceChain.length; i++) {
      var lvl = reduceChain[i];
      (function (sTex, sSize) {
        pass(progReduce, lvl.fbo, lvl.size, function (g2, u) {
          TS.gl.bindTex(g2, 0, sTex, u.u_src);
          g2.uniform1i(u.u_srcSize, sSize);
        });
      })(srcTex, srcSize);
      srcTex = lvl.tex; srcSize = lvl.size;
    }
    var last = reduceChain[reduceChain.length - 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, last.fbo);
    gl.readPixels(0, 0, last.size, last.size, gl.RGBA, gl.FLOAT, api.readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    var m = 0;
    for (var k = 0; k < last.size * last.size; k++) m = Math.max(m, api.readBuf[k * 4]);
    if (!isFinite(m) || m > MAX_SPEED) { unstable = true; return; }
    dt = CFL * dx / Math.max(m, 4.0);
    dt = Math.min(dt, 0.05 * dx);   // cap: never outrun the sponge relaxation
  }

  function stepBatch(n) {
    if (unstable) return { simTime: api.simTime, dt: dt, unstable: true };
    for (var i = 0; i < n; i++) {
      // stage 1: cur -> aux1
      pass(progStep, fboAux1, N, function (g2, u) { stageUniforms(texCur, 0.0, u); });
      // stage 2: aux1 (+cur as prev) -> aux2
      pass(progStep, fboAux2, N, function (g2, u) { stageUniforms(texAux1, 0.5, u); });
      // rotate: aux2 becomes cur
      var tT = texCur, tF = fboCur;
      texCur = texAux2; fboCur = fboAux2;
      texAux2 = tT; fboAux2 = tF;
      api.simTime += dt;
      stepCount++;
      if (stepCount % MAX_EVERY === 0) {
        pass(progMax, maxPP.dst.fbo, N, function (g2, u) {
          TS.gl.bindTex(g2, 0, texCur, u.u_state);
          TS.gl.bindTex(g2, 1, maxPP.src.tex, u.u_maxPrev);
        });
        maxPP.swap();
      }
      if (stepCount % DT_EVERY === 0) {
        updateDt();
        if (unstable) break;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    api.stateTexture = texCur;
    api.maxTexture = maxPP.src.tex;
    return { simTime: api.simTime, dt: dt, unstable: unstable };
  }

  api.init = init;
  api.reset = reset;
  api.stepBatch = stepBatch;
  api.setParams = function (p) {
    for (var k in p) if (p.hasOwnProperty(k)) params[k] = p[k];
  };
  api.setTerrain = function (data) {
    gl.bindTexture(gl.TEXTURE_2D, terrainTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    reset();
  };
  return api;
})();
