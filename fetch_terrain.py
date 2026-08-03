#!/usr/bin/env python3
"""Fetch real-world merged topo-bathy terrain for Tsunami Lab.

Downloads from GMRT GridServer (no API key), corrects the lat/lon aspect to true
meters, bilinearly resamples to a square N x N grid, and writes a .tsu binary that
the sim's "Load heightmap" button understands.

Usage:
  python fetch_terrain.py --lat 41.75 --lon -70.10 --width-km 68 --n 1024 \
      --out capecod.tsu [--max-depth 200] [--name "Cape Cod"]

.tsu format (little-endian): magic b'TSU1', uint32 N, float32 L_meters,
then N*N float32 elevations (meters, sea level = 0), row 0 = SOUTH edge.
Pure stdlib. GMRT max resolution is ~100 m/node; the sim happily upsamples.
"""
import argparse, math, struct, sys, urllib.request

def fetch_esriascii(south, north, west, east, mres=100):
    url = ("https://www.gmrt.org/services/GridServer?"
           f"minlatitude={south:.5f}&maxlatitude={north:.5f}"
           f"&minlongitude={west:.5f}&maxlongitude={east:.5f}"
           "&layer=topo&format=esriascii&mresolution=" + str(mres))
    print("fetching:", url)
    req = urllib.request.Request(url, headers={"User-Agent": "tsunami-lab/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        text = r.read().decode("ascii", "replace")
    if not text.lstrip().lower().startswith("ncols"):
        sys.exit("Unexpected response (not ESRI ASCII):\n" + text[:400])
    return text

def parse_esriascii(text):
    """Returns (grid rows top-to-bottom as list of float lists, header dict)."""
    lines = text.strip().split("\n")
    hdr, i = {}, 0
    while i < len(lines):
        parts = lines[i].split()
        if len(parts) == 2 and parts[0].lower() in (
                "ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "nodata_value"):
            hdr[parts[0].lower()] = float(parts[1]); i += 1
        else:
            break
    ncols, nrows = int(hdr["ncols"]), int(hdr["nrows"])
    nodata = hdr.get("nodata_value")
    vals = []
    for line in lines[i:]:
        vals.extend(float(v) for v in line.split())
    if len(vals) != ncols * nrows:
        sys.exit(f"Grid size mismatch: header {ncols}x{nrows}, got {len(vals)} values")
    if nodata is not None:
        vals = [0.0 if v == nodata else v for v in vals]   # rare in GMRT topo layer
    rows = [vals[r * ncols:(r + 1) * ncols] for r in range(nrows)]  # row 0 = NORTH
    return rows, ncols, nrows

def bilinear(rows, ncols, nrows, x, y):
    """Sample grid at fractional (x right, y down), clamped."""
    x = min(max(x, 0.0), ncols - 1.0); y = min(max(y, 0.0), nrows - 1.0)
    x0, y0 = int(x), int(y)
    x1, y1 = min(x0 + 1, ncols - 1), min(y0 + 1, nrows - 1)
    fx, fy = x - x0, y - y0
    a = rows[y0][x0] * (1 - fx) + rows[y0][x1] * fx
    b = rows[y1][x0] * (1 - fx) + rows[y1][x1] * fx
    return a * (1 - fy) + b * fy

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True, help="center latitude")
    ap.add_argument("--lon", type=float, required=True, help="center longitude")
    ap.add_argument("--width-km", type=float, required=True, help="square domain width")
    ap.add_argument("--n", type=int, default=1024, help="output grid size (sim resamples anyway)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-depth", type=float, default=None,
                    help="clamp depths (m, positive); deep water shrinks the sim timestep")
    ap.add_argument("--wave-from", choices="SEWN", default="S",
                    help="compass side the tsunami should arrive from; the grid is "
                         "rotated so that side becomes the sim's south edge")
    ap.add_argument("--rotate", type=float, default=0.0,
                    help="extra counter-clockwise on-screen rotation in degrees, "
                         "on top of --wave-from (e.g. 10 to tilt the coastline "
                         "relative to the incoming wavefront)")
    args = ap.parse_args()

    L = args.width_km * 1000.0
    # Total rotation of the sampling square relative to the compass grid.
    base = {"S": 0.0, "E": 90.0, "W": -90.0, "N": 180.0}[args.wave_from]
    phi = math.radians(base - args.rotate)
    # A rotated square of side L needs a bounding box of side L*(|cos|+|sin|).
    Lf = L * (abs(math.cos(phi)) + abs(math.sin(phi)))
    m_per_deg_lat = 111132.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(args.lat))
    dlat = Lf / 2 / m_per_deg_lat
    dlon = Lf / 2 / m_per_deg_lon
    rows, ncols, nrows = parse_esriascii(fetch_esriascii(
        args.lat - dlat, args.lat + dlat, args.lon - dlon, args.lon + dlon))
    print(f"source grid: {ncols} x {nrows}")

    # Resample to square N x N in true meters. Output row 0 is the side the wave
    # arrives from (sim convention: wave enters at the bottom edge). Output coords
    # rotate by phi into the compass frame of the (larger) fetched box.
    N = args.n
    cph, sph = math.cos(phi), math.sin(phi)
    out = bytearray()
    out += b"TSU1" + struct.pack("<If", N, L)
    lo, hi = 1e9, -1e9
    for j in range(N):                       # j = 0 -> wave-facing edge
        pb = (j + 0.5) / N - 0.5
        row = []
        for i in range(N):
            pa = (i + 0.5) / N - 0.5
            east = (cph * pa - sph * pb) * L / Lf + 0.5    # frac of fetched box
            north = (sph * pa + cph * pb) * L / Lf + 0.5
            sx = east * ncols - 0.5
            sy = (1.0 - north) * nrows - 0.5   # source rows are north-first
            v = bilinear(rows, ncols, nrows, sx, sy)
            if args.max_depth is not None and v < -args.max_depth:
                v = -args.max_depth
            row.append(v)
            if v < lo: lo = v
            if v > hi: hi = v
        out += struct.pack(f"<{N}f", *row)
    with open(args.out, "wb") as f:
        f.write(out)
    print(f"wrote {args.out}: {N}x{N}, {L/1000:.1f} km, "
          f"elev {lo:.1f}..{hi:.1f} m, {len(out)/1e6:.1f} MB")

if __name__ == "__main__":
    main()
