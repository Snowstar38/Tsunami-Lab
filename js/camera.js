// TS.mat4 + TS.camera — minimal column-major matrix math and an orbit camera.
// World convention (SPEC.md): right-handed, y-up. x = east, y = elevation (m),
// z = south (grid row j=0, the open ocean, sits at large +z; north is toward z=0).
window.TS = window.TS || {};

TS.mat4 = (function () {
  'use strict';

  // Scratch so multiply() can safely alias its output with an input.
  var TMP = new Float32Array(16);

  function create() {
    var m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  function identity(out) {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
  }

  function perspective(out, fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2);
    var nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  }

  function lookAt(out, eye, center, up) {
    // Camera basis: zAxis points from center back toward the eye.
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;

    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;

    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;

    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  // out = a * b (both column-major); aliasing with a or b is allowed.
  function multiply(out, a, b) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      for (var r = 0; r < 4; r++) {
        TMP[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
      }
    }
    for (var i = 0; i < 16; i++) out[i] = TMP[i];
    return out;
  }

  return { create: create, identity: identity, perspective: perspective, lookAt: lookAt, multiply: multiply };
})();

TS.camera = (function () {
  'use strict';

  var mat4 = TS.mat4;
  var DEG = Math.PI / 180;
  var MIN_PITCH = 5 * DEG, MAX_PITCH = 89 * DEG;
  var MIN_DIST = 50;
  var ORBIT_SENS = 0.005;    // radians per pixel

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function create(canvas, opts) {
    var L = (opts && opts.L) || 10240;
    // Clip planes and zoom range scale with the domain: a 68 km real-world map
    // needs a far plane well beyond the 10 km procedural default, or terrain
    // truncates as the camera orbits.
    var MAX_DIST = Math.max(40000, L * 4);

    var cam = {
      // Orbit state. yaw = 0 puts the eye due south (+z) of the target, so the
      // camera looks north (-z) with the ocean in the foreground.
      target: [L * 0.5, 0, L * 0.55],
      distance: clamp(L * 0.9, MIN_DIST, MAX_DIST),
      yaw: 0,
      pitch: 45 * DEG,
      fovY: 50 * DEG,
      near: Math.max(5, L / 2000),
      far: MAX_DIST + L * 2.5,
      aspect: 1,
      eye: [0, 0, 0],
      view: mat4.create(),
      proj: mat4.create(),
      viewProj: mat4.create()
    };

    cam.resize = function (w, h) {
      if (w > 0 && h > 0) cam.aspect = w / h;
      return cam;
    };

    cam.update = function () {
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      cam.eye[0] = cam.target[0] + cam.distance * cp * Math.sin(cam.yaw);
      cam.eye[1] = cam.target[1] + cam.distance * sp;
      cam.eye[2] = cam.target[2] + cam.distance * cp * Math.cos(cam.yaw);
      mat4.lookAt(cam.view, cam.eye, cam.target, [0, 1, 0]);
      mat4.perspective(cam.proj, cam.fovY, cam.aspect, cam.near, cam.far);
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      return cam;
    };

    // --- input -------------------------------------------------------------
    var drag = null; // { id, mode: 'orbit'|'pan', x, y }

    function onPointerDown(e) {
      if (drag) return;
      var pan = (e.button === 2) || (e.button === 0 && e.shiftKey);
      if (e.button !== 0 && e.button !== 2) return;
      drag = { id: e.pointerId, mode: pan ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;

      if (drag.mode === 'orbit') {
        // Drag right spins the scene right (the eye swings west).
        cam.yaw -= dx * ORBIT_SENS;
        cam.pitch = clamp(cam.pitch + dy * ORBIT_SENS, MIN_PITCH, MAX_PITCH);
      } else {
        // Ground-plane pan. Scale so one pixel of drag moves roughly one pixel
        // worth of world at the target plane.
        var h = canvas.clientHeight || canvas.height || 1;
        var mPerPx = 2 * cam.distance * Math.tan(cam.fovY / 2) / h;
        // Camera-relative ground axes (yaw only).
        var fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw); // forward, away from eye
        var rx = -fz, rz = fx;                                // right = forward x up
        cam.target[0] = clamp(cam.target[0] - rx * dx * mPerPx + fx * dy * mPerPx, 0, L);
        cam.target[2] = clamp(cam.target[2] - rz * dx * mPerPx + fz * dy * mPerPx, 0, L);
      }
      e.preventDefault();
    }

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (canvas.releasePointerCapture && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      drag = null;
    }

    function onWheel(e) {
      var d = e.deltaY;
      if (e.deltaMode === 1) d *= 16;        // lines -> approx pixels
      else if (e.deltaMode === 2) d *= 400;  // pages
      cam.distance = clamp(cam.distance * Math.exp(d * 0.0012), MIN_DIST, MAX_DIST);
      e.preventDefault();
    }

    function onContextMenu(e) { e.preventDefault(); }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    // Optional: main may call this if it ever tears the camera down.
    cam.dispose = function () {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      drag = null;
    };

    cam.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
    cam.update();
    return cam;
  }

  return { create: create };
})();
