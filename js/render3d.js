// TS.render3d — 3D heightfield: opaque terrain pass + blended water surface pass.
// Both passes share one vertex grid and read the RGBA32F state texture
// (r=h, g=hu, b=hv, a=B) in the vertex shader for displacement and in the
// fragment shader for shading. The state texture may be ANY resolution (live N
// or a downsampled replay frame) — everything is addressed by uv, and per-texel
// world spacing is derived from textureSize() at runtime.
window.TS = window.TS || {};

TS.render3d = (function () {
  'use strict';

  // Fixed sun, pre-normalized from (-0.5, 0.8, -0.3) so it stays a compile-time
  // constant on every driver.
  var SUN = 'const vec3 SUN = vec3(-0.505076, 0.808122, -0.303046);\n';

  // Mesh vertex (s,t) in [0,1]^2 -> grid cell (fractional) -> world + uv.
  //   worldX = s * u_worldSize,          i = s * (N-1)
  //   worldZ = t * u_worldSize,          j = (1-t) * (N-1)   (row j=0 = south = +Z)
  //   uv     = (i+0.5)/N , (j+0.5)/N  == coord * u_uvScale + u_uvOffset
  function meshVS(heightExpr) {
    return `#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) in vec2 a_grid;   // (s,t) in [0,1]

uniform sampler2D u_state;
uniform mat4 u_viewProj;
uniform float u_worldSize;   // (N-1)*dx, meters spanned by the vertex grid
uniform float u_uvScale;     // (N-1)/N
uniform float u_uvOffset;    // 0.5/N
uniform float u_exag;        // vertical exaggeration (display only)

out vec2 v_uv;
out vec3 v_pos;

void main() {
  vec2 uv = vec2(a_grid.x, 1.0 - a_grid.y) * u_uvScale + u_uvOffset;
  vec4 s = texture(u_state, uv);
  float y = ${heightExpr};
  vec3 p = vec3(a_grid.x * u_worldSize, y * u_exag, a_grid.y * u_worldSize);
  v_uv = uv;
  v_pos = p;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;
  }

  var TERRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_state;
uniform float u_domainL;   // N*dx, meters spanned by the whole state texture
uniform float u_exag;
uniform int u_outline;     // paint the original sea-level coastline

in vec2 v_uv;
in vec3 v_pos;
out vec4 fragColor;

${SUN}

// Muted shaded-relief palette; b is TRUE elevation in meters (sea level 0).
vec3 hypsometric(float b) {
  vec3 abyss    = vec3(0.15, 0.20, 0.27);
  vec3 shelf    = vec3(0.29, 0.36, 0.41);
  vec3 tideflat = vec3(0.50, 0.51, 0.47);
  vec3 sand     = vec3(0.76, 0.71, 0.56);
  vec3 grass    = vec3(0.47, 0.55, 0.36);
  vec3 forest   = vec3(0.31, 0.41, 0.28);
  vec3 earth    = vec3(0.45, 0.40, 0.30);
  vec3 rock     = vec3(0.52, 0.50, 0.47);
  vec3 bare     = vec3(0.68, 0.67, 0.65);
  if (b < -12.0) return mix(abyss, shelf, smoothstep(-70.0, -12.0, b));
  if (b <  -1.0) return mix(shelf, tideflat, smoothstep(-12.0, -1.0, b));
  if (b <   1.5) return mix(tideflat, sand, smoothstep(-1.0, 1.5, b));
  if (b <  12.0) return mix(sand, grass, smoothstep(1.5, 12.0, b));
  if (b <  60.0) return mix(grass, forest, smoothstep(12.0, 60.0, b));
  if (b < 130.0) return mix(forest, earth, smoothstep(60.0, 130.0, b));
  if (b < 200.0) return mix(earth, rock, smoothstep(130.0, 200.0, b));
  return mix(rock, bare, smoothstep(200.0, 330.0, b));
}

void main() {
  vec2 sz = vec2(textureSize(u_state, 0));
  vec2 texel = 1.0 / sz;
  float cell = u_domainL / sz.x;   // meters between adjacent texels

  float b  = texture(u_state, v_uv).a;
  // Central differences; CLAMP_TO_EDGE makes the domain border a one-sided
  // difference instead of a crack.
  float bE = texture(u_state, v_uv + vec2(texel.x, 0.0)).a;
  float bW = texture(u_state, v_uv - vec2(texel.x, 0.0)).a;
  float bN = texture(u_state, v_uv + vec2(0.0, texel.y)).a;
  float bS = texture(u_state, v_uv - vec2(0.0, texel.y)).a;

  // +v is +j is north, which is -Z in world space -> flip the z derivative.
  float dhdx =  (bE - bW) / (2.0 * cell) * u_exag;
  float dhdz = -(bN - bS) / (2.0 * cell) * u_exag;
  vec3 n = normalize(vec3(-dhdx, 1.0, -dhdz));

  vec3 base = hypsometric(b);
  float lambert = max(dot(n, SUN), 0.0);
  float sky = 0.5 + 0.5 * n.y;                       // hemispheric fill
  vec3 lit = base * (0.30 + 0.34 * sky + 0.72 * lambert);

  // Subtle slope darkening so relief reads even in flat light.
  lit *= mix(1.0, 0.80, smoothstep(0.12, 0.80, 1.0 - n.y));

  // Original sea-level coastline, painted on the terrain itself: it shows through
  // shallow water (water blends over it) and fades naturally in the deep. Same
  // fwidth iso-line + flat-terrain relief gate as the 2D view.
  if (u_outline == 1) {
    float bmin = min(b, min(min(bE, bW), min(bN, bS)));
    float bmax = max(b, max(max(bE, bW), max(bN, bS)));
    float w = fwidth(b) + 1e-5;
    float m = 1.0 - smoothstep(0.6 * w, 1.8 * w, abs(b));
    m *= smoothstep(0.0015 * cell, 0.004 * cell, bmax - bmin);
    lit = mix(lit, vec3(0.04, 0.04, 0.05), m * 0.6);
  }

  fragColor = vec4(lit, 1.0);
}`;

  var WATER_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_state;
uniform float u_domainL;
uniform float u_exag;
uniform float u_time;
uniform vec3 u_eye;

in vec2 v_uv;
in vec3 v_pos;
out vec4 fragColor;

${SUN}
const float DRY = 0.02;   // wet/dry threshold, meters (SPEC)

// Water-surface elevation, falling back to the centre value on dry neighbours
// so the shoreline doesn't generate absurd normals.
float eta(vec2 uv, float fallback) {
  vec4 s = texture(u_state, uv);
  return s.r > DRY ? s.a + s.r : fallback;
}

void main() {
  vec4 s = texture(u_state, v_uv);
  float h = s.r;
  if (h < DRY) discard;   // crisp shoreline, independent of vertex tessellation

  vec2 sz = vec2(textureSize(u_state, 0));
  vec2 texel = 1.0 / sz;
  float cell = u_domainL / sz.x;

  float e0 = s.a + h;
  float dEdx =  (eta(v_uv + vec2(texel.x, 0.0), e0) - eta(v_uv - vec2(texel.x, 0.0), e0)) / (2.0 * cell);
  float dEdz = -(eta(v_uv + vec2(0.0, texel.y), e0) - eta(v_uv - vec2(0.0, texel.y), e0)) / (2.0 * cell);
  vec3 n = normalize(vec3(-dEdx * u_exag, 1.0, -dEdz * u_exag));
  // Soften per-texel normal noise (it reads as visual static at high N).
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.8));

  // Faint animated chop; non-axis-aligned wave vectors of unrelated scales, or the
  // pair of sines reads as a checkerboard on calm water.
  float chop = 0.006 * (sin(dot(v_pos.xz, vec2(0.041, 0.023)) + u_time * 1.3)
                      + sin(dot(v_pos.xz, vec2(-0.017, 0.058)) + u_time * 0.9));
  n = normalize(n + vec3(chop, 0.0, chop * 0.6));

  // Depth colour: aqua in the shallows, navy offshore (exponential falloff).
  vec3 shallow = vec3(0.32, 0.68, 0.70);
  vec3 deep    = vec3(0.03, 0.10, 0.24);
  float dt = 1.0 - exp(-h / 9.0);          // ~0.05 at 0.5 m, ~0.96 at 30 m
  vec3 col = mix(shallow, deep, dt);

  // Whitecaps where the flow is fast (speed = |q| / h); damped on thin films so
  // centimeter-deep sheets on flooded land don't strobe white.
  float speed = length(s.gb) / max(h, 0.05);
  float foam = smoothstep(3.0, 8.0, speed) * smoothstep(0.05, 0.35, h);
  col = mix(col, vec3(0.86, 0.90, 0.92), foam * 0.75);

  vec3 V = normalize(u_eye - v_pos);
  float facing = max(dot(n, V), 0.0);
  float fresnel = pow(1.0 - facing, 3.0);

  // Sky/sun tint on the reflective grazing angles.
  col = mix(col, vec3(0.42, 0.53, 0.66), fresnel * 0.55);
  float spec = pow(max(dot(n, normalize(SUN + V)), 0.0), 140.0);
  col += vec3(1.0, 0.97, 0.88) * spec * 0.35;

  // Look straight down into shallow water (transparent), grazing angles opaque.
  float alpha = mix(0.55, 0.90, fresnel);
  alpha = mix(alpha, 0.92, foam * 0.8);
  alpha = max(alpha, smoothstep(0.0, 6.0, h) * 0.75);   // deep water stays solid
  // Fade thin sheets in instead of popping at the DRY cutoff — kills the
  // z-fighting flicker where a film of water hugs low-lying terrain.
  alpha *= smoothstep(DRY, 0.22, h);

  fragColor = vec4(col, clamp(alpha, 0.0, 0.92));
}`;

  var terrainProg = null, waterProg = null;
  var vao = null, vbo = null, ibo = null;
  var indexCount = 0;
  var worldSize = 0, uvScale = 1, uvOffset = 0, domainL = 0;
  var viewW = 1, viewH = 1;

  function destroy(gl) {
    if (vao) gl.deleteVertexArray(vao);
    if (vbo) gl.deleteBuffer(vbo);
    if (ibo) gl.deleteBuffer(ibo);
    if (terrainProg) gl.deleteProgram(terrainProg.prog);
    if (waterProg) gl.deleteProgram(waterProg.prog);
    vao = vbo = ibo = terrainProg = waterProg = null;
  }

  // (M+1)^2 vertices holding normalized (s,t); M*M*2 triangles, Uint32 indices.
  function buildMesh(gl, M) {
    var side = M + 1;
    var verts = new Float32Array(side * side * 2);
    var k = 0;
    for (var iz = 0; iz < side; iz++) {
      var t = iz / M;
      for (var ix = 0; ix < side; ix++) {
        verts[k++] = ix / M;
        verts[k++] = t;
      }
    }
    var idx = new Uint32Array(M * M * 6);
    var o = 0;
    for (var z = 0; z < M; z++) {
      for (var x = 0; x < M; x++) {
        var a = z * side + x, b = a + 1, c = a + side, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    indexCount = idx.length;
  }

  function init(gl, opts) {
    if (vao) destroy(gl);   // re-init on resolution change

    var N = opts.N, dx = opts.dx;
    worldSize = (N - 1) * dx;   // vertices sit on cell centres 0..N-1
    domainL = N * dx;
    uvScale = (N - 1) / N;
    uvOffset = 0.5 / N;

    buildMesh(gl, Math.min(N, 512));
    terrainProg = TS.gl.program(gl, meshVS('s.a'), TERRAIN_FS);
    waterProg = TS.gl.program(gl, meshVS('s.a + max(s.r, 0.0)'), WATER_FS);
  }

  function resize(w, h) {
    viewW = w; viewH = h;   // viewport itself is main.js's job
  }

  function setCommon(gl, p, cam, exag) {
    var u = p.uniforms;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(u.u_viewProj, false, cam.viewProj);
    gl.uniform1f(u.u_worldSize, worldSize);
    gl.uniform1f(u.u_uvScale, uvScale);
    gl.uniform1f(u.u_uvOffset, uvOffset);
    gl.uniform1f(u.u_exag, exag);
    gl.uniform1f(u.u_domainL, domainL);
  }

  function draw(gl, args) {
    if (!vao || !args || !args.stateTex || !args.cam) return;
    var exag = args.exaggeration || 2;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);   // heightfield is viewable from below/edge-on
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);

    // Terrain (opaque).
    setCommon(gl, terrainProg, args.cam, exag);
    gl.uniform1i(terrainProg.uniforms.u_outline, args.outline ? 1 : 0);
    TS.gl.bindTex(gl, 0, args.stateTex, terrainProg.uniforms.u_state);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);

    // Water (blended, still writes depth).
    setCommon(gl, waterProg, args.cam, exag);
    gl.uniform1f(waterProg.uniforms.u_time, args.time || 0);
    gl.uniform3fv(waterProg.uniforms.u_eye, args.cam.eye);
    TS.gl.bindTex(gl, 0, args.stateTex, waterProg.uniforms.u_state);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Pull the water surface slightly toward the camera in depth so a thin film
    // over terrain can't z-fight with it.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1.0, -2.0);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // Leave GL close to defaults for whatever draws next.
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }

  return { init: init, resize: resize, draw: draw };
})();
