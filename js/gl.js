// TS.gl — shared WebGL2 helpers. See SPEC.md.
window.TS = window.TS || {};
TS.gl = (function () {
  'use strict';

  var quadVAO = null;

  function getContext(canvas) {
    var gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
    if (!gl) return null;
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    // Optional: linear filtering of float textures (nice for 3D vertex sampling).
    gl.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    return gl;
  }

  function compileShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      var numbered = src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n');
      throw new Error('Shader compile error:\n' + log + '\n' + numbered);
    }
    return s;
  }

  // Compile + link a program. Returns { prog, uniforms } where uniforms is a
  // name -> WebGLUniformLocation map of every active uniform.
  function program(gl, vsSrc, fsSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    }
    var uniforms = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      var name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, info.name);
    }
    return { prog: p, uniforms: uniforms };
  }

  // Fullscreen-triangle vertex shader usable by any quad pass.
  var QUAD_VS = [
    '#version 300 es',
    'out vec2 v_uv;',
    'void main() {',
    '  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);',
    '  v_uv = p;',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Draw a fullscreen pass with the given fragment program ({prog, uniforms}).
  // setUniforms(gl, uniforms) is called after useProgram; caller binds textures.
  function drawQuad(gl, progObj, setUniforms) {
    if (!quadVAO) quadVAO = gl.createVertexArray();
    gl.useProgram(progObj.prog);
    if (setUniforms) setUniforms(gl, progObj.uniforms);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Float texture. internalFormat: gl.RGBA32F, gl.RG32F, gl.R32F...
  // data may be null or a Float32Array matching the format.
  function createTexture(gl, w, h, internalFormat, data, filter) {
    var fmt, type = gl.FLOAT;
    switch (internalFormat) {
      case gl.RGBA32F: fmt = gl.RGBA; break;
      case gl.RG32F: fmt = gl.RG; break;
      case gl.R32F: fmt = gl.RED; break;
      default: throw new Error('Unsupported internalFormat');
    }
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, fmt, type, data || null);
    var f = filter || gl.NEAREST;
    if (f === gl.LINEAR && !gl.floatLinear) f = gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  function createFBO(gl, tex) {
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  // A ping-pong pair of same-format textures with FBOs.
  // .src / .dst are {tex, fbo}; call .swap() after rendering into dst.
  function pingPong(gl, w, h, internalFormat, filter) {
    function unit() {
      var tex = createTexture(gl, w, h, internalFormat, null, filter);
      return { tex: tex, fbo: createFBO(gl, tex) };
    }
    var a = unit(), b = unit();
    return {
      src: a, dst: b,
      swap: function () { var t = this.src; this.src = this.dst; this.dst = t; }
    };
  }

  function bindTex(gl, unitIndex, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unitIndex);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (loc) gl.uniform1i(loc, unitIndex);
  }

  return {
    getContext: getContext,
    program: program,
    QUAD_VS: QUAD_VS,
    drawQuad: drawQuad,
    createTexture: createTexture,
    createFBO: createFBO,
    pingPong: pingPong,
    bindTex: bindTex
  };
})();
