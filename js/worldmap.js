// TS.worldmap — clickable world map for picking coordinates.
//
// Equirectangular on purpose: longitude→x and latitude→y is a straight linear
// mapping, so click-to-coordinate is exact and there is no projection maths to
// get subtly wrong. A globe looks better but goes mushy near the limb, which is
// precisely where you would be trying to click carefully.
//
// Draws from TS.worldData (see worldmap-data.js). No GL, no network, and nothing
// runs until create() is called.
window.TS = window.TS || {};
TS.worldmap = (function () {
  'use strict';

  var rings = null;      // [{ pts: Float32Array [lon,lat,...], x0,x1,y0,y1 }]

  // Delta + zigzag varint, newline-separated rings.
  function decode(blob) {
    var out = [];
    var parts = blob.split('\n');
    for (var r = 0; r < parts.length; r++) {
      var s = parts[r], i = 0, lx = 0, ly = 0, n = s.length;
      var pts = [], x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      while (i < n) {
        var res = 0, sh = 0, b;
        do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        lx += (res & 1) ? ~(res >> 1) : (res >> 1);
        res = 0; sh = 0;
        do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        ly += (res & 1) ? ~(res >> 1) : (res >> 1);
        var lon = lx / 100, lat = ly / 100;
        pts.push(lon, lat);
        if (lon < x0) x0 = lon;
        if (lon > x1) x1 = lon;
        if (lat < y0) y0 = lat;
        if (lat > y1) y1 = lat;
      }
      if (pts.length >= 8) {
        out.push({ pts: new Float32Array(pts), x0: x0, x1: x1, y0: y0, y1: y1 });
      }
    }
    return out;
  }

  function ensure() {
    if (!rings) rings = TS.worldData ? decode(TS.worldData) : [];
    return rings;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Pick a graticule step that yields roughly 6–12 lines across the view.
  var STEPS = [90, 45, 30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1];
  function gridStep(span) {
    for (var i = 0; i < STEPS.length; i++) {
      if (span / STEPS[i] >= 5) return STEPS[i];
    }
    return STEPS[STEPS.length - 1];
  }

  function fmtLat(v) {
    return Math.abs(v).toFixed(Math.abs(v) % 1 ? 1 : 0) + '°' + (v < 0 ? 'S' : (v > 0 ? 'N' : ''));
  }
  function fmtLon(v) {
    return Math.abs(v).toFixed(Math.abs(v) % 1 ? 1 : 0) + '°' + (v < 0 ? 'W' : (v > 0 ? 'E' : ''));
  }

  function create(canvas, opts) {
    opts = opts || {};
    ensure();

    var W = canvas.width, H = canvas.height;
    // span = degrees across the canvas width. At the usual 2:1 canvas a full
    // 360 span already covers all 180 of latitude, so clat is pinned to 0.
    var view = { clon: 0, clat: 0, span: 360 };
    var pin = null;                                // { lat, lon }
    var extentKm = 0;
    var hover = null;
    var drag = null;

    function spanLat() { return view.span * H / W; }

    function clampView() {
      view.span = clamp(view.span, 1.5, 360);
      var sl = spanLat();
      if (sl >= 180) view.clat = 0;
      else view.clat = clamp(view.clat, -90 + sl / 2, 90 - sl / 2);
      while (view.clon > 180) view.clon -= 360;
      while (view.clon < -180) view.clon += 360;
    }

    function west() { return view.clon - view.span / 2; }
    function north() { return view.clat + spanLat() / 2; }
    function toX(lon) { return (lon - west()) / view.span * W; }
    function toY(lat) { return (north() - lat) / spanLat() * H; }
    function toLon(x) { return west() + x / W * view.span; }
    function toLat(y) { return north() - y / H * spanLat(); }

    // Canvas px from a mouse event, accounting for CSS scaling.
    function evXY(e) {
      var r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (W / r.width),
        y: (e.clientY - r.top) * (H / r.height)
      };
    }

    function draw() {
      var g = canvas.getContext('2d');
      var w0 = west(), w1 = w0 + view.span, n0 = north(), s0 = n0 - spanLat();

      g.fillStyle = '#0d1a26';
      g.fillRect(0, 0, W, H);

      // graticule
      var step = gridStep(view.span);
      g.strokeStyle = 'rgba(255,255,255,.06)';
      g.lineWidth = 1;
      g.beginPath();
      var lo, la;
      for (lo = Math.ceil(w0 / step) * step; lo <= w1; lo += step) {
        var gx = Math.round(toX(lo)) + 0.5;
        g.moveTo(gx, 0); g.lineTo(gx, H);
      }
      for (la = Math.ceil(s0 / step) * step; la <= n0; la += step) {
        var gy = Math.round(toY(la)) + 0.5;
        g.moveTo(0, gy); g.lineTo(W, gy);
      }
      g.stroke();

      // land — three longitude offsets so the map wraps cleanly at ±180
      g.fillStyle = '#31404d';
      g.strokeStyle = '#61798c';
      g.lineWidth = view.span < 40 ? 1 : 0.7;
      var scale = W / view.span;
      for (var off = -360; off <= 360; off += 360) {
        for (var i = 0; i < rings.length; i++) {
          var R = rings[i];
          if (R.x1 + off < w0 || R.x0 + off > w1 || R.y1 < s0 || R.y0 > n0) continue;
          // Skip specks smaller than a pixel — at world zoom that is most of them.
          if ((R.x1 - R.x0) * scale < 0.7 && (R.y1 - R.y0) * scale < 0.7) continue;
          var p = R.pts;
          g.beginPath();
          g.moveTo(toX(p[0] + off), toY(p[1]));
          for (var k = 2; k < p.length; k += 2) g.lineTo(toX(p[k] + off), toY(p[k + 1]));
          g.closePath();
          g.fill();
          g.stroke();
        }
      }

      // graticule labels, on top of the land so they stay readable
      g.font = '9px system-ui, sans-serif';
      g.fillStyle = 'rgba(220,230,240,.5)';
      g.textBaseline = 'top';
      for (lo = Math.ceil(w0 / step) * step; lo <= w1; lo += step) {
        var lx = toX(lo);
        if (lx > 24 && lx < W - 24) g.fillText(fmtLon(lo), lx + 3, 2);
      }
      g.textBaseline = 'alphabetic';
      for (la = Math.ceil(s0 / step) * step; la <= n0; la += step) {
        var ly = toY(la);
        if (ly > 12 && ly < H - 4) g.fillText(fmtLat(la), 3, ly - 3);
      }

      // the area that will actually be fetched
      if (pin && extentKm > 0) {
        var dLat = extentKm / 111.132 / 2;
        var dLon = extentKm / (111.320 * Math.cos(pin.lat * Math.PI / 180)) / 2;
        var bx = toX(pin.lon - dLon), by = toY(pin.lat + dLat);
        var bw = toX(pin.lon + dLon) - bx, bh = toY(pin.lat - dLat) - by;
        if (bw < 3 && bh < 3) {
          bx -= (3 - bw) / 2; by -= (3 - bh) / 2;
          bw = Math.max(bw, 3); bh = Math.max(bh, 3);
        }
        g.strokeStyle = 'rgba(58,214,200,.95)';
        g.lineWidth = 1.5;
        g.strokeRect(bx, by, bw, bh);
        g.fillStyle = 'rgba(58,214,200,.14)';
        g.fillRect(bx, by, bw, bh);
      }

      // pin
      if (pin) {
        var px = toX(pin.lon), py = toY(pin.lat);
        g.strokeStyle = 'rgba(255,255,255,.75)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(px - 9, py); g.lineTo(px - 3, py);
        g.moveTo(px + 3, py); g.lineTo(px + 9, py);
        g.moveTo(px, py - 9); g.lineTo(px, py - 3);
        g.moveTo(px, py + 3); g.lineTo(px, py + 9);
        g.stroke();
        g.fillStyle = '#3ad6c8';
        g.strokeStyle = '#05221f';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(px, py, 3.6, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }

      // live cursor readout
      if (hover) {
        var txt = fmtLat(hover.lat) + '  ' + fmtLon(hover.lon);
        g.font = '10px ui-monospace, Consolas, monospace';
        var tw = g.measureText(txt).width;
        g.fillStyle = 'rgba(8,12,16,.78)';
        g.fillRect(W - tw - 12, H - 18, tw + 10, 15);
        g.fillStyle = '#c3cad6';
        g.textBaseline = 'top';
        g.fillText(txt, W - tw - 7, H - 15);
      }
    }

    // ---- interaction --------------------------------------------------------

    function onDown(e) {
      var p = evXY(e);
      drag = { x: p.x, y: p.y, clon: view.clon, clat: view.clat, moved: 0 };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onMove(e) {
      var p = evXY(e);
      hover = { lat: clamp(toLat(p.y), -90, 90), lon: toLon(p.x) };
      while (hover.lon > 180) hover.lon -= 360;
      while (hover.lon < -180) hover.lon += 360;
      if (drag) {
        var dx = p.x - drag.x, dy = p.y - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        view.clon = drag.clon - dx / W * view.span;
        view.clat = drag.clat + dy / H * spanLat();
        clampView();
      }
      draw();
    }

    function onUp(e) {
      if (!drag) return;
      var p = evXY(e);
      var wasClick = drag.moved < 5;
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (wasClick) {
        var lat = clamp(toLat(p.y), -90, 90), lon = toLon(p.x);
        while (lon > 180) lon -= 360;
        while (lon < -180) lon += 360;
        pin = { lat: lat, lon: lon };
        draw();
        if (opts.onPick) opts.onPick(lat, lon);
      }
    }

    function onLeave() { hover = null; draw(); }

    function onWheel(e) {
      e.preventDefault();
      var p = evXY(e);
      var lon0 = toLon(p.x), lat0 = toLat(p.y);
      var s0 = view.span;
      view.span = clamp(s0 * (e.deltaY > 0 ? 1.25 : 1 / 1.25), 1.5, 360);
      clampView();
      // keep the point under the cursor put
      view.clon += lon0 - toLon(p.x);
      view.clat += lat0 - toLat(p.y);
      clampView();
      draw();
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    clampView();
    draw();

    return {
      // recentre: true always, 'auto' only when the pin would be off-screen
      // (so typing coordinates never drops the pin somewhere you cannot see).
      setPin: function (lat, lon, recentre) {
        if (!isFinite(lat) || !isFinite(lon)) { pin = null; draw(); return; }
        pin = { lat: clamp(lat, -90, 90), lon: lon };
        if (recentre === 'auto') {
          var x = toX(pin.lon), y = toY(pin.lat);
          var wrapped = toX(pin.lon + 360), wrapped2 = toX(pin.lon - 360);
          var onX = (x > 4 && x < W - 4) || (wrapped > 4 && wrapped < W - 4) ||
                    (wrapped2 > 4 && wrapped2 < W - 4);
          recentre = !(onX && y > 4 && y < H - 4);
        }
        if (recentre) {
          view.clon = pin.lon;
          view.clat = pin.lat;
          clampView();
        }
        draw();
      },
      zoomToPin: function (km) {
        if (!pin) return;
        view.clon = pin.lon;
        view.clat = pin.lat;
        // show roughly six times the fetch footprint
        view.span = clamp((km || 40) / 111 * 6, 1.5, 360);
        clampView();
        draw();
      },
      reset: function () {
        view.clon = 0; view.clat = 20; view.span = 360;
        clampView();
        draw();
      },
      setExtentKm: function (km) { extentKm = km || 0; draw(); },
      redraw: draw,
      dispose: function () {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.removeEventListener('wheel', onWheel);
      }
    };
  }

  return { create: create, decode: decode };
})();
