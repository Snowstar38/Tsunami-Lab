// TS.tsu — the .tsu heightmap container: read TSU1 + TSU2, write TSU2.
//
// TSU1 (original, still fully supported):
//   'TSU1' | uint32 N (LE) | float32 L meters (LE) | N*N float32 elevations (LE)
//
// TSU2 (adds provenance + optional compression):
//   'TSU2' | uint32 headerLen (LE) | headerLen bytes UTF-8 JSON | payload
//   header: { N, L, name, source, compression:'none'|'deflate', lat, lon,
//             waveFrom, vertical, created, notes }
//   payload: N*N float32 (LE), zlib-deflated when compression == 'deflate'.
//
// Elevations are meters with sea level = 0 (negative = seabed) and row 0 = the
// edge the tsunami arrives from (the sim's south edge). Reading is async because
// decompression is; writing returns a Blob.
window.TS = window.TS || {};
TS.tsu = (function () {
  'use strict';

  var MAGIC1 = 0x54535531;   // 'TSU1'
  var MAGIC2 = 0x54535532;   // 'TSU2'
  var MAX_N = 16384;

  function canCompress() {
    return typeof CompressionStream !== 'undefined' &&
           typeof DecompressionStream !== 'undefined';
  }

  // Stream helpers. Response(ReadableStream).arrayBuffer() is the shortest path
  // that works in every browser that has the compression streams at all.
  function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('this browser cannot decompress .tsu2 files'));
    }
    var ds = new DecompressionStream('deflate');
    var w = ds.writable.getWriter();
    w.write(u8);
    w.close();
    return new Response(ds.readable).arrayBuffer();
  }

  function deflate(u8) {
    var cs = new CompressionStream('deflate');
    var w = cs.writable.getWriter();
    w.write(u8);
    w.close();
    return new Response(cs.readable).arrayBuffer();
  }

  function checkGrid(data, n) {
    for (var k = 0; k < data.length; k++) {
      if (!isFinite(data[k])) throw new Error('heightmap contains non-finite values');
    }
    if (data.length !== n * n) throw new Error('heightmap payload size mismatch');
    return data;
  }

  // Copy out of the file buffer: a Float32Array view onto a byte offset that
  // isn't 4-aligned throws, and TSU2's header length is arbitrary.
  function floatsFrom(buf, byteOffset, count) {
    if (byteOffset % 4 === 0) return new Float32Array(buf, byteOffset, count);
    var out = new Float32Array(count);
    var dv = new DataView(buf, byteOffset, count * 4);
    for (var k = 0; k < count; k++) out[k] = dv.getFloat32(k * 4, true);
    return out;
  }

  // read(ArrayBuffer, fallbackName) -> Promise<{ name, N, L, data, meta }>
  function read(buf, name) {
    return new Promise(function (resolve) {
      var dv = new DataView(buf);
      if (buf.byteLength < 12) throw new Error('not a .tsu heightmap file');
      var magic = dv.getUint32(0, false);

      if (magic === MAGIC1) {
        var n = dv.getUint32(4, true), len = dv.getFloat32(8, true);
        if (n <= 0 || n > MAX_N) throw new Error('.tsu grid size out of range');
        if (buf.byteLength !== 12 + n * n * 4) throw new Error('.tsu size mismatch');
        resolve({
          name: name, N: n, L: len,
          data: checkGrid(new Float32Array(buf, 12, n * n), n),
          meta: {}
        });
        return;
      }

      if (magic !== MAGIC2) throw new Error('not a .tsu heightmap file');
      var hlen = dv.getUint32(4, true);
      if (hlen > 1 << 20 || 8 + hlen > buf.byteLength) throw new Error('.tsu2 header corrupt');
      var meta;
      try {
        meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
      } catch (e) {
        throw new Error('.tsu2 header is not valid JSON');
      }
      var N = meta.N | 0;
      if (N <= 0 || N > MAX_N) throw new Error('.tsu2 grid size out of range');
      var payload = new Uint8Array(buf, 8 + hlen);

      var got;
      if (meta.compression === 'deflate') {
        got = inflate(payload).then(function (ab) {
          if (ab.byteLength !== N * N * 4) throw new Error('.tsu2 payload size mismatch');
          return new Float32Array(ab);
        });
      } else {
        if (payload.byteLength !== N * N * 4) throw new Error('.tsu2 payload size mismatch');
        got = Promise.resolve(floatsFrom(buf, 8 + hlen, N * N));
      }

      resolve(got.then(function (data) {
        return {
          name: meta.name || name,
          N: N,
          L: meta.L,
          data: checkGrid(data, N),
          meta: meta
        };
      }));
    });
  }

  // write({ N, L, data, name, ...meta }, { compress }) -> Promise<Blob>
  function write(map, opts) {
    opts = opts || {};
    var N = map.N;
    var floats = map.data instanceof Float32Array ? map.data : new Float32Array(map.data);
    if (floats.length !== N * N) return Promise.reject(new Error('grid size mismatch'));
    var raw = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);

    var compress = opts.compress !== false && canCompress();
    var meta = {
      N: N, L: map.L, name: map.name || 'heightmap',
      source: map.source || 'Tsunami Lab heightmap importer',
      compression: compress ? 'deflate' : 'none',
      vertical: 'meters, sea level = 0',
      orientation: 'row 0 = wave-entry (south) edge',
      created: new Date().toISOString().slice(0, 10)
    };
    ['lat', 'lon', 'waveFrom', 'notes', 'widthKm', 'cellSizeM'].forEach(function (k) {
      if (map[k] != null) meta[k] = map[k];
    });

    var body = compress ? deflate(raw) : Promise.resolve(raw.slice().buffer);
    return body.then(function (payload) {
      var hdr = new TextEncoder().encode(JSON.stringify(meta));
      var head = new Uint8Array(8 + hdr.length);
      var dv = new DataView(head.buffer);
      dv.setUint32(0, MAGIC2, false);
      dv.setUint32(4, hdr.length, true);
      head.set(hdr, 8);
      return new Blob([head, payload], { type: 'application/octet-stream' });
    });
  }

  return { read: read, write: write, canCompress: canCompress };
})();
