# Turtle Drawing — `.skp` conversion server

The browser **cannot** read SketchUp `.skp` files: the SketchUp SDK is a native
**Windows/macOS** library with **no Linux build and no WASM**. So the web app
(tdw.kr) uploads the `.skp` to this small service, which converts it to **glb**
and returns the bytes; the web client then loads it via its normal `importGLB()`.

```
Browser (.skp)  ──POST /convert──▶  this server (Windows)  ──▶  .glb  ──▶  importGLB()
```

## Why Windows
The only currently-working `.skp` reader is the **RedHalo / pyslapi** binding
(<https://github.com/RedHaloStudio/Sketchup_Importer>), and its prebuilt binaries
are **Windows-only** (`sketchup.cp3xx-win_amd64.pyd` + `SketchUpAPI.dll`). The
official macOS SDK download is currently down. So run this on a Windows host
(a small cloud VM or a Windows PC).

## Setup (macOS) — the working path here
This repo ships a **macOS** binding in `runtime-macos/` (`sketchup.so` +
`SketchUpAPI.framework`, **proprietary + gitignored**). On this Mac the server
runs directly against it — no Windows host needed:

```
npm run skp:serve            # → http://localhost:8787  (REAL convert.py)
# or: bash tools/skp-server/serve-macos.sh --port 8787 --origin '*'
```

Python must match the binding (here **python@3.10**); override with
`TD_SKP_PYTHON=/path/to/python3.x`. Smoke-test the converter alone:
`PYTHONPATH=runtime-macos python3.10 runtime-macos/convert.py model.skp out.glb`.

Using it from the web app:
- **http://localhost…** — the `.skp` menu auto-enables and defaults the endpoint
  to `http://localhost:8787/convert`.
- **https://tdw.kr** — visit once as `tdw.kr/?skp=http://localhost:8787/convert`
  to enable the menu + set the endpoint. Chrome treats `http://localhost` as a
  secure origin, so the https→localhost upload is allowed (**use Chrome**; Safari
  blocks it). The `.skp` is uploaded to *your own* machine, not a third party.

The server emits **instanced** glb (one mesh per repeated component + N nodes), so
the web import preserves full SketchUp depth — same as the desktop offline path.

## ⚠️ Licensing
`SketchUpAPI.dll` and the `sketchup` binding are **Trimble proprietary** (SketchUp
SDK EULA) — they are **NOT** committed to this repo (see `.gitignore`). You, as a
registered SketchUp developer, place them on the Windows host yourself. Confirm the
SDK EULA's redistribution terms before exposing this publicly.

## Setup (Windows)
1. Install **Python 3.11** (must match a bundled `sketchup.cp311-win_amd64.pyd`).
2. `py -3.11 -m pip install -r requirements.txt`
3. Download the RedHalo release zip and copy its `sketchup_importer/` contents
   **next to `convert.py`** so this folder has:
   `convert.py  server.py  sketchup.cp311-win_amd64.pyd  SketchUpAPI.dll  SketchUpCommonPreferences.dll  SKPutil/`
4. Smoke-test the converter on one model:
   `py -3.11 convert.py "C:\path\model.skp" out.glb`  → open `out.glb` to check.
5. Run the server: `py -3.11 server.py --port 8787 --origin https://tdw.kr`
6. Expose it over **HTTPS** (tdw.kr is https → an http endpoint is blocked as
   mixed content). Put it behind a reverse proxy / tunnel with a TLS cert.

## Point the web app at it
In Turtle Drawing (web), the first `.skp` import prompts for the server URL, or set
it directly:
```js
localStorage.setItem('td_skp_endpoint', 'https://YOUR-SERVER/convert')
```
(On `localhost` it defaults to `http://localhost:8787/convert`.)

## Endpoint contract
- `POST /convert` — body = raw `.skp` bytes (`application/octet-stream`),
  optional header `X-Filename`. → `200 model/gltf-binary` (the `.glb`), or
  `500 {"error": "..."}`.
- `GET /health` → `{"ok":true,"stub":<bool>}`.
- `OPTIONS` preflight handled; CORS origin set by `--origin` (default `*`).

## Calibration (do once on Windows)
SketchUp uses inches + Z-up; glTF uses metres + Y-up. `convert.py` has three knobs
at the top — if the first import looks scaled/rotated/mirrored wrong, adjust:
`UNIT_SCALE` (0.0254), `Z_UP_TO_Y_UP` (True), `TRANSPOSE_XFORM` (False).

## Stub mode (any OS, no SDK) — used to develop the web flow
`python3 server.py --stub` returns a unit cube for every request, so the
upload→convert→render path can be tested without the SDK (e.g. on a Mac).
