/* =============================================================================
   AD.Facade — parametric facade generator (P0: louver + curtain wall).
   Schema-in, geometry-out: docs/FACADE.md defines the JSON schema; this module
   turns a schema + a picked planar face region into component instances
   grouped under one named group. The same generate(schema, pick) entry point
   is the landing pad for the P1 image→schema (AI vision) stage.
   All schema lengths are mm; the scene is meters (turtle_drawing.html:9128).
   ============================================================================= */
(function () {
  const AD = window.AD || (window.AD = {});
  const MM = 0.001;                 // mm → scene meters
  const MAX_OBJECTS = 4000;         // hard cap per generation
  const EPS_PLANE = 0.005, EPS_NORMAL = 0.9995;   // same as _mergeCoplanarFacesEM

  // Schema values may come from an AI or hand-written JSON: never trust them.
  // fin() = any finite number, pos() = strictly positive; both accept "40mm".
  function fin(x, dflt) {
    const n = typeof x === 'string' ? parseFloat(x) : +x;
    return Number.isFinite(n) ? n : dflt;
  }
  function pos(x, dflt) {
    const n = fin(x, NaN);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  }

  /* ---------------------------------------------------------------------------
     Face picking: seed face → coplanar region → world verts + (u,v,n) basis.
     Reads geometry only, so grouped objects and component-instance faces are
     legitimate targets (verts/normal go through mesh.matrixWorld like
     WallLayer._faceWorldVerts).
  --------------------------------------------------------------------------- */
  function faceBasis(normal) {
    const n = normal.clone().normalize();
    let v;
    if (Math.abs(n.y) < 0.99) {
      v = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);      // world up projected onto plane
    } else {
      v = new THREE.Vector3(0, 0, n.y > 0 ? -1 : 1);                // horizontal face: pick a stable in-plane "up"
      v.addScaledVector(n, -v.dot(n));
    }
    v.normalize();
    const u = new THREE.Vector3().crossVectors(v, n).normalize();   // u×v = n (right-handed, det +1)
    return { u, v, n };
  }

  // Expand a seed face to its edge-connected coplanar region (needed for
  // triangulated imports; native n-gon faces usually return just the seed).
  // Plane-prefilter first so the edge map is built over the coplanar subset
  // only — a whole-mesh map stalled clicks on large imports.
  function coplanarRegion(em, seedIdx) {
    const seed = em.faces[seedIdx];
    em.computeFaceNormal(seed);
    const n = seed.normal, d0 = -n.dot(em.vertices[seed.verts[0]]);
    const coset = [];
    em.faces.forEach((f, i) => {
      if (f.hidden) return;
      if (i !== seedIdx) {
        em.computeFaceNormal(f);
        if (f.normal.dot(n) < EPS_NORMAL) return;
        if (Math.abs(-f.normal.dot(em.vertices[f.verts[0]]) - d0) > EPS_PLANE) return;
      }
      coset.push(i);
    });
    if (coset.length <= 1) return new Set([seedIdx]);
    const ekey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
    const edgeFaces = new Map();
    for (const i of coset) {
      const f = em.faces[i];
      for (let j = 0; j < f.verts.length; j++) {
        const k = ekey(f.verts[j], f.verts[(j + 1) % f.verts.length]);
        let arr = edgeFaces.get(k);
        if (!arr) edgeFaces.set(k, arr = []);
        arr.push(i);
      }
    }
    const region = new Set([seedIdx]), stack = [seedIdx];
    while (stack.length) {
      const f = em.faces[stack.pop()];
      for (let j = 0; j < f.verts.length; j++) {
        const neigh = edgeFaces.get(ekey(f.verts[j], f.verts[(j + 1) % f.verts.length]));
        if (!neigh) continue;
        for (const ni of neigh) if (!region.has(ni)) { region.add(ni); stack.push(ni); }
      }
    }
    return region;
  }

  // Build the full pick record from an object + seed face index.
  function pickFromFace(obj, fi) {
    const em = obj.em, seed = em.faces[fi];
    if (!seed) return null;
    const region = coplanarRegion(em, fi);
    obj.group.updateMatrixWorld(true);
    const M = obj.mesh.matrixWorld;
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const vidx = new Set();
    for (const i of region) {
      const f = em.faces[i];
      f.verts.forEach(vi => vidx.add(vi));
      (f.holes || []).forEach(loop => loop.forEach(vi => vidx.add(vi)));
    }
    const worldVerts = [...vidx].map(vi => em.vertices[vi].clone().applyMatrix4(M));
    em.computeFaceNormal(seed);
    const normal = seed.normal.clone().applyMatrix3(nm).normalize();
    const basis = faceBasis(normal);
    const O = worldVerts[0];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of worldVerts) {
      const du = p.clone().sub(O).dot(basis.u), dv = p.clone().sub(O).dot(basis.v);
      if (du < u0) u0 = du; if (du > u1) u1 = du;
      if (dv < v0) v0 = dv; if (dv > v1) v1 = dv;
    }
    return { object: obj, faceIndices: [...region], normal: basis.n,
             basis, origin: O, uv: { u0, u1, v0, v1 } };
  }

  function pickAtPointer(e) {
    const hits = raycastObjects(e, { frontFaceOnly: true });
    for (const hit of hits) {
      const obj = hit.object.userData && hit.object.userData.sketchObject;
      if (!obj) continue;
      // Billboards/underlays reorient or don't persist as real geometry —
      // pass through them to whatever solid face lies behind.
      if (obj.isImagePlane || obj.isEntourage || obj.isUnderlay || obj.faceCamera) continue;
      const map = hit.object.geometry.userData && hit.object.geometry.userData.faceIdxMap;
      if (!map) continue;
      const fi = map[hit.faceIndex];
      if (fi == null || fi < 0 || !obj.em.faces[fi]) continue;
      return { obj, fi };
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
     Profile library — 2D polygons in (s, t): s = in-plane transverse (width w
     centered on 0), t = depth along the face normal (0 … d, outward).
     All in meters. Returned CCW (positive signed area).
  --------------------------------------------------------------------------- */
  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }

  function profilePoints(profile, rotationDeg) {
    const w = Math.max(pos(profile && profile.w, 40), 1) * MM;
    const d = Math.max(pos(profile && profile.d, 150), 1) * MM;
    const shape = (profile && profile.shape) || 'rect';
    let pts;
    if (shape === 'ellipse') {
      pts = [];
      const N = 16;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pts.push([Math.cos(a) * w / 2, d / 2 + Math.sin(a) * d / 2]);
      }
    } else if (shape === 'L') {
      const th = Math.min(w, d * 0.5);               // flange thickness, kept inside t ∈ [0..d]
      const fl = Math.min(d * 0.35, w * 3);          // flange length
      pts = [[-w / 2, 0], [w / 2 + fl, 0], [w / 2 + fl, th], [w / 2, th], [w / 2, d], [-w / 2, d]];
    } else if (shape === 'Z') {
      const th = Math.min(w, d * 0.5);
      const fl = Math.min(d * 0.3, w * 3);
      pts = [[-w / 2 - fl, 0], [w / 2, 0], [w / 2, d - th], [w / 2 + fl, d - th],
             [w / 2 + fl, d], [-w / 2, d], [-w / 2, th], [-w / 2 - fl, th]];
    } else if (shape === 'airfoil') {
      // NACA 00xx half-thickness, chord along t (leading edge outward at t=d).
      const half = x => w * 5 * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x
                                 + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
      const xs = [];
      const N = 10;
      for (let i = 0; i <= N; i++) xs.push(0.5 * (1 - Math.cos(Math.PI * i / N)));  // cosine spacing
      const top = xs.map(x => [half(x), d - x * d]);
      const bot = xs.slice(1, -1).reverse().map(x => [-half(x), d - x * d]);
      pts = top.concat(bot);
    } else {                                         // rect
      pts = [[-w / 2, 0], [w / 2, 0], [w / 2, d], [-w / 2, d]];
    }
    if (signedArea(pts) < 0) pts.reverse();
    // Optional rotation about the profile's bbox centre (louver blade angle).
    const rot = fin(rotationDeg, 0) * Math.PI / 180;
    if (rot) {
      let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
      for (const [s, t] of pts) { s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
      const cs = (s0 + s1) / 2, ct = (t0 + t1) / 2;
      const cosr = Math.cos(rot), sinr = Math.sin(rot);
      pts = pts.map(([s, t]) => {
        const ds = s - cs, dt = t - ct;
        return [cs + ds * cosr - dt * sinr, ct + ds * sinr + dt * cosr];
      });
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------
     Prism builder: extrude a 2D profile along an axis into a def-LOCAL
     EditableMesh. sVec/tVec/axisVec are unit def-space axes; profile CCW in
     (s,t). Winding is corrected so face normals point outward regardless of
     the triad's handedness.
  --------------------------------------------------------------------------- */
  function prismEM(profile, sVec, tVec, axisVec, length, color, layerId) {
    let pts = profile;
    const rightHanded = new THREE.Vector3().crossVectors(sVec, tVec).dot(axisVec) > 0;
    if (!rightHanded) pts = pts.slice().reverse();
    const em = new EditableMesh();
    const n = pts.length;
    for (const [s, t] of pts)
      em.vertices.push(new THREE.Vector3().addScaledVector(sVec, s).addScaledVector(tVec, t));
    for (const [s, t] of pts)
      em.vertices.push(new THREE.Vector3().addScaledVector(sVec, s).addScaledVector(tVec, t)
                       .addScaledVector(axisVec, length));
    const base = [];
    for (let i = n - 1; i >= 0; i--) base.push(i);
    em.addFace(base, color, layerId);                                  // −axis cap
    em.addFace(Array.from({ length: n }, (_, i) => i + n), color, layerId);  // +axis cap
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      em.addFace([i, j, j + n, i + n], color, layerId);                // outward side walls
    }
    return em;
  }

  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);

  /* ---------------------------------------------------------------------------
     Generation context: collects created objects and defs, stamps instances
     with the shared def→world basis matrix, wires groups, enforces the cap.
  --------------------------------------------------------------------------- */
  const defKey = em => em.vertices.length + '|' + em.faces.length + '|'
    + em.vertices.map(v => Math.round(v.x * 1e4) + ',' + Math.round(v.y * 1e4) + ',' + Math.round(v.z * 1e4)).join(';');

  function makeCtx(pick, rootName) {
    const { u, v, n } = pick.basis;
    const baseMatrix = new THREE.Matrix4().makeBasis(u, v, n);        // defX→u defY→v defZ→n, det +1
    const layerId = Model.activeLayerId;
    const rootGid = _newGroupId();
    registerGroup(rootGid, Model.activeGroupId || null, rootName);
    return {
      pick, layerId, rootGid, created: [], newDefs: [],
      subGroup(name) { const g = _newGroupId(); registerGroup(g, rootGid, name); return g; },
      worldPos(uu, vv, depth) {
        return pick.origin.clone().addScaledVector(u, uu).addScaledVector(v, vv).addScaledVector(n, depth);
      },
      stamp(def, uu, vv, depth, name, gid) {
        if (this.created.length >= MAX_OBJECTS) throw new Error('facade: object cap (' + MAX_OBJECTS + ') exceeded');
        const m = baseMatrix.clone().setPosition(this.worldPos(uu, vv, depth));
        const inst = createComponentInstance(def, m);
        if (!inst) throw new Error('facade: instance creation failed');
        inst.name = name;
        inst.layerId = this.layerId;          // addObject overwrote it with the active layer anyway; explicit for clarity
        inst.groupId = gid;
        this.created.push(inst);
        return inst;
      },
      // Register a def, reusing an identical one from a previous generation so
      // regenerate-iterations don't pile up throwaway defs in the panel.
      def(em, name) {
        const key = name + '|' + defKey(em);
        const existing = (Model.components || []).find(c => c.name === name && c.em && (name + '|' + defKey(c.em)) === key);
        if (existing) return existing;
        const d = _defFromEM(em, name);
        this.newDefs.push(d);
        return d;
      },
    };
  }

  // Grid positions from a0..a1 at `pitch`, endpoints always included; interior
  // lines closer than minBay to an edge are dropped (no sliver end bays).
  function gridPositions(a0, a1, pitch, align, minBay) {
    const extent = a1 - a0;
    const inner = [];
    if (pitch > 0.01 && extent > pitch * 1.001) {
      let start = a0 + pitch;
      if (align === 'center') {
        const bays = Math.floor(extent / pitch);
        start = a0 + (extent - bays * pitch) / 2;
        if (start - a0 < pitch * 0.05) start += pitch;   // avoid a sliver bay at the edge
      }
      for (let x = start; x < a1 - pitch * 0.05; x += pitch) inner.push(x);
    }
    const mb = Math.max(minBay || 0, 0);
    return [a0, ...inner.filter(x => x - a0 >= mb && a1 - x >= mb), a1];
  }

  const fmtMM = m => Math.round(m / MM);

  /* --------------------------------- Louver --------------------------------- */
  function generateLouver(P, ctx) {
    const { u0, u1, v0, v1 } = ctx.pick.uv;
    const inset = Math.max(fin(P.inset, 0), 0) * MM, offset = fin(P.offset, 0) * MM;
    const spacing = Math.max(pos(P.spacing, 600), 10) * MM;
    const vertical = (P.orientation || 'vertical') === 'vertical';
    const sup = P.support || { type: 'none' };
    const railW = Math.max(pos(sup.rail_w, 60), 10) * MM, railD = Math.max(pos(sup.rail_d, 60), 10) * MM;
    const color = 0x9aa0a6;

    let uu0 = u0 + inset, uu1 = u1 - inset, vv0 = v0 + inset, vv1 = v1 - inset;
    if (uu1 - uu0 < 0.005 || vv1 - vv0 < 0.005) throw new Error('facade: face too small for these louver settings');

    // Rails sit at the inset bounds; blades run between them on BOTH axes
    // (a rail parallel to the blades must not intersect the end blades).
    const rails = [];
    if (sup.type === 'top_bottom_rail') {
      rails.push({ axis: 'u', at: vv0 }, { axis: 'u', at: vv1 - railW, lo: uu0, hi: uu1 });
      rails[0].lo = uu0; rails[0].hi = uu1;
      vv0 += railW; vv1 -= railW;
    } else if (sup.type === 'side_rail') {
      rails.push({ axis: 'v', at: uu0 }, { axis: 'v', at: uu1 - railW, lo: vv0, hi: vv1 });
      rails[0].lo = vv0; rails[0].hi = vv1;
      uu0 += railW; uu1 -= railW;
    }

    const pts = profilePoints(P.profile, P.rotation_deg);
    let sMin = Infinity, sMax = -Infinity;
    for (const [s] of pts) { sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); }

    // Blade centres clamped so the profile's real s-extent stays inside the run.
    const runLo = (vertical ? uu0 : vv0) - sMin;
    const runHi = (vertical ? uu1 : vv1) - sMax;
    const bladeLen = vertical ? (vv1 - vv0) : (uu1 - uu0);
    if (bladeLen < 0.005 || runHi < runLo) throw new Error('facade: face too small for these louver settings');
    const count = Math.floor((runHi - runLo) / spacing) + 1;
    if (count > MAX_OBJECTS) throw new Error('facade: ' + count + ' blades exceeds the cap (' + MAX_OBJECTS + ') — increase spacing');
    const start = runLo + ((runHi - runLo) - (count - 1) * spacing) / 2;

    // Vertical blade: extrude along def Y (world v), profile s→X (world u), t→Z (normal).
    // Horizontal blade: extrude along def X (world u), profile s→Y (world v), t→Z.
    const em = vertical
      ? prismEM(pts, AXIS_X, AXIS_Z, AXIS_Y, bladeLen, color, ctx.layerId)
      : prismEM(pts, AXIS_Y, AXIS_Z, AXIS_X, bladeLen, color, ctx.layerId);
    const def = ctx.def(em, 'Louver ' + fmtMM(pos(P.profile && P.profile.w, 40) * MM) + '×' + fmtMM(pos(P.profile && P.profile.d, 150) * MM));

    const gBlades = ctx.subGroup('Louvers');
    for (let i = 0; i < count; i++) {
      const at = start + i * spacing;
      if (vertical) ctx.stamp(def, at, vv0, offset, 'Louver ' + (i + 1), gBlades);
      else          ctx.stamp(def, uu0, at, offset, 'Louver ' + (i + 1), gBlades);
    }

    if (rails.length) {
      const gRails = ctx.subGroup('Rails');
      const railColor = 0x7d838a;
      let rdefU = null, rdefV = null;
      for (let i = 0; i < rails.length; i++) {
        const r = rails[i];
        if (r.axis === 'u') {
          rdefU = rdefU || ctx.def(prismEM([[0, 0], [railW, 0], [railW, railD], [0, railD]],
                                            AXIS_Y, AXIS_Z, AXIS_X, r.hi - r.lo, railColor, ctx.layerId),
                                   'Louver rail ' + fmtMM(railW) + '×' + fmtMM(railD));
          ctx.stamp(rdefU, r.lo, r.at, offset, 'Rail ' + (i + 1), gRails);
        } else {
          rdefV = rdefV || ctx.def(prismEM([[0, 0], [railW, 0], [railW, railD], [0, railD]],
                                            AXIS_X, AXIS_Z, AXIS_Y, r.hi - r.lo, railColor, ctx.layerId),
                                   'Louver rail ' + fmtMM(railW) + '×' + fmtMM(railD));
          ctx.stamp(rdefV, r.at, r.lo, offset, 'Rail ' + (i + 1), gRails);
        }
      }
    }
  }

  /* ------------------------------ Curtain wall ------------------------------ */
  function ensureFacadeMaterial(id, def) {
    if (typeof ImportedMaterials === 'undefined') return null;
    let m = ImportedMaterials.find(x => x.id === id);
    if (!m) { m = { id, _imported: true, _texture: null, _origDataURL: null, _textureFile: null, ...def }; ImportedMaterials.push(m); }
    return m;
  }

  function generateCurtainWall(P, ctx) {
    const { u0, u1, v0, v1 } = ctx.pick.uv;
    const offset = fin(P.offset, 0) * MM;
    const g = P.grid || {};
    const uPitch = Math.max(pos(g.u_pitch, 1200), 100) * MM;
    const vPitch = Math.max(pos(g.v_pitch, 3500), 100) * MM;
    const mW = Math.max(pos(P.mullion && P.mullion.w, 50), 10) * MM, mD = Math.max(pos(P.mullion && P.mullion.d, 150), 10) * MM;
    const tW = Math.max(pos(P.transom && P.transom.w, 50), 10) * MM, tD = Math.max(pos(P.transom && P.transom.d, 150), 10) * MM;
    const gTh = Math.max(pos(P.glass && P.glass.thickness, 24), 4) * MM;
    const gInset = Math.max(fin(P.glass && P.glass.inset_from_front, 50), 0) * MM;
    const spandrelEvery = Math.max(Math.round(fin(P.spandrel && P.spandrel.every_v, 0)), 0);
    const spandrelH = Math.max(pos(P.spandrel && P.spandrel.height, 900), 50) * MM;
    const alumColor = 0x8d939a;
    if (u1 - u0 < mW * 2 || v1 - v0 < tW * 2) throw new Error('facade: face too small for a curtain wall');

    const minBay = Math.max(mW, tW) * 1.5;
    const us = gridPositions(u0, u1, uPitch, g.align || 'start', minBay);
    const vs = gridPositions(v0, v1, vPitch, g.align || 'start', minBay);
    const panelFactor = spandrelEvery > 0 ? 2 : 1;
    const estimate = us.length + (us.length - 1) * vs.length + (us.length - 1) * (vs.length - 1) * panelFactor;
    if (estimate > MAX_OBJECTS) throw new Error('facade: ~' + estimate + ' members exceeds the cap (' + MAX_OBJECTS + ') — increase pitch');

    // Member centre positions: edge members sit flush inside the bounds.
    const centre = (arr, i, w) => (i === 0 ? arr[0] + w / 2 : (i === arr.length - 1 ? arr[i] - w / 2 : arr[i]));
    const H = v1 - v0;
    const sysD = Math.max(mD, tD);
    const zGlass = Math.max(offset, offset + sysD - gInset - gTh);

    // Mullions: one def, full height, at every u gridline.
    const gMull = ctx.subGroup('Mullions');
    const mullDef = ctx.def(prismEM([[-mW / 2, 0], [mW / 2, 0], [mW / 2, mD], [-mW / 2, mD]],
                                     AXIS_X, AXIS_Z, AXIS_Y, H, alumColor, ctx.layerId),
                            'CW mullion ' + fmtMM(mW) + '×' + fmtMM(mD));
    us.forEach((uu, i) => ctx.stamp(mullDef, centre(us, i, mW), v0, offset, 'Mullion ' + (i + 1), gMull));

    // Transoms: per-bay clear length between mullion faces; defs cached by length.
    const gTrans = ctx.subGroup('Transoms');
    const transDef = len => ctx.def(prismEM([[-tW / 2, 0], [tW / 2, 0], [tW / 2, tD], [-tW / 2, tD]],
                                             AXIS_Y, AXIS_Z, AXIS_X, len, alumColor, ctx.layerId),
                                    'CW transom ' + fmtMM(tW) + '×' + fmtMM(tD) + ' L' + Math.round(len / MM));
    let tIdx = 0;
    for (let i = 0; i < us.length - 1; i++) {
      const a = centre(us, i, mW) + mW / 2, b = centre(us, i + 1, mW) - mW / 2;
      if (b - a < 0.01) continue;
      for (let j = 0; j < vs.length; j++)
        ctx.stamp(transDef(b - a), a, centre(vs, j, tW), offset, 'Transom ' + (++tIdx), gTrans);
    }

    // Glass (and optional spandrel band at the bottom of every Nth row).
    const gGlass = ctx.subGroup('Glass');
    const glassMat = (typeof MATERIALS !== 'undefined') && MATERIALS.find(m => m.id === 'glass');
    const spandrelColor = 0x2f353b;
    const spandrelMat = ensureFacadeMaterial('facade:spandrel:' + spandrelColor.toString(16),
                                             { name: 'Facade Spandrel', color: spandrelColor, opacity: 1.0, transparent: false });
    const panelDef = (w, h) => ctx.def(prismEM([[0, 0], [w, 0], [w, gTh], [0, gTh]],
                                                AXIS_X, AXIS_Z, AXIS_Y, h, 0xdde4ea, ctx.layerId),
                                       'CW panel ' + Math.round(w / MM) + 'x' + Math.round(h / MM));
    let gIdx = 0;
    for (let i = 0; i < us.length - 1; i++) {
      const w = us[i + 1] - us[i];
      for (let j = 0; j < vs.length - 1; j++) {
        const h = vs[j + 1] - vs[j];
        const spandrel = spandrelEvery > 0 && (j % spandrelEvery === spandrelEvery - 1) && spandrelH < h - 0.01;
        if (spandrel) {
          const sp = ctx.stamp(panelDef(w, spandrelH), us[i], vs[j], zGlass, 'Spandrel ' + (gIdx + 1), gGlass);
          if (spandrelMat && typeof applyMaterialToObject === 'function') applyMaterialToObject(sp, spandrelMat);
          const gl = ctx.stamp(panelDef(w, h - spandrelH), us[i], vs[j] + spandrelH, zGlass, 'Glass ' + (++gIdx), gGlass);
          if (glassMat && typeof applyMaterialToObject === 'function') applyMaterialToObject(gl, glassMat);
        } else {
          const gl = ctx.stamp(panelDef(w, h), us[i], vs[j], zGlass, 'Glass ' + (++gIdx), gGlass);
          if (glassMat && typeof applyMaterialToObject === 'function') applyMaterialToObject(gl, glassMat);
        }
      }
    }
  }

  /* ------------------------------ Entry point ------------------------------- */
  const GENERATORS = { louver: generateLouver, curtain_wall: generateCurtainWall };

  function generate(schema, pick) {
    if (!schema || !GENERATORS[schema.archetype]) { setStatus('msg', 'Facade: unknown archetype'); return null; }
    if (!pick || !pick.basis || !pick.uv) { setStatus('msg', 'Facade: no target face'); return null; }
    if (Model.activeComponentSource) { setStatus('msg', 'Facade: exit component edit first'); return null; }
    const name = schema.name || (schema.archetype === 'louver' ? 'Louver System' : 'Curtain Wall');
    const prevSuppress = Model._suppressAddRefresh, prevBulk = window._bulkRestore;
    Model._suppressAddRefresh = true; window._bulkRestore = true;
    let ctx = null;
    try {
      ctx = makeCtx(pick, name);
      GENERATORS[schema.archetype](schema.params || {}, ctx);
      if (!ctx.created.length) throw new Error('facade: nothing generated');
    } catch (err) {
      // Roll back half-built output so a failed run leaves no trace:
      // instances, this run's fresh defs, and the group subtree.
      if (ctx) {
        for (const o of ctx.created) { try { removeObject(o); } catch (_) {} }
        if (ctx.newDefs.length && Model.components) {
          const dead = new Set(ctx.newDefs);
          Model.components = Model.components.filter(c => !dead.has(c));
          for (const d of ctx.newDefs) {
            try { d.geometry && d.geometry.dispose(); d.edgeGeometry && d.edgeGeometry.dispose(); } catch (_) {}
          }
        }
        if (Model.groups) {
          const doomed = new Set([ctx.rootGid]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const [gid, gr] of Model.groups)
              if (!doomed.has(gid) && doomed.has(gr.parentId)) { doomed.add(gid); grew = true; }
          }
          for (const gid of doomed) Model.groups.delete(gid);
        }
      }
      Model._suppressAddRefresh = prevSuppress; window._bulkRestore = prevBulk;
      setStatus('msg', String(err.message || err));
      console.warn('[facade]', err);
      return null;
    }
    Model._suppressAddRefresh = prevSuppress; window._bulkRestore = prevBulk;
    renderOutliner();
    applyLayerVisibility();
    try { AD.Layers && AD.Layers.applyToScene && AD.Layers.applyToScene(); } catch (_) {}
    try { rebuildSectionFills(); } catch (_) {}
    try { if (typeof renderComponentList === 'function') renderComponentList(); } catch (_) {}
    pushHistory('Insert Facade (' + schema.archetype + ')');
    setStatus('msg', 'Facade: ' + ctx.created.length + ' objects in "' + name + '"');
    return { groupId: ctx.rootGid, objects: ctx.created };
  }

  /* ------------------------------- Pick tool -------------------------------- */
  let _pendingSchema = null;
  let _armedTab = null;

  function registerPickTool() {
    if (typeof Tools === 'undefined' || Tools.adFacadePick) return;
    Tools.adFacadePick = {
      name: 'adFacadePick', label: 'Facade: pick face', cursor: 'crosshair',
      _hoverMesh: null, _hoverMat: null, _hoverKey: null,
      _clearHover() {
        if (this._hoverMesh) {
          if (this._hoverMesh.parent) this._hoverMesh.parent.remove(this._hoverMesh);
          try { this._hoverMesh.geometry.dispose(); } catch (_) {}
          this._hoverMesh = null;
        }
        this._hoverKey = null;
      },
      onActivate() { setStatus('msg', 'Facade: click a face to generate on · Esc to cancel'); },
      onDeactivate() {
        this._clearHover();
        if (this._hoverMat) { try { this._hoverMat.dispose(); } catch (_) {} this._hoverMat = null; }
        _pendingSchema = null;                     // a cancelled pick must not fire later with a stale schema
        helperRoot.clear();
      },
      onPointerMove(e) {
        const hit = pickAtPointer(e);
        const key = hit ? hit.obj._uid + ':' + hit.fi : null;
        if (key === this._hoverKey && (!hit || (this._hoverMesh && this._hoverMesh.parent))) return;
        this._clearHover();
        this._hoverKey = key;
        if (!hit) return;
        // Cheap hover highlight: seed face only (full region resolved on click).
        const em = hit.obj.em, f = em.faces[hit.fi];
        hit.obj.group.updateMatrixWorld(true);
        const M = hit.obj.mesh.matrixWorld;
        const tris = em.triangulateFace(f);
        const pts = [];
        for (const [a, b, c] of tris)
          pts.push(em.vertices[a].clone().applyMatrix4(M), em.vertices[b].clone().applyMatrix4(M), em.vertices[c].clone().applyMatrix4(M));
        this._hoverMat = this._hoverMat || new THREE.MeshBasicMaterial({
          color: 0x34c759, opacity: 0.25, transparent: true, side: THREE.DoubleSide, depthTest: false });
        this._hoverMesh = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(pts), this._hoverMat);
        helperRoot.add(this._hoverMesh);
      },
      onPointerDown(e) {
        if (e.button !== 0) return;
        if (typeof AD.Tabs !== 'undefined' && AD.Tabs && _armedTab !== null && AD.Tabs.activeId !== _armedTab) {
          _pendingSchema = null;                   // armed in another tab — never generate into this one
          ToolMgr.set('select');
          return;
        }
        const hit = pickAtPointer(e);
        if (!hit) { setStatus('msg', 'Facade: no face under cursor — click a face or press Esc'); return; }
        const pick = pickFromFace(hit.obj, hit.fi);
        const schema = _pendingSchema;
        _pendingSchema = null;
        ToolMgr.set('select');
        if (pick && schema) generate(schema, pick);
      },
      onPointerUp() {},
    };
    try { if (typeof RETICLE_TOOLS !== 'undefined') RETICLE_TOOLS.add('adFacadePick'); } catch (_) {}  // mobile crosshair aiming
  }

  function armPick(schema) {
    registerPickTool();
    if (typeof ToolMgr === 'undefined' || !Tools.adFacadePick) return;
    ToolMgr.set('adFacadePick');                   // set BEFORE storing: re-arming triggers onDeactivate, which clears
    _pendingSchema = schema;
    _armedTab = (typeof AD.Tabs !== 'undefined' && AD.Tabs) ? AD.Tabs.activeId : null;
  }

  /* --------------------------------- Panel ---------------------------------- */
  function num(id, fallback) {
    const el = document.getElementById(id);
    const x = el ? parseFloat(el.value) : NaN;
    return isFinite(x) ? x : fallback;
  }
  function sel(id, fallback) {
    const el = document.getElementById(id);
    return (el && el.value) || fallback;
  }

  function schemaFromUI() {
    const archetype = sel('adFcType', 'louver');
    if (archetype === 'louver') {
      return { version: 1, archetype, name: 'Louver System', params: {
        orientation: sel('adFcLvOrient', 'vertical'),
        spacing: num('adFcLvSpacing', 600),
        profile: { shape: sel('adFcLvShape', 'rect'), w: num('adFcLvW', 40), d: num('adFcLvD', 150) },
        rotation_deg: num('adFcLvRot', 0),
        offset: num('adFcLvOffset', 100),
        inset: num('adFcLvInset', 0),
        support: { type: sel('adFcLvSupport', 'none'), rail_w: num('adFcLvRailW', 60), rail_d: num('adFcLvRailD', 60) },
      } };
    }
    return { version: 1, archetype: 'curtain_wall', name: 'Curtain Wall', params: {
      grid: { u_pitch: num('adFcCwUPitch', 1200), v_pitch: num('adFcCwVPitch', 3500), align: sel('adFcCwAlign', 'start') },
      mullion: { w: num('adFcCwMW', 50), d: num('adFcCwMD', 150) },
      transom: { w: num('adFcCwTW', 50), d: num('adFcCwTD', 150) },
      glass: { thickness: num('adFcCwGTh', 24), inset_from_front: num('adFcCwGIn', 50) },
      spandrel: { every_v: num('adFcCwSpEvery', 0), height: num('adFcCwSpH', 900) },
      offset: num('adFcCwOffset', 0),
    } };
  }

  const ROW = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;font-size:10px;';
  const INP = 'width:52px;font-size:10px;padding:1px 3px;border:0.5px solid rgba(0,0,0,0.25);border-radius:3px;';
  const SEL = 'font-size:10px;padding:1px 2px;border:0.5px solid rgba(0,0,0,0.25);border-radius:3px;background:#fff;';
  const LBL = 'flex:1 1 auto;color:#444;';

  function row(label, inner) { return `<div style="${ROW}"><span style="${LBL}">${label}</span>${inner}</div>`; }
  function numIn(id, val, min) {
    return `<input type="number" id="${id}" value="${val}"${min != null ? ` min="${min}"` : ''} style="${INP}">`;
  }

  function injectFacadePanel() {
    const right = document.getElementById('rightpanel');
    if (!right || document.getElementById('adFacadePanel')) return;
    const secEl = document.createElement('div');
    secEl.className = 'panel-section collapsible';
    secEl.id = 'adFacadePanel';
    secEl.style.cssText = 'flex:0 0 auto;';
    secEl.innerHTML = `
      <div class="panel-header" data-toggle="adFacadeBody">
        <span><span class="arrow">▸</span>
          <svg class="panel-icon" viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="3" width="16" height="18"/>
            <path d="M8 3v18M12 3v18M16 3v18"/>
          </svg>
          Facade
        </span>
      </div>
      <div class="panel-body" id="adFacadeBody" style="padding:8px;display:none;">
        ${row('Type', `<select id="adFcType" style="${SEL}">
            <option value="louver">Louver</option>
            <option value="curtain_wall">Curtain wall</option>
          </select>`)}
        <div id="adFcLouver">
          ${row('Orientation', `<select id="adFcLvOrient" style="${SEL}">
              <option value="vertical">Vertical</option><option value="horizontal">Horizontal</option>
            </select>`)}
          ${row('Spacing (mm)', numIn('adFcLvSpacing', 600, 1))}
          ${row('Profile', `<select id="adFcLvShape" style="${SEL}">
              <option value="rect">Rect</option><option value="ellipse">Ellipse</option>
              <option value="L">L</option><option value="Z">Z</option><option value="airfoil">Airfoil</option>
            </select>`)}
          ${row('Blade w × d (mm)', numIn('adFcLvW', 40, 1) + numIn('adFcLvD', 150, 1))}
          ${row('Angle (°)', numIn('adFcLvRot', 0))}
          ${row('Offset / inset (mm)', numIn('adFcLvOffset', 100) + numIn('adFcLvInset', 0, 0))}
          ${row('Support', `<select id="adFcLvSupport" style="${SEL}">
              <option value="none">None</option>
              <option value="top_bottom_rail">Top+bottom rail</option>
              <option value="side_rail">Side rails</option>
            </select>`)}
          ${row('Rail w × d (mm)', numIn('adFcLvRailW', 60, 1) + numIn('adFcLvRailD', 60, 1))}
        </div>
        <div id="adFcCw" style="display:none;">
          ${row('Pitch u × v (mm)', numIn('adFcCwUPitch', 1200, 1) + numIn('adFcCwVPitch', 3500, 1))}
          ${row('Align', `<select id="adFcCwAlign" style="${SEL}">
              <option value="start">Start</option><option value="center">Center</option>
            </select>`)}
          ${row('Mullion w × d (mm)', numIn('adFcCwMW', 50, 1) + numIn('adFcCwMD', 150, 1))}
          ${row('Transom w × d (mm)', numIn('adFcCwTW', 50, 1) + numIn('adFcCwTD', 150, 1))}
          ${row('Glass th / inset (mm)', numIn('adFcCwGTh', 24, 1) + numIn('adFcCwGIn', 50, 0))}
          ${row('Spandrel every / h (mm)', numIn('adFcCwSpEvery', 0, 0) + numIn('adFcCwSpH', 900, 1))}
          ${row('Offset (mm)', numIn('adFcCwOffset', 0))}
        </div>
        <button id="adFcGenerate"
          style="width:100%;font-size:10px;pointer-events:auto;padding:4px 6px;margin-top:2px;
                 border:0.5px solid rgba(0,0,0,0.2);border-radius:5px;background:#f5f5f7;cursor:pointer;">
          Pick face &amp; generate
        </button>
      </div>`;
    right.appendChild(secEl);   // collapse/accordion auto-wired by the #rightpanel MutationObserver

    secEl.querySelector('#adFcType').addEventListener('change', ev => {
      const cw = ev.target.value === 'curtain_wall';
      document.getElementById('adFcLouver').style.display = cw ? 'none' : '';
      document.getElementById('adFcCw').style.display = cw ? '' : 'none';
    });
    secEl.querySelector('#adFcGenerate').addEventListener('click', () => armPick(schemaFromUI()));
  }

  /* ------------------------------- Self-test -------------------------------- */
  // Dev-only sanity run (devtools: AD.Facade._selfTest()). Builds a 6×3 m wall,
  // generates vertical + horizontal louvers and a curtain wall on it.
  function _selfTest() {
    const em = new EditableMesh();
    [[0, 0, 0], [6, 0, 0], [6, 3, 0], [0, 3, 0]].forEach(p => em.vertices.push(new THREE.Vector3(...p)));
    em.addFace([0, 1, 2, 3], 0xf0f0f0, Model.activeLayerId);
    const wall = new SketchObject(em, 'Facade test wall');
    addObject(wall);
    pushHistory('Facade self-test wall');
    const pick = pickFromFace(wall, 0);
    const r1 = generate({ version: 1, archetype: 'louver', name: 'ST Louvers', params: {
      orientation: 'vertical', spacing: 600, profile: { shape: 'Z', w: 40, d: 150 },
      rotation_deg: 20, offset: 100, inset: 50,
      support: { type: 'top_bottom_rail', rail_w: 60, rail_d: 60 } } }, pick);
    const r2 = generate({ version: 1, archetype: 'louver', name: 'ST Louvers H', params: {
      orientation: 'horizontal', spacing: 450, profile: { shape: 'airfoil', w: 30, d: 200 },
      offset: 400, inset: 0,
      support: { type: 'side_rail', rail_w: 80, rail_d: 80 } } }, pick);
    const r3 = generate({ version: 1, archetype: 'curtain_wall', name: 'ST CW', params: {
      grid: { u_pitch: 1200, v_pitch: 1500, align: 'center' },
      mullion: { w: 50, d: 150 }, transom: { w: 50, d: 150 },
      glass: { thickness: 24, inset_from_front: 50 },
      spandrel: { every_v: 2, height: 600 }, offset: 0 } }, pick);
    const r4 = generate({ version: 1, archetype: 'louver', name: 'ST NaN', params: {
      profile: { shape: 'rect', w: 'not-a-number', d: null } } }, pick);   // must fall back to defaults, not NaN
    const nan = r4 && r4.objects.some(o => o.def.em.vertices.some(v => !isFinite(v.x + v.y + v.z)));
    const ok = !!(r1 && r1.objects.length && r2 && r2.objects.length && r3 && r3.objects.length && r4 && !nan);
    console.log('[facade-selftest]', ok ? 'PASS' : 'FAIL',
                'V:', r1 && r1.objects.length, 'H:', r2 && r2.objects.length,
                'CW:', r3 && r3.objects.length, 'NaN-guard:', r4 ? (nan ? 'LEAKED-NaN' : 'ok') : 'failed');
    return { r1, r2, r3, r4 };
  }

  AD.Facade = { generate, pickFromFace, armPick, schemaFromUI, _selfTest };

  /* --------------------------------- Boot ----------------------------------- */
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      try { injectFacadePanel(); registerPickTool(); } catch (err) { console.warn('[facade] boot failed', err); }
    }, 600);   // after ad/layers.js's 500 ms addObject patch
  });
})();
