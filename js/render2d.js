// TS.render2d — overhead topographic view. Lead-owned. See SPEC.md.
// Renders the standard state texture (r=h, g=hu, b=hv, a=B) letterboxed into the canvas.
window.TS = window.TS || {};
TS.render2d = (function () {
  'use strict';

  var FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_state;',
    'uniform sampler2D u_max;',
    'uniform int u_showMax;',
    'uniform vec2 u_canvas;',
    'uniform float u_dx;        // meters per SIM cell (gradients use texture cell size)',
    'uniform float u_L;         // domain size, m',
    'uniform int u_rot;         // view rotation, quarter turns CCW (0..3)',
    'uniform int u_outline;     // draw the original sea-level coastline contour',
    'in vec2 v_uv;',
    'out vec4 o;',

    'vec3 terrainColor(float B) {',
    '  if (B < 0.0) {',
    '    float t = clamp(1.0 + B / 60.0, 0.0, 1.0);',   // -60 m .. 0
    '    return mix(vec3(0.13, 0.19, 0.26), vec3(0.42, 0.46, 0.44), t);',
    '  }',
    '  vec3 sand  = vec3(0.78, 0.71, 0.55);',
    '  vec3 grass = vec3(0.42, 0.52, 0.33);',
    '  vec3 brown = vec3(0.48, 0.41, 0.31);',
    '  vec3 rock  = vec3(0.58, 0.57, 0.55);',
    '  vec3 c = mix(sand, grass, smoothstep(0.5, 6.0, B));',
    '  c = mix(c, brown, smoothstep(35.0, 110.0, B));',
    '  return mix(c, rock, smoothstep(140.0, 250.0, B));',
    '}',

    'void main() {',
    '  float side = min(u_canvas.x, u_canvas.y);',
    '  vec2 uv = (gl_FragCoord.xy - 0.5 * (u_canvas - vec2(side))) / side;',
    '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {',
    '    o = vec4(0.078, 0.09, 0.11, 1.0); return;',
    '  }',
    // View rotation: remap screen uv into texture uv (k quarter turns CCW on
    // screen), and counter-rotate the hillshade light so illumination keeps
    // coming from the screen's upper left.
    '  vec2 light = normalize(vec2(-0.6, 0.8));',
    '  for (int k = 0; k < u_rot; k++) {',
    '    uv = vec2(uv.y, 1.0 - uv.x);',
    '    light = vec2(light.y, -light.x);',
    '  }',
    '  vec2 ts = vec2(textureSize(u_state, 0));',
    '  vec2 e = 1.0 / ts;',
    '  float cell = u_L / ts.x;',   // meters per texel of THIS texture (live or replay)
    '  vec4 s = texture(u_state, uv);',
    '  float h = s.r, B = s.a;',

    // Hillshade from terrain gradient, light from the northwest.
    '  float Bx = texture(u_state, uv + vec2(e.x, 0.0)).a - texture(u_state, uv - vec2(e.x, 0.0)).a;',
    '  float By = texture(u_state, uv + vec2(0.0, e.y)).a - texture(u_state, uv - vec2(0.0, e.y)).a;',
    '  vec2 g = vec2(Bx, By) / (2.0 * cell);',
    '  float shade = clamp(0.85 + 1.6 * dot(g, light), 0.45, 1.35);',
    '  vec3 c = terrainColor(B) * shade;',

    '  if (h > 0.05) {',
    '    vec3 shallow = vec3(0.25, 0.62, 0.66);',
    '    vec3 deep    = vec3(0.05, 0.15, 0.35);',
    '    vec3 wc = mix(shallow, deep, 1.0 - exp(-h / 9.0));',
    // Surface (B+h) gradient shading makes wavefronts and drawdown visible from above.
    '    vec4 sE = texture(u_state, uv + vec2(e.x, 0.0));',
    '    vec4 sW = texture(u_state, uv - vec2(e.x, 0.0));',
    '    vec4 sN = texture(u_state, uv + vec2(0.0, e.y));',
    '    vec4 sS = texture(u_state, uv - vec2(0.0, e.y));',
    '    vec2 ge = vec2((sE.r + sE.a) - (sW.r + sW.a), (sN.r + sN.a) - (sS.r + sS.a)) / (2.0 * cell);',
    '    float wshade = clamp(1.0 + 3.5 * dot(ge, light), 0.55, 1.7);',
    '    wc *= wshade;',
    '    float sp = length(s.gb) / max(h, 0.05);',
    '    wc = mix(wc, vec3(0.92, 0.96, 0.97), smoothstep(3.0, 8.0, sp) * 0.6);',
    '    float alpha = clamp(0.55 + h * 0.35, 0.0, 0.93);',
    '    c = mix(c, wc, alpha);',
    '  }',

    '  if (u_showMax == 1) {',
    '    float mh = texture(u_max, uv).r;',
    '    if (mh > 0.05 && h <= 0.02 && B > 0.0) {',
    '      c = mix(c, vec3(0.85, 0.25, 0.2), clamp(0.15 + mh * 0.06, 0.15, 0.45));',
    '    }',
    '  }',

    // Original coastline: a thin dark contour where terrain crosses sea level,
    // drawn over water too so the drowned shoreline stays readable mid-flood.
    // fwidth keeps it ~1.5 px on screen; the relief gate hides it over marshes
    // and tidal flats that hover AT sea level (real in the Cape Cod data), where
    // a zero-contour otherwise smears into blotches.
    '  if (u_outline == 1) {',
    '    float bE2 = texture(u_state, uv + vec2(e.x, 0.0)).a;',
    '    float bW2 = texture(u_state, uv - vec2(e.x, 0.0)).a;',
    '    float bN2 = texture(u_state, uv + vec2(0.0, e.y)).a;',
    '    float bS2 = texture(u_state, uv - vec2(0.0, e.y)).a;',
    '    float bmin = min(B, min(min(bE2, bW2), min(bN2, bS2)));',
    '    float bmax = max(B, max(max(bE2, bW2), max(bN2, bS2)));',
    '    float w = fwidth(B) + 1e-5;',
    '    float m = 1.0 - smoothstep(0.6 * w, 1.8 * w, abs(B));',
    '    m *= smoothstep(0.0015 * cell, 0.004 * cell, bmax - bmin);',
    '    c = mix(c, vec3(0.04, 0.04, 0.05), m * 0.6);',
    '  }',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var prog = null;

  function draw(gl, opts) {
    if (!prog) prog = TS.gl.program(gl, TS.gl.QUAD_VS, FS);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    TS.gl.drawQuad(gl, prog, function (g2, u) {
      TS.gl.bindTex(g2, 0, opts.stateTex, u.u_state);
      TS.gl.bindTex(g2, 1, opts.maxTex || opts.stateTex, u.u_max);
      g2.uniform1i(u.u_showMax, opts.showMax ? 1 : 0);
      g2.uniform2f(u.u_canvas, opts.width, opts.height);
      g2.uniform1f(u.u_dx, opts.dx);
      g2.uniform1f(u.u_L, opts.L);
      g2.uniform1i(u.u_rot, opts.rot || 0);
      g2.uniform1i(u.u_outline, opts.outline ? 1 : 0);
    });
  }

  return { draw: draw };
})();
