#!/usr/bin/env python3
"""Turtle Drawing — .skp → .glb conversion server.

The browser cannot read SketchUp .skp files (the SketchUp SDK is a native
Windows/macOS library with no WASM build), so the web app uploads the .skp to
this small HTTP service which converts it to glb and returns the bytes. The web
client then loads the glb through its normal importGLB() path.

  POST /convert      body = raw .skp bytes (application/octet-stream)
                     header X-Filename: original name (optional)
                     -> 200 model/gltf-binary  (the .glb bytes)
  GET  /health       -> 200 {"ok":true,"stub":<bool>}

Run (real, on WINDOWS — needs the RedHalo binding next to convert.py):
    py -3.11 server.py --port 8787
Run (stub, any OS — returns a unit cube, for wiring/UX tests):
    python3 server.py --stub --port 8787

CORS is open by default for local dev; pass --origin https://tdw.kr to lock it
down in production.
"""
import argparse
import json
import os
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None

# Public-exposure hardening: cap the upload size and SERIALIZE conversions — the
# SketchUp binding holds process-global state and is not safe to run concurrently,
# so one model converts at a time (extra requests queue on the lock).
MAX_UPLOAD = int(os.environ.get("TD_SKP_MAX_UPLOAD") or (400 * 1024 * 1024))   # 400 MB
_CONVERT_LOCK = threading.Lock()


def cube_glb():
    """A minimal valid binary-glTF unit cube (POSITION + indices). Used by
    --stub so the whole upload→convert→render path can be exercised without the
    SketchUp SDK present."""
    s = 0.5
    pos = [
        -s, -s, -s,  s, -s, -s,  s,  s, -s, -s,  s, -s,
        -s, -s,  s,  s, -s,  s,  s,  s,  s, -s,  s,  s,
    ]
    idx = [
        0, 1, 2, 0, 2, 3,  4, 6, 5, 4, 7, 6,
        0, 4, 5, 0, 5, 1,  1, 5, 6, 1, 6, 2,
        2, 6, 7, 2, 7, 3,  3, 7, 4, 3, 4, 0,
    ]
    pos_b = struct.pack("<%df" % len(pos), *pos)
    idx_b = struct.pack("<%dH" % len(idx), *idx)
    while len(idx_b) % 4:
        idx_b += b"\x00"
    bin_chunk = pos_b + idx_b
    gltf = {
        "asset": {"version": "2.0", "generator": "td-skp-stub"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_b), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_b), "byteLength": len(idx_b), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3",
             "min": [-s, -s, -s], "max": [s, s, s]},
            {"bufferView": 1, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ],
    }
    json_b = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(json_b) % 4:
        json_b += b" "
    glb = bytearray()
    total = 12 + 8 + len(json_b) + 8 + len(bin_chunk)
    glb += struct.pack("<III", 0x46546C67, 2, total)          # "glTF", v2, length
    glb += struct.pack("<II", len(json_b), 0x4E4F534A) + json_b   # JSON chunk
    glb += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk  # BIN chunk
    return bytes(glb)


def convert_skp(skp_bytes, filename):
    """Real conversion — defers to convert.py (which needs the RedHalo binding).
    Raises RuntimeError if the binding/converter isn't available."""
    import tempfile, os
    from convert import convert  # local module; only importable where the binding exists
    with tempfile.TemporaryDirectory() as d:
        skp_path = os.path.join(d, filename or "model.skp")
        glb_path = os.path.join(d, "out.glb")
        with open(skp_path, "wb") as f:
            f.write(skp_bytes)
        convert(skp_path, glb_path)
        with open(glb_path, "rb") as f:
            return f.read()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ARGS.origin)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            body = json.dumps({"ok": True, "stub": bool(ARGS.stub)}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path.split("?")[0] != "/convert":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_UPLOAD:
                raise ValueError("upload too large or empty (%d bytes; max %d)" % (n, MAX_UPLOAD))
            skp = self.rfile.read(n)
            name = self.headers.get("X-Filename", "model.skp")
            if ARGS.stub:
                glb = cube_glb()
            else:
                # One conversion at a time — the binding isn't concurrency-safe.
                with _CONVERT_LOCK:
                    glb = convert_skp(skp, name)
        except Exception as e:  # noqa: BLE001 — report any converter failure to the client
            msg = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "model/gltf-binary")
        self.send_header("Content-Length", str(len(glb)))
        self.end_headers()
        self.wfile.write(glb)

    def log_message(self, fmt, *a):
        sys.stderr.write("[skp-server] " + (fmt % a) + "\n")


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--origin", default="*", help="CORS allowed origin (e.g. https://tdw.kr)")
    ap.add_argument("--stub", action="store_true", help="return a unit cube instead of converting")
    ARGS = ap.parse_args()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    mode = "STUB (unit cube)" if ARGS.stub else "REAL (convert.py)"
    sys.stderr.write("[skp-server] %s on http://%s:%d  origin=%s\n" % (mode, ARGS.host, ARGS.port, ARGS.origin))
    srv.serve_forever()


if __name__ == "__main__":
    main()
