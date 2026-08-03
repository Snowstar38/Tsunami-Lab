// TS.decode — turn a user's heightmap file into a raw sample grid.
//
// Every decoder returns the same "source" object; the importer decides what the
// numbers MEAN (meters per unit, sea level, bathymetry). Keeping those separate is
// deliberate: a PNG has no vertical datum, while an .asc from a DEM already is
// meters with sea level at 0, and the UI needs to know which it is holding.
//
//   { name, kind, w, h, channels, data: Float32Array(w*h*channels), maxValue,
//     units: 'm' | 'raw', nodata: number|null,
//     georef: null | { mPerPxX, mPerPxY, lat, lon },
//     note: string }
//
// No libraries: PNG is inflated with the browser's own DecompressionStream so
// 16-bit depth survives (canvas would silently crush it to 8).
window.TS = window.TS || {};
TS.decode = (function () {
  'use strict';

  var M_PER_DEG_LAT = 111132.0;
  var M_PER_DEG_LON = 111320.0;

  function ext(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function readAs(file, how) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () { resolve(rd.result); };
      rd.onerror = function () { reject(new Error('could not read the file')); };
      if (how === 'text') rd.readAsText(file); else rd.readAsArrayBuffer(file);
    });
  }

  // ---------------------------------------------------------------- PNG ------

  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function isPng(u8) {
    if (u8.length < 8) return false;
    for (var i = 0; i < 8; i++) if (u8[i] !== PNG_SIG[i]) return false;
    return true;
  }

  function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('no DecompressionStream'));
    }
    var ds = new DecompressionStream('deflate');
    var w = ds.writable.getWriter();
    w.write(u8);
    w.close();
    return new Response(ds.readable).arrayBuffer();
  }

  function pngChunks(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var p = 8, out = { idat: [], idatLen: 0 };
    while (p + 8 <= u8.length) {
      var len = dv.getUint32(p, false);
      var type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      var body = u8.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        out.ihdr = {
          w: dv.getUint32(p + 8, false), h: dv.getUint32(p + 12, false),
          depth: u8[p + 16], color: u8[p + 17],
          compression: u8[p + 18], filter: u8[p + 19], interlace: u8[p + 20]
        };
      } else if (type === 'PLTE') {
        out.plte = body;
      } else if (type === 'IDAT') {
        out.idat.push(body);
        out.idatLen += len;
      } else if (type === 'IEND') {
        break;
      }
      p += 12 + len;   // len + type + data + crc
    }
    return out;
  }

  function paeth(a, b, c) {
    var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  }

  function unfilter(raw, w, h, bpp, stride) {
    var out = new Uint8Array(h * stride);
    var pos = 0;
    for (var y = 0; y < h; y++) {
      var ft = raw[pos++];
      var cur = y * stride, prev = cur - stride;
      for (var x = 0; x < stride; x++) {
        var v = raw[pos + x];
        var a = x >= bpp ? out[cur + x - bpp] : 0;
        var b = y > 0 ? out[prev + x] : 0;
        var c = (x >= bpp && y > 0) ? out[prev + x - bpp] : 0;
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) v += paeth(a, b, c);
        out[cur + x] = v & 0xff;
      }
      pos += stride;
    }
    return out;
  }

  var PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  function decodePng(buf, name) {
    var u8 = new Uint8Array(buf);
    var ch = pngChunks(u8);
    var ih = ch.ihdr;
    if (!ih) throw new Error('PNG has no header chunk');
    if (ih.interlace) throw new Error('interlaced PNG');   // caller falls back to canvas
    if (ih.compression !== 0) throw new Error('unsupported PNG compression');

    var srcCh = PNG_CHANNELS[ih.color];
    if (!srcCh) throw new Error('unsupported PNG colour type');
    if (ih.color === 3 && !ch.plte) throw new Error('paletted PNG without a palette');

    var idat = new Uint8Array(ch.idatLen), off = 0;
    ch.idat.forEach(function (b) { idat.set(b, off); off += b.length; });

    return inflate(idat).then(function (ab) {
      var raw = new Uint8Array(ab);
      var w = ih.w, h = ih.h, depth = ih.depth;
      var bpp = Math.max(1, Math.ceil(depth * srcCh / 8));
      var stride = Math.ceil(depth * srcCh * w / 8);
      if (raw.length < h * (stride + 1)) throw new Error('PNG data is truncated');
      var px = unfilter(raw, w, h, bpp, stride);

      // Keep colour so Terrain-RGB / Terrarium encodings stay decodable; collapse
      // greyscale (with or without alpha) to a single channel.
      var outCh = (ih.color === 2 || ih.color === 6 || ih.color === 3) ? 3 : 1;
      var data = new Float32Array(w * h * outCh);
      var maxValue = depth === 16 ? 65535 : (1 << depth) - 1;
      var i, j, k, s;

      if (depth === 16) {
        for (j = 0; j < h; j++) {
          for (i = 0; i < w; i++) {
            s = j * stride + i * srcCh * 2;
            k = (j * w + i) * outCh;
            for (var c = 0; c < outCh; c++) {
              data[k + c] = (px[s + c * 2] << 8) | px[s + c * 2 + 1];
            }
          }
        }
      } else if (depth === 8) {
        for (j = 0; j < h; j++) {
          for (i = 0; i < w; i++) {
            s = j * stride + i * srcCh;
            k = (j * w + i) * outCh;
            if (ih.color === 3) {
              var pi = px[s] * 3;
              data[k] = ch.plte[pi]; data[k + 1] = ch.plte[pi + 1]; data[k + 2] = ch.plte[pi + 2];
              maxValue = 255;
            } else {
              for (var c8 = 0; c8 < outCh; c8++) data[k + c8] = px[s + c8];
            }
          }
        }
      } else {
        // 1/2/4-bit: greyscale or palette, packed big-endian within each byte.
        var per = 8 / depth, mask = (1 << depth) - 1;
        for (j = 0; j < h; j++) {
          for (i = 0; i < w; i++) {
            var byte = px[j * stride + ((i / per) | 0)];
            var shift = 8 - depth * ((i % per) + 1);
            var v = (byte >> shift) & mask;
            k = (j * w + i) * outCh;
            if (ih.color === 3) {
              var pi3 = v * 3;
              data[k] = ch.plte[pi3]; data[k + 1] = ch.plte[pi3 + 1]; data[k + 2] = ch.plte[pi3 + 2];
              maxValue = 255;
            } else {
              data[k] = v;
            }
          }
        }
      }

      return {
        name: name, kind: 'png', w: w, h: h, channels: outCh, data: data,
        maxValue: maxValue, units: 'raw', nodata: null, georef: null,
        note: depth + '-bit PNG, ' + w + '×' + h +
          (depth === 16 ? ' (full 16-bit precision preserved)' : '')
      };
    });
  }

  // Canvas fallback: JPEG, WebP, interlaced or otherwise awkward PNGs. Always 8-bit.
  function decodeViaCanvas(file, name, why) {
    return createImageBitmap(file).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      var id = cx.getImageData(0, 0, w, h).data;
      var data = new Float32Array(w * h * 3);
      for (var p = 0, q = 0; p < w * h; p++, q += 3) {
        data[q] = id[p * 4]; data[q + 1] = id[p * 4 + 1]; data[q + 2] = id[p * 4 + 2];
      }
      return {
        name: name, kind: 'image', w: w, h: h, channels: 3, data: data,
        maxValue: 255, units: 'raw', nodata: null, georef: null,
        note: (why || 'image') + ', ' + w + '×' + h + ' — 8-bit only (256 height steps)'
      };
    });
  }

  // ------------------------------------------------------- ESRI ASCII grid ---

  // Hand-rolled scanner: a 4000² grid is 16 M tokens, and split(/\s+/) on that
  // allocates a 16 M-entry string array before we touch a single number.
  function scanNumbers(text, from, count) {
    var out = new Float32Array(count);
    var n = text.length, i = from, got = 0;
    while (i < n && got < count) {
      var c = text.charCodeAt(i);
      if (c <= 32) { i++; continue; }
      var start = i;
      while (i < n && text.charCodeAt(i) > 32) i++;
      var v = +text.slice(start, i);
      out[got++] = v === v ? v : 0;   // NaN token -> 0
    }
    if (got < count) throw new Error('grid ended early (' + got + ' of ' + count + ' values)');
    return out;
  }

  var ASC_KEYS = ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter',
    'yllcenter', 'cellsize', 'dx', 'dy', 'nodata_value'];

  function decodeAsc(text, name, kind) {
    var hdr = {}, pos = 0, n = text.length;
    for (var guard = 0; guard < 32; guard++) {
      while (pos < n && text.charCodeAt(pos) <= 32) pos++;
      var wordEnd = pos;
      while (wordEnd < n && text.charCodeAt(wordEnd) > 32) wordEnd++;
      var key = text.slice(pos, wordEnd).toLowerCase();
      if (ASC_KEYS.indexOf(key) < 0) break;
      var vs = wordEnd;
      while (vs < n && text.charCodeAt(vs) <= 32) vs++;
      var ve = vs;
      while (ve < n && text.charCodeAt(ve) > 32) ve++;
      hdr[key] = parseFloat(text.slice(vs, ve));
      pos = ve;
    }
    var w = hdr.ncols | 0, h = hdr.nrows | 0;
    if (!(w > 0 && h > 0)) throw new Error('not an ESRI ASCII grid (no ncols/nrows)');
    var data = scanNumbers(text, pos, w * h);   // row 0 = north

    var cellX = hdr.cellsize != null ? hdr.cellsize : hdr.dx;
    var cellY = hdr.cellsize != null ? hdr.cellsize : hdr.dy;
    var yll = hdr.yllcorner != null ? hdr.yllcorner : hdr.yllcenter;
    var xll = hdr.xllcorner != null ? hdr.xllcorner : hdr.xllcenter;
    var georef = null, lat = null;
    if (cellX) {
      // Degrees or meters? A cell under ~0.05 with a plausible latitude origin is
      // degrees — the giveaway that separates a geographic grid from a UTM one.
      var geographic = cellX < 0.05 && yll != null && Math.abs(yll) <= 90;
      if (geographic) {
        lat = yll + cellY * h / 2;
        georef = {
          mPerPxX: cellX * M_PER_DEG_LON * Math.cos(lat * Math.PI / 180),
          mPerPxY: cellY * M_PER_DEG_LAT,
          lat: lat, lon: xll != null ? xll + cellX * w / 2 : null
        };
      } else {
        georef = { mPerPxX: cellX, mPerPxY: cellY, lat: null, lon: null };
      }
    }

    var nodata = hdr.nodata_value != null ? hdr.nodata_value : null;
    return {
      name: name, kind: kind || 'asc', w: w, h: h, channels: 1, data: data,
      maxValue: 0, units: 'm', nodata: nodata, georef: georef,
      note: 'ESRI ASCII grid, ' + w + '×' + h +
        (georef ? ' — georeferenced, ' + georef.mPerPxX.toFixed(0) + ' m/cell' : '') +
        ' — already in meters'
    };
  }

  // --------------------------------------------------------- SRTM .hgt ------

  function decodeHgt(buf, name) {
    var n = Math.round(Math.sqrt(buf.byteLength / 2));
    if (n * n * 2 !== buf.byteLength) {
      throw new Error('.hgt files must be a square 16-bit grid (this one is ' +
        buf.byteLength + ' bytes)');
    }
    var dv = new DataView(buf);
    var data = new Float32Array(n * n);
    var voids = 0;
    for (var k = 0; k < n * n; k++) {
      var v = dv.getInt16(k * 2, false);          // big-endian, row 0 = north
      if (v === -32768) { v = 0; voids++; }
      data[k] = v;
    }
    // SRTM tiles are named for their SW corner: N41W070.hgt
    var m = /([NS])(\d{2})([EW])(\d{3})/i.exec(name || '');
    var georef = null, lat = null, lon = null;
    if (m) {
      lat = parseFloat(m[2]) * (m[1].toUpperCase() === 'S' ? -1 : 1) + 0.5;
      lon = parseFloat(m[4]) * (m[3].toUpperCase() === 'W' ? -1 : 1) + 0.5;
      var cell = 1 / (n - 1);
      georef = {
        mPerPxX: cell * M_PER_DEG_LON * Math.cos(lat * Math.PI / 180),
        mPerPxY: cell * M_PER_DEG_LAT, lat: lat, lon: lon
      };
    }
    return {
      name: name, kind: 'hgt', w: n, h: n, channels: 1, data: data,
      maxValue: 0, units: 'm', nodata: null, georef: georef,
      note: 'SRTM tile, ' + n + '×' + n + ' — meters' +
        (georef ? ', 1° tile centred ' + lat.toFixed(1) + ', ' + lon.toFixed(1) : '') +
        (voids ? ' — ' + voids + ' void cells set to 0' : '') +
        ' — land only, no seabed'
    };
  }

  // ------------------------------------------------------------ raw grids ---

  function isSquare(v) {
    var r = Math.round(Math.sqrt(v));
    return r * r === v ? r : 0;
  }

  // bits: 16 or 8; endian: 'le'|'be'. Unity/UE .r16 heightmaps are 16-bit LE.
  function decodeRaw(buf, name, opts) {
    opts = opts || {};
    var bits = opts.bits || 0, n = opts.n || 0;
    if (!bits) {
      bits = isSquare(buf.byteLength / 2) ? 16 : (isSquare(buf.byteLength) ? 8 : 0);
      if (!bits) {
        throw new Error('cannot tell the shape of this raw file — ' + buf.byteLength +
          ' bytes is not a square 8- or 16-bit grid');
      }
    }
    if (!n) n = isSquare(bits === 16 ? buf.byteLength / 2 : buf.byteLength);
    if (!n) throw new Error('raw grid is not square at ' + bits + '-bit');

    var data = new Float32Array(n * n);
    if (bits === 16) {
      var dv = new DataView(buf), be = opts.endian === 'be';
      for (var k = 0; k < n * n; k++) data[k] = dv.getUint16(k * 2, !be);
    } else {
      var u8 = new Uint8Array(buf);
      for (var q = 0; q < n * n; q++) data[q] = u8[q];
    }
    return {
      name: name, kind: 'raw', w: n, h: n, channels: 1, data: data,
      maxValue: bits === 16 ? 65535 : 255, units: 'raw', nodata: null, georef: null,
      note: bits + '-bit raw grid, ' + n + '×' + n + ' (inferred from file size)',
      rawBits: bits
    };
  }

  // ------------------------------------------------- an existing .tsu map ---

  function decodeTsu(buf, name) {
    return TS.tsu.read(buf, name).then(function (map) {
      var mpp = map.L / map.N;
      return {
        name: name, kind: 'tsu', w: map.N, h: map.N, channels: 1,
        data: map.data, maxValue: 0, units: 'm', nodata: null,
        georef: { mPerPxX: mpp, mPerPxY: mpp, lat: map.meta.lat, lon: map.meta.lon },
        note: 'existing Tsunami Lab map, ' + map.N + '×' + map.N + ', ' +
          (map.L / 1000).toFixed(1) + ' km — re-crop or re-aim it',
        tsuFlipped: true    // .tsu row 0 is SOUTH; every other source is north-first
      };
    });
  }

  // ------------------------------------------------------------ dispatch ----

  function file(f) {
    var e = ext(f.name);
    if (e === 'asc' || e === 'txt' || e === 'grd') {
      return readAs(f, 'text').then(function (t) { return decodeAsc(t, f.name); });
    }
    return readAs(f).then(function (buf) {
      if (e === 'tsu' || e === 'tsu2') return decodeTsu(buf, f.name);
      if (e === 'hgt') return decodeHgt(buf, f.name);
      if (e === 'raw' || e === 'r16' || e === 'bin') return decodeRaw(buf, f.name);
      if (isPng(new Uint8Array(buf))) {
        return decodePng(buf, f.name)['catch'](function (err) {
          return decodeViaCanvas(f, f.name, 'PNG (' + err.message + ')');
        });
      }
      if (e === 'tif' || e === 'tiff') {
        throw new Error('GeoTIFF support is coming — for now, export it as a 16-bit ' +
          'PNG or an ESRI ASCII grid (.asc)');
      }
      // Last resort: let the browser try to decode it as an image.
      return decodeViaCanvas(f, f.name, e ? e.toUpperCase() + ' image' : 'image');
    });
  }

  return {
    file: file,
    asciiGrid: decodeAsc,
    raw: decodeRaw,
    png: decodePng,
    M_PER_DEG_LAT: M_PER_DEG_LAT,
    M_PER_DEG_LON: M_PER_DEG_LON
  };
})();
