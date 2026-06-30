/* ============================================================================
   AD.SectionStyle — per-layer styling for section cuts.
   ----------------------------------------------------------------------------
   Replaces Turtle Drawing's default "solid black cut fill + uniform black
   cut edge" with:
     • Cut EDGES rendered as fat LineSegments2 at the owning object's
       LAYER.lineWeight.
     • Cut FILL painted with the owning object's LAYER.cutHatch (vector
       line pattern). If the layer has no cutHatch, no fill is drawn —
       the cut just shows the thick edge.
   The replacement is a monkey-patch of rebuildSectionFills so the base
   engine stays untouched.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  AD.SectionStyle = {};

  /* Gather cut segments PER object (so each can be styled by its own
     layer). Mirrors computeSectionCutSegments's logic but keeps owner. */
  function collectPerObject(plane) {
    const EPS = 1e-6;
    const perObj = new Map();   // obj -> { segs:[], faceVerts:[[v3, v3, ...], ...] }
    for (const obj of Model.objects) {
      if (!obj.group.visible || obj.locked) continue;
      if (!obj.em.faces.length) continue;
      const entry = { segs: [] };
      // Component instances store em in definition-LOCAL space placed by a group
      // transform; transform verts to WORLD before testing against the (world)
      // section plane. Non-instances have identity transforms (vw == vertex).
      const _Mw = (obj.isInstance && obj.group) ? (obj.group.updateMatrixWorld(true), obj.group.matrixWorld) : null;
      const _vw = (vi) => { const v = obj.em.vertices[vi]; return _Mw ? v.clone().applyMatrix4(_Mw) : v; };
      // Skip duplicate faces (CSG residue: identical vertex sets emit double
      // cut segments at the same location → phantom edges along slabs).
      const _seenFaces = new Set();
      // Crossings of plane with one closed loop of vertex indices.
      const loopCrossings = (vertIdxs) => {
        const dists = vertIdxs.map(vi => plane.distanceToPoint(_vw(vi)));
        let hasPos = false, hasNeg = false;
        for (const d of dists) {
          if (d >  EPS) hasPos = true;
          if (d < -EPS) hasNeg = true;
        }
        if (!hasPos || !hasNeg) return null;
        const crosses = [];
        for (let i = 0; i < vertIdxs.length; i++) {
          const j = (i + 1) % vertIdxs.length;
          const da = dists[i], db = dists[j];
          const pa = _vw(vertIdxs[i]);
          const pb = _vw(vertIdxs[j]);
          if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
            const t = da / (da - db);
            crosses.push(new THREE.Vector3().lerpVectors(pa, pb, t));
          } else if (Math.abs(da) <= EPS && Math.abs(db) <= EPS) {
            crosses.push(pa.clone(), pb.clone());
          } else if (Math.abs(da) <= EPS) {
            crosses.push(pa.clone());
          }
        }
        return crosses;
      };
      for (const face of obj.em.faces) {
        if (face.verts.length < 3) continue;
        const _fkey = face.verts.slice().sort((a, b) => a - b).join(',');
        if (_seenFaces.has(_fkey)) continue;
        _seenFaces.add(_fkey);
        const outer = loopCrossings(face.verts);
        if (!outer || outer.length < 2) continue;
        const A = outer[0], B = outer[1];
        // Build a 1D parameter t along A→B direction; collect all crossings.
        const dir = new THREE.Vector3().subVectors(B, A);
        const denom2 = dir.lengthSq();
        if (denom2 < 1e-12) continue;
        const tOf = (p) => new THREE.Vector3().subVectors(p, A).dot(dir) / denom2;
        // Outer enters at t=0 and exits at t=1.
        const events = [{ t: 0, kind: 'outer' }, { t: 1, kind: 'outer' }];
        if (face.holes && face.holes.length) {
          for (const hole of face.holes) {
            const hc = loopCrossings(hole);
            if (!hc || hc.length < 2) continue;
            // Hole produces 2 crossings on the same line (face is planar);
            // use parameter along A-B direction.
            const t0 = tOf(hc[0]), t1 = tOf(hc[1]);
            events.push({ t: Math.min(t0, t1), kind: 'hole' });
            events.push({ t: Math.max(t0, t1), kind: 'hole' });
          }
        }
        events.sort((a, b) => a.t - b.t);
        // Walk: each crossing toggles its kind's state.
        // Inside material when inOuter && !inHole.
        let inOuter = false, inHole = false;
        let lastT = events[0].t;
        // Apply the first event's toggle BEFORE the loop emit-check.
        if (events[0].kind === 'outer') inOuter = !inOuter;
        else inHole = !inHole;
        for (let i = 1; i < events.length; i++) {
          const ev = events[i];
          if (ev.t > lastT + 1e-6 && inOuter && !inHole) {
            const p0 = A.clone().addScaledVector(dir, lastT);
            const p1 = A.clone().addScaledVector(dir, ev.t);
            entry.segs.push([p0, p1]);
          }
          if (ev.kind === 'outer') inOuter = !inOuter;
          else inHole = !inHole;
          lastT = ev.t;
        }
      }
      if (entry.segs.length) perObj.set(obj, entry);
    }
    return perObj;
  }

  /* Chain segments of one object into closed polygon loops (same basic
     idea as base engine's segmentsToLoops but reused here for clarity). */
  function chainToLoops(segs) {
    const EPS = 1e-3;
    const pool = segs.map(s => [s[0].clone(), s[1].clone()]);
    const loops = [];
    const equal = (a, b) => a.distanceTo(b) < EPS;
    while (pool.length) {
      const first = pool.shift();
      const loop = [first[0], first[1]];
      let extended = true;
      while (extended) {
        extended = false;
        for (let i = 0; i < pool.length; i++) {
          const s = pool[i];
          const tail = loop[loop.length - 1];
          const head = loop[0];
          if (equal(s[0], tail))      { loop.push(s[1]); pool.splice(i, 1); extended = true; break; }
          else if (equal(s[1], tail)) { loop.push(s[0]); pool.splice(i, 1); extended = true; break; }
          else if (equal(s[0], head)) { loop.unshift(s[1]); pool.splice(i, 1); extended = true; break; }
          else if (equal(s[1], head)) { loop.unshift(s[0]); pool.splice(i, 1); extended = true; break; }
        }
      }
      if (loop.length >= 3 && loop[0].distanceTo(loop[loop.length - 1]) < EPS * 10) {
        loops.push(loop);
      }
    }
    return loops;
  }

  /* 2D hatch lines clipped to a polygon on the section plane, then
     lifted back to 3D with a tiny normal offset. */
  function hatchLinesForLoop(loop, planeNormal, hatchId, sectionRoot) {
    if (!AD.HatchLines || typeof AD.HatchLines.apply !== 'function') return null;
    // Build 2D basis on the section plane.
    const n = planeNormal.clone().normalize();
    let u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const O = loop[0];
    const poly2 = loop.map(p => {
      const d = new THREE.Vector3().subVectors(p, O);
      return [d.dot(u), d.dot(v)];
    });
    // Reuse the private generator via a tiny proxy face object.
    const proxyEM = {
      vertices: loop,
      faces: [{ verts: loop.map((_, i) => i), normal: n, color: 0xffffff, layerId: null }],
    };
    proxyEM.faces[0].verts = loop.map((_, i) => i);
    // Build a fake face object accepted by AD.HatchLines.apply's internal
    // path. Since that method expects a real object, we instead inline
    // the minimal pipeline here by calling HatchLines' exposed pattern.
    const segs = (AD.HatchLines.__generate || ((bbox) => []))(hatchId, clipBBox(poly2));
    return { poly2, uvBasis: { u, v, O }, segs };
  }
  function clipBBox(poly2) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly2) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  /* Main install: replace rebuildSectionFills.
     Strategy:
       1. Collect cut segments per object.
       2. Group objects by (hatch-id) so same-material adjacent pieces
          read as one continuous surface — the seam segment shared
          between two same-hatch objects is dropped from cut edges so
          no line shows between them.
       3. For each object within a group, draw the cut fill (white
          base + hatch lines). Coplanar + same pattern means neighbours
          look seamless.
       4. For each group, draw only the BOUNDARY segments (count == 1)
          as thick cut edges at the layer's lineWeight. If weights
          within a group differ, use the maximum. */
  function install() {
    if (typeof rebuildSectionFills !== 'function') return;
    if (rebuildSectionFills._adPatched) return;
    const origClear = typeof clearSectionFills === 'function' ? clearSectionFills : () => {};
    window.rebuildSectionFills = function () {
      origClear();
      if (typeof sectionFillRoot === 'undefined') return;
      for (const sp of Model.sectionPlanes) {
        if (!sp.enabled) continue;
        const perObj = collectPerObject(sp.plane);

        // Group by hatch id for continuity. null-hatch objects stay in
        // their own solo group.
        const groups = new Map();       // groupKey -> { objs, hatchId, maxW, segs:[] }
        let soloKey = 0;
        for (const [obj, entry] of perObj) {
          const lid = obj.layerId;
          const w = (window.AD && AD.Layers) ? AD.Layers.weightOf(lid) : 0.5;
          const h = (window.AD && AD.Layers) ? AD.Layers.cutHatchOf(lid) : null;
          const key = h ? ('H:' + h) : ('S:' + (soloKey++));
          if (!groups.has(key)) groups.set(key, { hatchId: h, maxW: 0, items: [] });
          const g = groups.get(key);
          g.maxW = Math.max(g.maxW, w);
          g.items.push({ obj, segs: entry.segs });
        }

        // Draw fills first so cut edges land on top.
        if (Model.sectionFills) {
          for (const [, g] of groups) {
            for (const it of g.items) {
              if (g.hatchId) {
                // Every layer hatch — INCLUDING poché — renders as its line pattern
                // (poché used to be special-cased to a flat solid-black cap, which
                // the user wanted shown as a hatch like the others).
                drawHatchFill(it.segs, sp.plane, g.hatchId, sectionFillRoot);
              } else {
                // No layer hatch assigned → default mid-gray poché fill.
                drawSolidFill(it.segs, sp.plane, sectionFillRoot, 0x808080);
              }
            }
          }
        }

        // Build per-group edge multiset; keep only boundary (count == 1).
        for (const [, g] of groups) {
          const keyOf = (a, b) => {
            const q = (p) => Math.round(p.x * 1000) + ',' +
                             Math.round(p.y * 1000) + ',' +
                             Math.round(p.z * 1000);
            const k1 = q(a), k2 = q(b);
            return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
          };
          const count = new Map();
          const storage = new Map();    // key -> [a,b] for later retrieval
          for (const it of g.items) {
            for (const s of it.segs) {
              const k = keyOf(s[0], s[1]);
              count.set(k, (count.get(k) || 0) + 1);
              if (!storage.has(k)) storage.set(k, s);
            }
          }
          const boundary = [];
          for (const [k, c] of count) {
            if (c === 1) boundary.push(storage.get(k));
          }
          if (!boundary.length) continue;

          // Chain boundary segments into loops and drop hole loops so the
          // inner boundary of cut openings (atrium/notch) doesn't render
          // as a cut line.
          const _loops = chainToLoops(boundary);
          if (window._sectionDebug) {
            console.log('[edges] boundary segs:', boundary.length, 'chained loops:', _loops.length, _loops.map(l => l.length));
            if (window._sectionSegDump) {
              for (let i = 0; i < boundary.length; i++) {
                const s = boundary[i];
                console.log('  seg', i,
                  s[0].x.toFixed(2), s[0].y.toFixed(2), s[0].z.toFixed(2), '→',
                  s[1].x.toFixed(2), s[1].y.toFixed(2), s[1].z.toFixed(2));
              }
              for (let li = 0; li < _loops.length; li++) {
                console.log('  loop', li, _loops[li].map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`).join(' '));
              }
            }
          }
          if (_loops.length) {
            const _cls = classifyLoops(_loops, sp.plane.normal);
            if (window._sectionDebug) {
              console.log('[edges] outers:', _cls.outerIdx.length, 'holes:', _loops.length - _cls.outerIdx.length);
            }
            // Keep ALL chained loops (outer + holes) so a face with a center
            // cut-out renders both the outer cut line and the hole's cut line.
            const keep = new Set(_loops);
            const segKey = (a, b) => {
              const q = (p) => Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000) + ',' + Math.round(p.z * 1000);
              const k1 = q(a), k2 = q(b);
              return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
            };
            const okSet = new Set();
            for (const loop of keep) {
              for (let i = 0; i < loop.length; i++) {
                okSet.add(segKey(loop[i], loop[(i + 1) % loop.length]));
              }
            }
            // Keep only segments that belong to an outer-loop edge. This drops
            // both hole-loop edges AND open/dangling segments that didn't chain.
            const filtered = [];
            for (const s of boundary) {
              if (okSet.has(segKey(s[0], s[1]))) filtered.push(s);
            }
            if (window._sectionDebug) {
              console.log('[edges] kept', filtered.length, 'of', boundary.length);
            }
            boundary.length = 0;
            boundary.push(...filtered);
            if (!boundary.length) continue;
          }

          // Thick cut edges.
          if (typeof THREE.LineSegments2 === 'function') {
            const positions = [];
            // Sit the edge just IN FRONT of the cut fills (smallest inward
            // offset) so depthTest can be on: the line stays visible on the
            // cut side (nothing in front of it) but the kept solid occludes
            // it from the BACK, instead of the line bleeding through the model.
            const eoff = sp.plane.normal.clone().multiplyScalar(0.001);
            for (const s of boundary) {
              const a = s[0].clone().add(eoff);
              const b = s[1].clone().add(eoff);
              positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
            const gm = new THREE.LineSegmentsGeometry();
            gm.setPositions(positions);
            const pxWidth = Math.max(0.5, g.maxW / 0.25 * 1.1);
            const vp = renderer && renderer.domElement;
            const mat = new THREE.LineMaterial({
              color: 0x000000,
              linewidth: pxWidth,
              resolution: new THREE.Vector2(vp ? vp.clientWidth : 1280,
                                            vp ? vp.clientHeight : 720),
              depthTest: true,
              clippingPlanes: [],
            });
            const mesh = new THREE.LineSegments2(gm, mat);
            mesh.renderOrder = 220;
            sectionFillRoot.add(mesh);
          }
        }
      }
    };
    window.rebuildSectionFills._adPatched = true;
  }

  /* Group loops on a section plane into outers + holes (even-odd nesting). */
  function classifyLoops(loops, planeNormal) {
    const n = planeNormal.clone().normalize();
    let u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const O = loops[0][0]; // shared origin
    const polys2 = loops.map(loop => loop.map(p => [
      new THREE.Vector3().subVectors(p, O).dot(u),
      new THREE.Vector3().subVectors(p, O).dot(v),
    ]));
    // Centroid-based nesting fails for non-convex polygons whose centroid
    // happens to fall inside an inner loop. Use a vertex-based vote: count
    // how many of THIS loop's verts are inside the candidate parent. If
    // majority lie inside, treat as nested.
    const sampleInside = (i, j) => {
      let inCount = 0;
      const pts = polys2[i];
      for (const [x, y] of pts) {
        if (pip(x, y, polys2[j])) inCount++;
      }
      return inCount > pts.length / 2;
    };
    const meta = polys2.map(pts => {
      let cx = 0, cy = 0;
      for (const [x, y] of pts) { cx += x; cy += y; }
      return { cx: cx / pts.length, cy: cy / pts.length };
    });
    const isHole = polys2.map((_, i) => {
      let depth = 0;
      for (let j = 0; j < polys2.length; j++) {
        if (i === j) continue;
        if (sampleInside(i, j)) depth++;
      }
      return depth % 2 === 1;
    });
    const outerIdx = [];
    for (let i = 0; i < polys2.length; i++) if (!isHole[i]) outerIdx.push(i);
    const holeAssign = new Map();
    for (let i = 0; i < polys2.length; i++) {
      if (!isHole[i]) continue;
      let bestO = -1, bestArea = Infinity;
      for (const oi of outerIdx) {
        if (sampleInside(i, oi)) {
          const b = bbox2(polys2[oi]);
          const a = (b.maxX - b.minX) * (b.maxY - b.minY);
          if (a < bestArea) { bestArea = a; bestO = oi; }
        }
      }
      if (bestO >= 0) {
        if (!holeAssign.has(bestO)) holeAssign.set(bestO, []);
        holeAssign.get(bestO).push(i);
      }
    }
    return { u, v, O, polys2, outerIdx, holeAssign };
  }

  /* Triangulate outer + holes for one group. Returns array of THREE.Vector3 (3 per tri). */
  function triangulateGroup(loops, oi, holeIs, planeNormal) {
    const outerLoop = loops[oi];
    if (!holeIs || !holeIs.length) {
      return triangulateLoop(outerLoop, planeNormal);
    }
    try {
      const n = planeNormal.clone().normalize();
      let u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
      const v = new THREE.Vector3().crossVectors(n, u);
      // Drop duplicated closing vertex if present (chained loop returns
      // [v0, v1, ..., v0]). ShapeUtils treats this duplicate as a real
      // vertex and inserts a degenerate triangle that fills part of the hole.
      const dropClosing = (loop) => {
        if (loop.length >= 2 && loop[0].distanceTo(loop[loop.length - 1]) < 1e-6) {
          return loop.slice(0, -1);
        }
        return loop.slice();
      };
      // ShapeUtils.triangulateShape requires outer CCW, holes CW.
      const outerLoop2 = dropClosing(outerLoop);
      if (THREE.ShapeUtils.isClockWise(outerLoop2.map(p => new THREE.Vector2(p.dot(u), p.dot(v))))) {
        outerLoop2.reverse();
      }
      const holeLoops = holeIs.map(hi => {
        const hl = dropClosing(loops[hi]);
        if (!THREE.ShapeUtils.isClockWise(hl.map(p => new THREE.Vector2(p.dot(u), p.dot(v))))) {
          hl.reverse();
        }
        return hl;
      });
      const outer2 = outerLoop2.map(p => new THREE.Vector2(p.dot(u), p.dot(v)));
      const holes2 = holeLoops.map(hl => hl.map(p => new THREE.Vector2(p.dot(u), p.dot(v))));
      const triIdx = THREE.ShapeUtils.triangulateShape(outer2, holes2);
      if (!triIdx || !triIdx.length) return triangulateLoop(outerLoop, planeNormal);
      const allV = [...outerLoop2];
      for (const hl of holeLoops) for (const p of hl) allV.push(p);
      const out = [];
      for (const tri of triIdx) out.push(allV[tri[0]], allV[tri[1]], allV[tri[2]]);
      return out;
    } catch (_) {
      return triangulateLoop(outerLoop, planeNormal);
    }
  }

  /* Earcut-triangulate a loop (reuses the base engine's helper when
     present; falls back to naive fan only as a last resort). */
  function triangulateLoop(loop, planeNormal) {
    if (typeof earcutTriangulateLoop === 'function' &&
        typeof ensureLoopWinding === 'function') {
      ensureLoopWinding(loop, planeNormal);
      return earcutTriangulateLoop(loop, planeNormal) || [];
    }
    const tris = [];
    for (let i = 1; i < loop.length - 1; i++) {
      tris.push(loop[0], loop[i], loop[i + 1]);
    }
    return tris;
  }

  /* Draw the solid-black poché fill (used only when layer.cutHatch is
     explicitly "poche_solid"). */
  function drawSolidFill(segs, plane, parent, color) {
    const loops = chainToLoops(segs);
    if (!loops.length) return;
    const offset = plane.normal.clone().multiplyScalar(0.006);
    const cls = classifyLoops(loops, plane.normal);
    const tris = [];
    for (const oi of cls.outerIdx) {
      const holeIs = cls.holeAssign.get(oi) || [];
      const t = triangulateGroup(loops, oi, holeIs, plane.normal);
      for (const v of t) tris.push(v.clone().add(offset));
    }
    if (!tris.length) return;
    const geo = new THREE.BufferGeometry().setFromPoints(tris);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide,
      // The cut fill is a SOLID cap — it must write depth and occlude the
      // interior back-faces exposed behind the cut. With depthWrite/Test off
      // the (opaque) cap failed to hide them, so the remaining solid looked
      // see-through past the cut. The 0.006 normal offset (above) lifts the
      // cap just inside the kept half so it never z-fights the clipped edge.
      depthTest: true, depthWrite: true,
      clippingPlanes: [],
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 200;
    parent.add(mesh);
  }

  /* Paint a hatched cut fill: vector line pattern, clipped to each
     polygonal loop on the section plane. */
  function drawHatchFill(segs, plane, hatchId, parent) {
    const loops = chainToLoops(segs);
    if (!loops.length) return;
    if (window._sectionDebug) {
      console.log('[sectionDbg] drawHatchFill segs:', segs.length, 'loops:', loops.length);
      for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const c = new THREE.Vector3();
        const bbMin = new THREE.Vector3( Infinity,  Infinity,  Infinity);
        const bbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (const p of loop) { c.add(p); bbMin.min(p); bbMax.max(p); }
        c.multiplyScalar(1 / loop.length);
        const sz = bbMax.clone().sub(bbMin);
        let area2 = 0;
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length];
          area2 += new THREE.Vector3().crossVectors(a, b).dot(plane.normal);
        }
        const area = Math.abs(area2) * 0.5;
        console.log('  loop', li, 'verts:', loop.length,
          'area:', area.toFixed(3),
          'bbox:', sz.x.toFixed(2), sz.y.toFixed(2), sz.z.toFixed(2),
          'centroid:', c.x.toFixed(2), c.y.toFixed(2), c.z.toFixed(2));
      }
    }
    const n = plane.normal.clone().normalize();
    let u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    // Hatch lines sit just in front of the white base (0.003) but behind the
    // cut edge (0.001), so with depthTest on they layer correctly on the cut
    // side and the kept solid occludes them from the back.
    const lift = plane.normal.clone().multiplyScalar(0.002);

    // Paint a white base plane under the hatch first — earcut
    // triangulation with hole subtraction so cut polygons with voids
    // (atrium / opening) don't get phantom fills.
    const whiteOffset = plane.normal.clone().multiplyScalar(0.003);
    const whiteTris = [];
    const holeMaskTris = [];  // triangles for hole regions only
    const cls = classifyLoops(loops, plane.normal);
    for (const oi of cls.outerIdx) {
      const holeIs = cls.holeAssign.get(oi) || [];
      const t = triangulateGroup(loops, oi, holeIs, plane.normal);
      if (window._sectionDebug) console.log('[whiteBase] outer', oi, 'holes:', holeIs, '→ tris:', t.length);
      for (const vp of t) whiteTris.push(vp.clone().add(whiteOffset));
      // Collect hole triangles so we can mask out geometry behind the hole.
      for (const hi of holeIs) {
        const ht = triangulateLoop(loops[hi].slice(), plane.normal);
        for (const vp of ht) holeMaskTris.push(vp.clone().add(whiteOffset));
      }
    }
    if (window._sectionDebug) console.log('[whiteBase] total tris:', whiteTris.length);
    // Diagnostic: log how the loops were classified so we can see whether
    // the hole is being detected (and therefore correctly subtracted from
    // the white base).
    if (window._sectionDebug) {
      console.log('[whiteBase] loops:', loops.length, 'outers:', cls.outerIdx.length, 'holeAssign:', [...cls.holeAssign.entries()].map(([o, hs]) => `${o}:[${hs.join(',')}]`).join(' '));
    }
    if (whiteTris.length) {
      const whiteGeo = new THREE.BufferGeometry().setFromPoints(whiteTris);
      whiteGeo.computeVertexNormals();
      const whiteMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide,
        depthTest: false, depthWrite: false,
        clippingPlanes: [],
      });
      const whiteMesh = new THREE.Mesh(whiteGeo, whiteMat);
      whiteMesh.renderOrder = 200;
      parent.add(whiteMesh);
    }


    const allPoints = [];
    // Project all loops to a SHARED 2D basis so hatch covers the composite
    // (outer minus holes) cleanly. Even-odd rule excludes inner voids.
    const O = loops[0][0];
    const polys2 = loops.map(loop => loop.map(p => [
      new THREE.Vector3().subVectors(p, O).dot(u),
      new THREE.Vector3().subVectors(p, O).dot(v),
    ]));
    const overall = bbox2([].concat(...polys2));
    const gen = (AD.HatchLines && AD.HatchLines.__pattern2D)
      ? AD.HatchLines.__pattern2D(hatchId) : null;
    if (gen) {
      const raw = gen(overall);
      for (const seg of raw) {
        const [x0, y0, x1, y1] = seg;
        // Collect t-values where the segment crosses ANY loop edge.
        const ts = [0, 1];
        for (const poly of polys2) {
          for (let i = 0; i < poly.length; i++) {
            const [ax, ay] = poly[i];
            const [bx, by] = poly[(i + 1) % poly.length];
            const rx = x1 - x0, ry = y1 - y0;
            const sx = bx - ax, sy = by - ay;
            const denom = rx * sy - ry * sx;
            if (Math.abs(denom) < 1e-12) continue;
            const t = ((ax - x0) * sy - (ay - y0) * sx) / denom;
            const uu = ((ax - x0) * ry - (ay - y0) * rx) / denom;
            if (t < -1e-6 || t > 1 + 1e-6) continue;
            if (uu < -1e-6 || uu > 1 + 1e-6) continue;
            ts.push(Math.max(0, Math.min(1, t)));
          }
        }
        ts.sort((a, b) => a - b);
        for (let i = 0; i < ts.length - 1; i++) {
          const t0 = ts[i], t1 = ts[i + 1];
          if (t1 - t0 < 1e-6) continue;
          const mx = x0 + (t0 + t1) / 2 * (x1 - x0);
          const my = y0 + (t0 + t1) / 2 * (y1 - y0);
          // Even-odd inside test across all loops → excludes hole interiors.
          let inside = false;
          for (const poly of polys2) {
            if (pip(mx, my, poly)) inside = !inside;
          }
          if (inside) {
            const aP = O.clone()
              .addScaledVector(u, x0 + t0 * (x1 - x0))
              .addScaledVector(v, y0 + t0 * (y1 - y0))
              .add(lift);
            const bP = O.clone()
              .addScaledVector(u, x0 + t1 * (x1 - x0))
              .addScaledVector(v, y0 + t1 * (y1 - y0))
              .add(lift);
            allPoints.push(aP, bP);
          }
        }
      }
    }
    if (!allPoints.length) return;
    const geom = new THREE.BufferGeometry().setFromPoints(allPoints);
    // Hatch lines draw on top of the white fill.
    const mat = new THREE.LineBasicMaterial({
      color: 0x1a1a1a, depthWrite: false, depthTest: true,
    });
    const ls = new THREE.LineSegments(geom, mat);
    ls.renderOrder = 210;
    parent.add(ls);
  }

  function bbox2(poly2) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly2) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  function clip2D(seg, poly) {
    const [x0, y0, x1, y1] = seg;
    const ts = [0, 1];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const rx = x1 - x0, ry = y1 - y0;
      const sx = bx - ax, sy = by - ay;
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < 1e-12) continue;
      const t = ((ax - x0) * sy - (ay - y0) * sx) / denom;
      const u = ((ax - x0) * ry - (ay - y0) * rx) / denom;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      ts.push(Math.max(0, Math.min(1, t)));
    }
    ts.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-6) continue;
      const mx = x0 + (t0 + t1) / 2 * (x1 - x0);
      const my = y0 + (t0 + t1) / 2 * (y1 - y0);
      if (pip(mx, my, poly)) {
        out.push([
          x0 + t0 * (x1 - x0), y0 + t0 * (y1 - y0),
          x0 + t1 * (x1 - x0), y0 + t1 * (y1 - y0),
        ]);
      }
    }
    return out;
  }
  function pip(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      install();
      if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
    }, 600);
  });
})();
