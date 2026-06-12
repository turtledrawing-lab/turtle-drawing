/* ============================================================================
   ad/dwg.js — DWG import bridge.
   ----------------------------------------------------------------------------
   Loads the GPL-licensed libredwg-web module (vendor/libredwg-web.umd.js +
   vendor/libredwg-web.wasm, ~14 MB combined) ON DEMAND the first time a .dwg
   is opened, parses the drawing into libredwg's typed database, serialises
   the supported subset to a minimal DXF text, and feeds the app's existing
   importDXF pipeline — so layers/colors, unit calibration, recentering and
   block(INSERT) handling are all reused with zero new geometry code.

   The conversion component is deliberately isolated in this file; see
   vendor/libredwg-LICENSE.txt for the converter's GPL-3.0 notice.

   Entity coverage (matches what parseDXF consumes):
     LINE, LWPOLYLINE / POLYLINE2D / POLYLINE3D (incl. bulge arcs, tessellated
     here since parseDXF draws straight segments), CIRCLE, ARC, ELLIPSE,
     POINT, SPLINE (fit/control-point polyline approximation), INSERT (block
     references with scale/rotation). TEXT/MTEXT/DIMENSION/HATCH are skipped —
     same as the DXF importer.
   ============================================================================ */
(function () {
  let _libPromise = null;

  async function _getLib() {
    if (_libPromise) return _libPromise;
    _libPromise = (async () => {
      await window._ensureVendor('vendor/libredwg-web.umd.js');
      const NS = window['libredwg-web'];
      if (!NS || !NS.LibreDwg) throw new Error('libredwg module missing');
      // Electron runs from file:// where the glue's wasm fetch fails — feed
      // the bytes through the vendor-file IPC instead (same as rhino3dm).
      if (window.electronReadVendor && location.protocol === 'file:') {
        const bytes = await window.electronReadVendor('libredwg-web.wasm');
        if (bytes) {
          const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          const mod = await NS.createModule({ wasmBinary: ab });
          if (typeof NS.LibreDwg.createByWasmInstance === 'function') {
            return NS.LibreDwg.createByWasmInstance(mod);
          }
        }
      }
      // Browser (http): glue fetches vendor/libredwg-web.wasm itself.
      return NS.LibreDwg.create('vendor');
    })();
    _libPromise.catch(() => { _libPromise = null; });   // allow retry after failure
    return _libPromise;
  }

  const F = (n) => (isFinite(n) ? String(+(+n).toFixed(8)) : '0');

  /* Tessellate one polyline segment with a bulge (arc) into straight points.
     Math verified: inc = 4·atan(b); center = mid − leftNormal·(chord/2)/tan(inc/2);
     sweep from the start angle by −inc. Positive bulge bows to the LEFT of
     p1→p2 (b=1 over (0,0)→(2,0) passes (1,1)). */
  function _tessBulge(p1, p2, bulge, out) {
    const inc = 4 * Math.atan(bulge);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (!isFinite(inc) || Math.abs(inc) < 1e-6 || chord < 1e-12) { out.push(p2); return; }
    const h = (chord / 2) / Math.tan(inc / 2);
    const nx = -dy / chord, ny = dx / chord;
    const cx = (p1.x + p2.x) / 2 - nx * h;
    const cy = (p1.y + p2.y) / 2 - ny * h;
    const r = Math.hypot(p1.x - cx, p1.y - cy);
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const segs = Math.max(2, Math.min(64, Math.ceil(Math.abs(inc) / (Math.PI / 16))));
    for (let s = 1; s <= segs; s++) {
      const a = a1 - inc * (s / segs);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: p2.z || 0 });
    }
  }

  /* Emit one LWPOLYLINE with bulges pre-tessellated (parseDXF draws straight
     segments only). `closed` controls DXF flag 70 bit 1. */
  function _emitPoly(out, verts, closed, layer, color, elevation) {
    if (!verts || verts.length < 2) return;
    const pts = [{ x: verts[0].x, y: verts[0].y, z: verts[0].z || elevation || 0 }];
    const n = verts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const v = verts[i];
      const w = verts[(i + 1) % n];
      const p1 = { x: v.x, y: v.y, z: v.z || elevation || 0 };
      const p2 = { x: w.x, y: w.y, z: w.z || elevation || 0 };
      if (v.bulge) _tessBulge(p1, p2, v.bulge, pts);
      else pts.push(p2);
    }
    // For closed loops parseDXF re-closes via the flag — drop the duplicated
    // final point if the loop returned exactly to the start.
    if (closed && pts.length > 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) pts.pop();
    }
    out.push('0', 'LWPOLYLINE', '8', layer, '62', color, '70', closed ? '1' : '0');
    for (const p of pts) out.push('10', F(p.x), '20', F(p.y), '30', F(p.z || 0));
  }

  function _emitEntity(out, e) {
    if (!e || !e.type) return 0;
    const layer = e.layer || '0';
    const color = String((e.colorIndex != null ? e.colorIndex : 256) | 0);
    switch (e.type) {
      case 'LINE': {
        const a = e.startPoint || {}, b = e.endPoint || {};
        out.push('0', 'LINE', '8', layer, '62', color,
          '10', F(a.x), '20', F(a.y), '30', F(a.z || 0),
          '11', F(b.x), '21', F(b.y), '31', F(b.z || 0));
        return 1;
      }
      case 'LWPOLYLINE': {
        // libredwg LWPOLYLINE flag: bit 512 = closed (DXF uses 70 bit 1).
        const closed = !!((e.flag | 0) & 512) || !!((e.flag | 0) & 1);
        _emitPoly(out, e.vertices, closed, layer, color, e.elevation || 0);
        return 1;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const closed = !!((e.flag | 0) & 1);
        _emitPoly(out, e.vertices, closed, layer, color, e.elevation || 0);
        return 1;
      }
      case 'CIRCLE': {
        const c = e.center || {};
        out.push('0', 'CIRCLE', '8', layer, '62', color,
          '10', F(c.x), '20', F(c.y), '30', F(c.z || 0), '40', F(e.radius));
        return 1;
      }
      case 'ARC': {
        const c = e.center || {};
        out.push('0', 'ARC', '8', layer, '62', color,
          '10', F(c.x), '20', F(c.y), '30', F(c.z || 0), '40', F(e.radius),
          '50', F((e.startAngle || 0) * 180 / Math.PI),
          '51', F((e.endAngle || 0) * 180 / Math.PI));
        return 1;
      }
      case 'ELLIPSE': {
        const c = e.center || {};
        const ma = e.majorAxisEndPoint || e.majorAxis || { x: 1, y: 0 };
        const ratio = (e.axisRatio != null) ? e.axisRatio : (e.ratio != null ? e.ratio : 1);
        const s1 = e.startAngle || 0;
        const s2 = (e.endAngle != null) ? e.endAngle : Math.PI * 2;
        out.push('0', 'ELLIPSE', '8', layer, '62', color,
          '10', F(c.x), '20', F(c.y), '30', F(c.z || 0),
          '11', F(ma.x), '21', F(ma.y),
          '40', F(ratio), '41', F(s1), '42', F(s2));
        return 1;
      }
      case 'SPLINE': {
        // Straight-segment approximation through fit points (or control
        // points when no fit points are stored).
        const pts = (e.fitPoints && e.fitPoints.length ? e.fitPoints
                  : (e.controlPoints && e.controlPoints.length ? e.controlPoints : null));
        if (pts && pts.length >= 2) {
          _emitPoly(out, pts.map(p => ({ x: p.x, y: p.y, z: p.z || 0 })),
            !!((e.flag | 0) & 1), layer, color, 0);
          return 1;
        }
        return 0;
      }
      case 'POINT': {
        const p = e.position || e.point || {};
        out.push('0', 'POINT', '8', layer, '62', color,
          '10', F(p.x), '20', F(p.y), '30', F(p.z || 0));
        return 1;
      }
      case 'INSERT': {
        if (!e.name) return 0;
        const p = e.insertionPoint || {};
        const s = e.scale || {};
        out.push('0', 'INSERT', '8', layer, '62', color, '2', e.name,
          '10', F(p.x), '20', F(p.y), '30', F(p.z || 0),
          '41', F(s.x != null ? s.x : 1), '42', F(s.y != null ? s.y : 1), '43', F(s.z != null ? s.z : 1),
          '50', F((e.rotation || 0) * 180 / Math.PI));
        return 1;
      }
      default:
        return 0;   // TEXT/MTEXT/DIMENSION/HATCH/… — not consumed by parseDXF
    }
  }

  function _dbToDxf(db) {
    const out = [];
    let count = 0;
    // HEADER: carry the drawing's insertion units through to the DXF unit
    // calibration ($INSUNITS 4 = mm, 1 = inches, 6 = meters …).
    out.push('0', 'SECTION', '2', 'HEADER');
    const hdr = db.header || {};
    const iu = (hdr.INSUNITS != null) ? hdr.INSUNITS : hdr.insunits;
    if (iu != null) out.push('9', '$INSUNITS', '70', String(iu | 0));
    out.push('0', 'ENDSEC');
    // TABLES → layer colors.
    out.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER');
    const layers = (db.tables && db.tables.LAYER && db.tables.LAYER.entries) || [];
    for (const L of layers) {
      if (!L || !L.name) continue;
      out.push('0', 'LAYER', '2', L.name,
        '62', String(((L.colorIndex != null ? L.colorIndex : (L.color != null ? L.color : 7)) | 0)));
    }
    out.push('0', 'ENDTAB', '0', 'ENDSEC');
    // BLOCKS (skip model/paper space records — their entities are already in
    // db.entities, lifted there by the converter).
    out.push('0', 'SECTION', '2', 'BLOCKS');
    const brs = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
    for (const b of brs) {
      const nm = b && b.name;
      if (!nm || /^\*(model|paper)_space/i.test(nm)) continue;
      if (!b.entities || !b.entities.length) continue;
      out.push('0', 'BLOCK', '2', nm);
      for (const e of b.entities) count += _emitEntity(out, e);
      out.push('0', 'ENDBLK');
    }
    out.push('0', 'ENDSEC');
    // ENTITIES (model space).
    out.push('0', 'SECTION', '2', 'ENTITIES');
    for (const e of (db.entities || [])) count += _emitEntity(out, e);
    out.push('0', 'ENDSEC', '0', 'EOF');
    return { text: out.join('\n'), count };
  }

  /* Public entry: ArrayBuffer + filename → parse → DXF text → importDXF. */
  window.importDWG = async function (ab, filename) {
    const loadingEl = document.getElementById('loading');
    try { if (loadingEl) loadingEl.style.display = 'block'; } catch (_) {}
    try {
      try { setStatus('msg', 'Loading DWG converter…'); } catch (_) {}
      const lib = await _getLib();
      const NS = window['libredwg-web'];
      try { setStatus('msg', 'Converting ' + (filename || 'DWG') + '…'); } catch (_) {}
      let dwg = lib.dwg_read_data(ab, NS.Dwg_File_Type.DWG);
      // Some wrapper versions return {error, data}, others the pointer itself.
      if (dwg && typeof dwg === 'object' && 'data' in dwg && 'error' in dwg) {
        dwg = dwg.error ? null : dwg.data;
      }
      if (dwg == null) throw new Error('could not read the DWG (unsupported version or corrupted file)');
      let db;
      try {
        db = lib.convert(dwg);
      } finally {
        try { lib.dwg_free(dwg); } catch (_) {}
      }
      if (!db) throw new Error('DWG database conversion failed');
      const { text, count } = _dbToDxf(db);
      if (!count) throw new Error('no importable entities found (lines/arcs/polylines/blocks)');
      importDXF(text, filename);
    } catch (e) {
      console.error('[dwg]', e);
      try { if (loadingEl) loadingEl.style.display = 'none'; } catch (_) {}
      showError('DWG import failed: ' + ((e && e.message) || e));
      return;
    }
    // importDXF manages the loading overlay from here.
  };
})();
