// TS.terrain — procedural coastal terrain. Pure JS: no WebGL, no DOM. See SPEC.md.
//
// Everything is evaluated in normalized domain coordinates u,v in [0,1] (u = east,
// v = north, v = 0 is the south/open-ocean edge), so a given seed produces the exact
// same landforms at every N. The grid resolution only changes how finely that
// continuous field is sampled. All noise is band-limited to wavelengths >= ~250 m,
// which is >= 6 cells even at N = 256 (dx = 40 m) — no aliasing, no single-cell spikes.
window.TS = window.TS || {};
TS.terrain = (function () {
  'use strict';

  var L = 10240; // physical domain size in meters (fixed regardless of N)

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // Works with a > b too (returns a decreasing ramp), which we use for band edges.
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Classic 2D Perlin gradient noise with random unit gradients and a quintic fade
  // (C2 continuous — a fluid solver sees no slope discontinuities). Returns ~[-1, 1].
  function makeNoise(rand) {
    var P = new Uint8Array(512);
    var GX = new Float32Array(256);
    var GY = new Float32Array(256);
    var i, a;
    for (i = 0; i < 256; i++) {
      P[i] = i;
      a = rand() * Math.PI * 2;
      GX[i] = Math.cos(a);
      GY[i] = Math.sin(a);
    }
    for (i = 255; i > 0; i--) { // Fisher-Yates
      var j = (rand() * (i + 1)) | 0;
      var t = P[i]; P[i] = P[j]; P[j] = t;
    }
    for (i = 0; i < 256; i++) P[i + 256] = P[i];

    return function noise(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      var X = xi & 255, Y = yi & 255;
      var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      var A = P[X] + Y, B = P[X + 1] + Y;
      var g00 = P[A], g01 = P[A + 1], g10 = P[B], g11 = P[B + 1];
      var n00 = GX[g00] * xf + GY[g00] * yf;
      var n10 = GX[g10] * (xf - 1) + GY[g10] * yf;
      var n01 = GX[g01] * xf + GY[g01] * (yf - 1);
      var n11 = GX[g11] * (xf - 1) + GY[g11] * (yf - 1);
      var nx0 = n00 + u * (n10 - n00);
      var nx1 = n01 + u * (n11 - n01);
      return (nx0 + v * (nx1 - nx0)) * 1.4; // scale peak amplitude to ~1
    };
  }

  function generate(params) {
    var p = params || {};
    var N = Math.max(2, p.N | 0);
    var C = clamp01(p.coastComplexity === undefined ? 0.5 : p.coastComplexity);
    var H = clamp01(p.hilliness === undefined ? 0.5 : p.hilliness);
    var wantBarrier = !!p.barrierIslands;
    var wantRiver = !!p.riverValley;

    var rand = mulberry32((p.seed | 0) ^ 0x9e3779b9);
    var nA = makeNoise(rand); // isotropic relief bank (shelf, plain, hill masses)
    var nB = makeNoise(rand); // drainage bank, sampled anisotropically (see below)

    // coastComplexity drives two overlapping regimes. Clo saturates at C = 0.5, so the
    // bottom half of the slider spans what used to be its whole range (existing seeds
    // stay recognizable at C ~ 0.5). Chi opens only above 0.4 and drives the dramatic
    // stuff: emergent rocky islands, peninsulas, near-severed headlands, drowned bays.
    var Clo = clamp01(C * 2);
    var Chi = clamp01((C - 0.4) / 0.6);
    var rugged = clamp01(0.25 + 0.40 * H + 0.45 * Chi);

    // ---- per-seed landform constants ------------------------------------------
    var coastV = 0.38 + 0.13 * rand();   // mean shoreline as a fraction of the domain
    var shelfW = coastV * L;             // mean shelf width, m (sets the -60 m south edge)
    // Warp amplitudes are bounded by their gradients, not their looks: amp * 2pi * freq
    // is how much this warp can stretch or compress space, and stacking octaves past a
    // combined ~1.0 folds the map over itself and multiplies every downstream slope.
    var warpAmp = 0.010 + 0.045 * Clo;   // freq 2.3 -> gradient <= 0.79
    var warpAmp2 = 0.009 * Chi;          // freq 5.0 -> gradient <= 0.28
    var hillStart = (700 + 1800 * (1 - H)) * (0.7 + 0.6 * rand()); // m inland
    var hillRamp = 1000 + 900 * (1 - H);
    var maxHill = 25 + 285 * Math.pow(H, 1.2);                     // m
    var dissectAmp = 3 + 34 * Math.pow(Clo, 1.35) + 14 * Chi;      // m of valley cutting
    var landAmp = 28 * Chi;              // m of non-monotonic land/sea perturbation
    var detailAmp = 0.8 + 3.2 * rugged;  // m of fine rock texture
    var islandX = 420 + 380 * rand();    // barrier chain distance offshore, m
    var islandHalf = 60 + 60 * rand();   // half-width of the flat crest, m
    var islandFlank = 120 + 120 * rand();// width of the seaward/landward flanks, m
    var lagoonD = 2 + 3 * rand();        // lagoon depth behind the chain, m
    var crestH = 1.0 + 1.6 * rand();     // island crest above sea level, m
    var riverU = 0.18 + 0.64 * rand();   // river mouth position along the coast
    var riverBend = 0.03 + 0.04 * rand();

    // ---- shoreline position as a function of u --------------------------------
    // Sampled into a lookup table because the warped u we query with is not on the
    // grid; the curve is very smooth so linear interpolation error is sub-millimeter.
    var CN = 8192, CU0 = -0.3, CU1 = 1.3;
    var coastLUT = new Float32Array(CN + 1);
    var f1 = 1.6 + 0.8 * rand(), f2 = 4.2 + 1.4 * rand(), f3 = 8.0 + 3.0 * rand();
    var ph1 = rand() * 90, ph2 = rand() * 90, ph3 = rand() * 90;
    for (var k = 0; k <= CN; k++) {
      var uu = CU0 + (CU1 - CU0) * (k / CN);
      var c = coastV;
      c += (0.030 + 0.055 * Clo) * nA(uu * f1 + ph1, ph1 * 0.37);  // broad bays/headlands
      c += (0.006 + 0.024 * Clo) * nA(uu * f2 + ph2, ph2 * 0.11);  // secondary crenulation
      // Narrow ridge-lines pushed inland = occasional deep inlet (high complexity only).
      // The 0.25 is the mean of notch^4, subtracted so complexity adds inlets without
      // systematically marching the whole coastline north.
      var notch = 1 - Math.abs(nA(uu * f3 + ph3, 21.5));
      c += 0.05 * Clo * Clo * (notch * notch * notch * notch - 0.25);
      coastLUT[k] = c < 0.2 ? 0.2 : (c > 0.66 ? 0.66 : c);
    }
    var coastScale = CN / (CU1 - CU0);

    // Landmass bank. Created after every per-seed draw above so that adding it did not
    // shift the PRNG stream — a given seed keeps the same coastline, hills, barrier
    // chain and river it had before this field existed.
    var nD = makeNoise(rand);

    // ---- cross-shore profile + band weights, tabulated against distance d ------
    // d = signed distance from the shoreline in meters (+ inland, - seaward).
    // Everything here depends on d alone, so tabulating it keeps exp/pow out of the
    // inner loop entirely.
    var DN = 8192, DMIN = -L, DSCALE = DN / (2 * L);
    var Pe = new Float32Array(DN + 1); // base elevation, m
    var Ph = new Float32Array(DN + 1); // hill weight 0..1
    var Pr = new Float32Array(DN + 1); // general relief amplitude, m
    var Pc = new Float32Array(DN + 1); // channel/canyon amplitude, m
    var Pb = new Float32Array(DN + 1); // coastal dissection band weight 0..1
    var Pm = new Float32Array(DN + 1); // lowest bed the dissection may carve to, m
    var Pl = new Float32Array(DN + 1); // landmass perturbation amplitude, m
    for (k = 0; k <= DN; k++) {
      var d = DMIN + k / DSCALE;
      var hw = smoothstep(hillStart, hillStart + hillRamp, d);
      var e0, amp, can;
      if (d < 0) {
        var x = -d;
        // beach face + gentle linear term + concave shelf reaching ~-60 m at the edge
        e0 = -(2.5 * (1 - Math.exp(-x / 250)) + 0.0016 * x + 48.5 * Math.pow(x / shelfW, 1.35));
        var dep = -e0;
        amp = Math.min(9, 0.22 * dep);              // shelf undulation, scaled by depth
        can = Math.min(14, 0.30 * dep) * (0.45 + 0.75 * Clo); // submarine channels
      } else {
        e0 = 9 * (1 - Math.exp(-d / 900));          // coastal plain, 0..9 m
        amp = (0.7 + 1.8 * H) * smoothstep(0, 260, d) * (1 - 0.55 * hw) + 3.5 * hw;
        can = 0;
      }
      // Valleys may drown well inland (below-0 basins become lakes / back-bays); only
      // the far interior is held near sea level so rivers still have somewhere to go.
      Pm[k] = d < 0 ? -14 : -14 + 11 * smoothstep(0, 2000, d) + 4.5 * smoothstep(2000, 4500, d);
      // Compact support, so the three landmass octaves can be skipped outright in deep
      // water and the far interior without introducing a step anywhere.
      Pl[k] = landAmp * smoothstep(-3200, -1600, d) * smoothstep(4000, 1800, d);
      var t = (d - 200) / 1400;
      Pe[k] = e0; Ph[k] = hw; Pr[k] = amp; Pc[k] = can; Pb[k] = Math.exp(-t * t);
    }

    // ---- per-row precomputation ------------------------------------------------
    var out = new Float32Array(N * N);
    var inv = 1 / (N - 1);
    var riverPath = new Float32Array(N);
    var southFade = new Float32Array(N); // flat bed in the wave-forcing strip
    for (var j = 0; j < N; j++) {
      var v0 = j * inv;
      southFade[j] = smoothstep(0.012, 0.075, v0);
      if (wantRiver) riverPath[j] = riverU + riverBend * nB(v0 * 2.4 + 55.1, 9.7);
    }

    var anomalies = 0;

    for (j = 0; j < N; j++) {
      var v = j * inv;
      var row = j * N;
      var fade = southFade[j];
      var rPathU = riverPath[j];

      for (var i = 0; i < N; i++) {
        var u = i * inv;

        // Domain warp: bends every downstream field together, which is what turns a
        // smooth shoreline into headlands, bays and (at high complexity) ria fingers.
        var uw = u + warpAmp * nA(u * 2.3 + 13.7, v * 2.3 + 5.1);
        var vw = v + warpAmp * nA(u * 2.3 + 71.3, v * 2.3 + 29.9);
        if (warpAmp2 > 0) { // finer warp: crinkles the shoreline at high complexity
          uw += warpAmp2 * nA(u * 5.0 + 44.9, v * 5.0 + 18.2);
          vw += warpAmp2 * nA(u * 5.0 + 3.4, v * 5.0 + 66.8);
        }

        // shoreline lookup at the warped easting
        var ct = (uw - CU0) * coastScale;
        if (ct < 0) ct = 0; else if (ct > CN - 1) ct = CN - 1;
        var ci = ct | 0;
        var cf = ct - ci;
        var coast = coastLUT[ci] + (coastLUT[ci + 1] - coastLUT[ci]) * cf;

        var dist = (vw - coast) * L; // meters from the shoreline, + inland

        var dt = (dist - DMIN) * DSCALE;
        if (dt < 0) dt = 0; else if (dt > DN - 1) dt = DN - 1;
        var di = dt | 0;
        var df = dt - di;
        var baseE = Pe[di] + (Pe[di + 1] - Pe[di]) * df;
        var hillW = Ph[di] + (Ph[di + 1] - Ph[di]) * df;
        var reliefA = Pr[di] + (Pr[di + 1] - Pr[di]) * df;
        var canyonA = Pc[di] + (Pc[di + 1] - Pc[di]) * df;
        var bandW = Pb[di] + (Pb[di + 1] - Pb[di]) * df;
        var minBed = Pm[di] + (Pm[di + 1] - Pm[di]) * df;
        var landA = Pl[di] + (Pl[di + 1] - Pl[di]) * df;

        // Fine octaves fade out in deep water: they carry no useful bathymetry there
        // and skipping them is most of the cost saving at N = 4096.
        var fine = smoothstep(-2200, -1200, dist);

        var a1 = nA(uw * 2.5 + 3.3, vw * 2.5 + 8.8);
        var a2 = nA(uw * 5.0 + 17.1, vw * 5.0 + 2.4);
        var a3 = nA(uw * 10.0 + 41.9, vw * 10.0 + 60.2);
        var a4 = 0, a5 = 0, a6 = 0;
        if (fine > 0) {
          a4 = nA(uw * 20.0 + 7.7, vw * 20.0 + 91.3);
          a5 = nA(uw * 40.0 + 55.5, vw * 40.0 + 12.1);
          a6 = nA(uw * 80.0 + 23.8, vw * 80.0 + 70.4);
        }
        var fbm = 0.5 * a1 + 0.25 * a2 + 0.125 * a3 + fine * (0.0625 * a4 + 0.03125 * a5);

        // Drainage field: ridge lines of |noise| stretched ~2.5x along north-south, so
        // the channels run downhill toward the sea. One field does three jobs — valleys
        // in the hills, drowned inlets at the shore, submarine canyons offshore — which
        // is what makes them line up into continuous, wave-funneling conduits.
        var b1 = 1 - Math.abs(nB(uw * 4.2 + 2.2, vw * 1.7 + 13.5));
        var b1s = b1 * b1;
        var drain = 0.66 * b1s * b1s * b1s;
        if (fine > 0) {
          var b2 = 1 - Math.abs(nB(uw * 8.8 + 30.7, vw * 3.5 + 44.1));
          var b2s = b2 * b2;
          drain += 0.24 * fine * b2s * b2s;
          if (rugged > 0.02) {                         // finer tributaries when rugged
            var b3 = 1 - Math.abs(nB(uw * 12.0 + 62.4, vw * 4.8 + 8.6));
            drain += 0.10 * rugged * fine * b3 * b3 * b3;
          }
        }

        var e = baseE + reliefA * fbm * fade;

        if (hillW > 0) {
          var m = 0.5 + 0.5 * fbm;
          m = m * m * (3 - 2 * m);                     // contrast: massifs and real gaps
          var mass = hillW * maxHill * m;
          // Drainage carves the hills, harder as ruggedness rises. The carve is soft-
          // capped in absolute metres: without it, tall hills times a narrow channel
          // give near-vertical gorge walls that no grid resolves.
          var cutH = mass * (0.55 + 0.22 * rugged) * drain;
          e += mass - (cutH * 120) / (cutH + 120);
        }

        // Landmass perturbation: the one term that makes the shoreline a non-monotonic
        // function of cross-shore distance. Positive lobes offshore emerge as rocky
        // islands and peninsulas, negative lobes inland drown into back-bays and lakes.
        // Sharpened toward its extremes so lobes read as distinct bodies rather than
        // gentle swells — that is what produces near-severed headlands and isthmuses.
        var blob = 0;
        if (landA > 0) {
          // Lobes ~0.8-3 km across. Lower frequencies than this just push the whole
          // shoreline seaward as one huge peninsula instead of shedding islands.
          blob = 2.4 * (0.45 * nD(uw * 3.2 + 5.1, vw * 3.2 + 61.7) +
                        0.35 * nD(uw * 6.4 + 33.3, vw * 6.4 + 12.9) +
                        0.20 * nD(uw * 12.8 + 77.7, vw * 12.8 + 40.1));
          // Monotone saturation to (-1,1). The gain widens the distribution so lobes
          // routinely reach full amplitude — a raw fBm sits near its mean far too often
          // to ever lift a -18 m bed above water — and the saturation flattens their
          // tops into distinct bodies rather than gentle swells.
          blob = blob / Math.sqrt(1 + blob * blob);
          e += landA * blob * fade;
        }

        // Valley cutting across the shoreline (rias). The same term applies either side
        // of d = 0 so an inlet runs smoothly into its submarine channel. The cut is
        // soft-limited (harmonic blend, not a hard min) so it approaches the allowed
        // bed asymptotically instead of clipping to a flat plateau.
        var cut = dissectAmp * drain * bandW * fade;
        var room = e - minBed;
        if (cut > 0.001 && room > 0.001) e -= (cut * room) / (cut + room);
        e -= canyonA * drain * fade;

        // Fine rock texture, keyed to emergence rather than to distance from the
        // mainland shore, so islands and peninsulas get the same crisp relief the
        // mainland coast has instead of reading as smooth shoals.
        if (fine > 0) {
          e += detailAmp * smoothstep(-30, -2, e) * fine * (0.62 * a5 + 0.38 * a6) * fade;
        }

        if (wantBarrier && dist > -1700 && dist < 300) {
          var g = nA(uw * 6.5 + 88.2, 47.3);           // along-shore chain variation
          var gate = smoothstep(-0.28, 0.16, g);       // gaps = tidal inlets
          // a sandy chain does not get draped over an emergent rocky headland
          if (blob > 0) gate *= 1 - smoothstep(0.35, 0.85, blob);
          if (gate > 0) {
            var xs = -dist;                            // distance seaward of the shore
            var inner = islandX - islandHalf;
            var lagW = smoothstep(40, 220, xs) * smoothstep(inner - 20, inner - 250, xs);
            if (lagW > 0) e += (-lagoonD - e) * 0.85 * lagW * gate;
            // flat-topped crest with smooth flanks (a gaussian leaves too little of the
            // island actually above water to matter to the flow)
            var shape = smoothstep(islandHalf + islandFlank, islandHalf, Math.abs(xs - islandX));
            if (shape > 0) {
              var crest = crestH + 0.6 * g;
              if (crest < 0.8) crest = 0.8;            // keep the crest above sea level
              e += (crest - e) * shape * gate;
            }
          }
        }

        if (wantRiver) {
          var dr = Math.abs(u - rPathU) * L;           // m from the channel axis
          if (dr < 1000) {
            // valley widens downstream toward the mouth
            var vw2 = 120 + 240 * Math.exp(-(dist > 0 ? dist : 0) / 2600);
            var qr = dr / vw2;
            var w = 0.92 * Math.exp(-qr * qr);
            if (dist < 0) { var qo = dist / 700; w *= Math.exp(-qo * qo); } // fade offshore
            if (w > 0.002) {
              // bed is below sea level at the mouth so surge can run up the channel
              var bed = -2.8 + (dist > 0 ? 0.0085 * dist : 0.004 * dist);
              if (bed < e - 45) bed = e - 45;          // no absurd gorges in the hills
              if (bed < e) e += (bed - e) * w;
            }
          }
        }

        if (!(e > -200 && e < 600)) { anomalies++; e = e > 0 ? 600 : -200; }
        out[row + i] = e;
      }
    }

    if (anomalies > 0) {
      console.warn('TS.terrain: clamped ' + anomalies + ' out-of-range cells (seed ' + (p.seed | 0) + ')');
    }
    return out;
  }

  return { generate: generate };
})();
