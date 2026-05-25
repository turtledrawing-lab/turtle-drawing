/* ============================================================================
   AD.HatchLines — real vector-line hatches drawn on 3D faces.
   ----------------------------------------------------------------------------
   Given an object + hatch id, we iterate the object's faces, project each
   polygon to its own 2D plane, generate a 2D hatch pattern (parallel
   lines / cross-hatch / wavy / dots), clip every hatch segment against
   the polygon, and lift the surviving pieces back into 3D as
   THREE.LineSegments. The result is thin, crisp, scale-independent line
   work — exactly what an architectural section wants.

   This replaces the canvas-texture hatch preview with actual geometry.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});
  AD.HatchLines = AD.HatchLines || {};
  /* Global scale multiplier applied to every pattern's tile step. 1 =
     default; 2 = pattern features twice as large; 0.5 = denser. */
  AD.HatchLines.scale = 1.0;
  const S = () => Math.max(0.05, Math.min(20, AD.HatchLines.scale || 1.0));

  // -------------------------------------------------------------------- 2D generator
  /* Each entry returns an array of { type:'line'|'wave'|'dot',
     a:[x,y], b:[x,y], [amp,freq] } segments for a 2D tile of the given
     size. The outer function repeats the tile over the polygon's bbox. */
  const PATTERNS_2D = {
    concrete_exposed: (bbox) => {
      const segs = [];
      const rnd = seeded(bbox.minX * 1000 + bbox.minY * 100);
      const step = 0.08 * S();
      for (let y = bbox.minY; y <= bbox.maxY; y += step) {
        for (let x = bbox.minX; x <= bbox.maxX; x += step) {
          if (rnd() < 0.35) {
            const jx = x + (rnd() - 0.5) * step * 0.6;
            const jy = y + (rnd() - 0.5) * step * 0.6;
            const r = step * (0.08 + rnd() * 0.12);
            // Tiny cross (2 perpendicular strokes) to read as a dot at small sizes
            segs.push([jx - r, jy, jx + r, jy]);
            segs.push([jx, jy - r, jx, jy + r]);
          }
        }
      }
      return segs;
    },
    timber_grain: (bbox) => {
      const segs = [];
      const sc = S();
      const step = 0.035 * sc;
      const waveAmp = 0.007 * sc;
      const waveFreq = 3.0 / sc;
      const dx = 0.02 * sc;
      const rnd = seeded(bbox.minX * 17 + bbox.minY * 31);
      for (let y = bbox.minY; y <= bbox.maxY; y += step) {
        const phase = rnd() * Math.PI * 2;
        let prev = null;
        for (let x = bbox.minX; x <= bbox.maxX; x += dx) {
          const yy = y + Math.sin(x * waveFreq + phase) * waveAmp;
          if (prev) segs.push([prev[0], prev[1], x, yy]);
          prev = [x, yy];
        }
      }
      return segs;
    },
    insulation_rigid: (bbox) => {
      const segs = [];
      const sc = S();
      const period = 0.08 * sc, amp = 0.03 * sc, step = 0.1 * sc;
      for (let y = bbox.minY; y <= bbox.maxY; y += step) {
        let prev = null;
        for (let x = bbox.minX; x <= bbox.maxX; x += period / 10) {
          const yy = y + Math.sin((x - bbox.minX) / period * Math.PI * 2) * amp;
          if (prev) segs.push([prev[0], prev[1], x, yy]);
          prev = [x, yy];
        }
      }
      return segs;
    },
    brick: (bbox) => {
      const segs = [];
      const sc = S();
      const h = 0.08 * sc, w = 0.2 * sc;
      for (let y = bbox.minY; y <= bbox.maxY; y += h) {
        segs.push([bbox.minX, y, bbox.maxX, y]);
      }
      let row = 0;
      for (let y = bbox.minY; y <= bbox.maxY; y += h) {
        const off = (row % 2) * (w / 2);
        for (let x = bbox.minX + off; x <= bbox.maxX; x += w) {
          segs.push([x, y, x, y + h]);
        }
        row++;
      }
      return segs;
    },
    tile: (bbox) => {
      const segs = [];
      const s = 0.1 * S();
      for (let y = bbox.minY; y <= bbox.maxY; y += s) segs.push([bbox.minX, y, bbox.maxX, y]);
      for (let x = bbox.minX; x <= bbox.maxX; x += s) segs.push([x, bbox.minY, x, bbox.maxY]);
      return segs;
    },
    gravel: (bbox) => {
      const segs = [];
      const rnd = seeded(bbox.minX * 7 + bbox.minY * 13);
      const step = 0.1 * S();
      for (let y = bbox.minY; y <= bbox.maxY; y += step) {
        for (let x = bbox.minX; x <= bbox.maxX; x += step) {
          if (rnd() < 0.85) {
            const jx = x + (rnd() - 0.5) * step * 0.4;
            const jy = y + (rnd() - 0.5) * step * 0.4;
            const r = step * (0.25 + rnd() * 0.18);
            const N = 8;
            for (let i = 0; i < N; i++) {
              const a1 = (i / N) * Math.PI * 2;
              const a2 = ((i + 1) / N) * Math.PI * 2;
              segs.push([jx + Math.cos(a1)*r, jy + Math.sin(a1)*r,
                         jx + Math.cos(a2)*r, jy + Math.sin(a2)*r]);
            }
          }
        }
      }
      return segs;
    },
    earth: (bbox) => {
      const segs = [];
      const sc = S();
      const step = 0.08 * sc, tooth = 0.05 * sc;
      for (let y = bbox.minY; y <= bbox.maxY; y += step) {
        let prev = [bbox.minX, y];
        let up = true;
        for (let x = bbox.minX + tooth; x <= bbox.maxX; x += tooth) {
          const yy = up ? y : y - tooth;
          segs.push([prev[0], prev[1], x, yy]);
          prev = [x, yy];
          up = !up;
        }
      }
      return segs;
    },
    metal: (bbox) => {
      const segs = [];
      const spacing = 0.06 * S();
      const diag = (bbox.maxX - bbox.minX) + (bbox.maxY - bbox.minY);
      for (let k = -diag; k < diag; k += spacing) {
        const x0 = bbox.minX + k,       y0 = bbox.minY;
        const x1 = bbox.minX + k + diag, y1 = bbox.minY + diag;
        segs.push([x0, y0, x1, y1]);
      }
      return segs;
    },
    poche_solid: (bbox) => {
      const segs = [];
      const spacing = 0.015 * S();
      for (let y = bbox.minY; y <= bbox.maxY; y += spacing) {
        segs.push([bbox.minX, y, bbox.maxX, y]);
      }
      return segs;
    },
  };

  function seeded(seed) {
    let s = Math.abs(Math.floor(seed * 100)) % 2147483647;
    return () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
  }

  // -------------------------------------------------------------------- polygon clipping
  /* Clip a 2D segment against a polygon. Uses the Sutherland–Hodgman idea
     inverted — we keep only the portion of the line inside the polygon.
     Returns a list of [p0, p1] sub-segments. */
  function clipSegmentToPolygon(seg, poly) {
    const [x0, y0, x1, y1] = seg;
    // Find all intersections of seg with polygon edges, plus endpoint
    // inside-ness. Sort params along the segment and keep "inside" runs.
    const ts = [0, 1];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const t = segSegParam(x0, y0, x1, y1, ax, ay, bx, by);
      if (t != null) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-6) continue;
      const mx = x0 + (t0 + t1) / 2 * (x1 - x0);
      const my = y0 + (t0 + t1) / 2 * (y1 - y0);
      if (pointInPoly(mx, my, poly)) {
        out.push([
          x0 + t0 * (x1 - x0), y0 + t0 * (y1 - y0),
          x0 + t1 * (x1 - x0), y0 + t1 * (y1 - y0),
        ]);
      }
    }
    return out;
  }
  function segSegParam(ax, ay, bx, by, cx, cy, dx, dy) {
    // Return t (0..1) along A→B where it meets segment C→D, or null.
    const rx = bx - ax, ry = by - ay;
    const sx = dx - cx, sy = dy - cy;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
    if (t < -1e-6 || t > 1 + 1e-6) return null;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    return Math.max(0, Math.min(1, t));
  }
  function pointInPoly(x, y, poly) {
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

  // -------------------------------------------------------------------- per-face line build
  /* For a face (em + face index), produce LineSegments in object space
     that tile the face with the given hatch. */
  function buildFaceHatchSegments(em, face, hatchId) {
    if (!PATTERNS_2D[hatchId]) return [];
    const verts3D = face.verts.map(i => em.vertices[i]);
    if (verts3D.length < 3) return [];
    // Build an orthonormal basis on the face plane.
    const n = face.normal.clone().normalize();
    let u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const O = verts3D[0];
    const to2 = (p) => {
      const d = new THREE.Vector3().subVectors(p, O);
      return [d.dot(u), d.dot(v)];
    };
    const poly2 = verts3D.map(to2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly2) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    // Pad bbox slightly for pattern to fully cover.
    const pad = 0.02;
    const bbox = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    const raw = PATTERNS_2D[hatchId](bbox);
    const out = [];
    for (const seg of raw) {
      const clipped = clipSegmentToPolygon(seg, poly2);
      for (const c of clipped) {
        // Lift to 3D with a tiny normal offset so the line sits above
        // the face and doesn't z-fight.
        const lift = 0.001;
        const aP = O.clone()
          .addScaledVector(u, c[0]).addScaledVector(v, c[1])
          .addScaledVector(n, lift);
        const bP = O.clone()
          .addScaledVector(u, c[2]).addScaledVector(v, c[3])
          .addScaledVector(n, lift);
        out.push(aP, bP);
      }
    }
    return out;
  }

  AD.HatchLines.apply = function (obj, hatchId) {
    if (!obj || !obj.em) return;
    // Remove previous hatch overlay if any.
    if (obj._hatchOverlay) {
      obj.group.remove(obj._hatchOverlay);
      obj._hatchOverlay.geometry.dispose();
      obj._hatchOverlay.material.dispose();
      obj._hatchOverlay = null;
    }
    if (!hatchId) return;
    const points = [];
    for (const f of obj.em.faces) {
      const segs = buildFaceHatchSegments(obj.em, f, hatchId);
      for (const p of segs) points.push(p);
    }
    if (!points.length) return;
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat  = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
    const ls   = new THREE.LineSegments(geom, mat);
    ls.renderOrder = 2;
    obj.group.add(ls);
    obj._hatchOverlay = ls;
  };

  /* Expose the private 2D generator so AD.SectionStyle can reuse it for
     cut-fill hatching. */
  AD.HatchLines.__pattern2D = function (hatchId) {
    return PATTERNS_2D[hatchId] || null;
  };

  /* Render a 2D tile of the given pattern into an inline SVG string for
     use in the panel's swatch grid. This reuses the exact same generator
     the 3D overlay uses, so the swatch matches the final line output. */
  AD.HatchLines.swatchSVG = function (hatchId, size = 48) {
    const gen = PATTERNS_2D[hatchId];
    if (!gen) return '';
    const bbox = { minX: 0, minY: 0, maxX: 0.6, maxY: 0.6 };
    const segs = gen(bbox);
    const s = size;
    const scaleX = s / (bbox.maxX - bbox.minX);
    const scaleY = s / (bbox.maxY - bbox.minY);
    let paths = '';
    for (const [x0, y0, x1, y1] of segs) {
      // Clip trivially to bbox
      if (x0 < bbox.minX && x1 < bbox.minX) continue;
      if (x0 > bbox.maxX && x1 > bbox.maxX) continue;
      if (y0 < bbox.minY && y1 < bbox.minY) continue;
      if (y0 > bbox.maxY && y1 > bbox.maxY) continue;
      const ax = (x0 - bbox.minX) * scaleX, ay = (y0 - bbox.minY) * scaleY;
      const bx = (x1 - bbox.minX) * scaleX, by = (y1 - bbox.minY) * scaleY;
      paths += `<line x1="${ax.toFixed(2)}" y1="${ay.toFixed(2)}" x2="${bx.toFixed(2)}" y2="${by.toFixed(2)}"/>`;
    }
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'
                 viewBox='0 0 ${s} ${s}' style='display:block'>
              <rect width='${s}' height='${s}' fill='#ffffff'/>
              <g stroke='#1a1a1a' stroke-width='0.6' stroke-linecap='round'>${paths}</g>
            </svg>`;
  };

  /* Called after an object's geometry changes (e.g. push/pull) to
     regenerate line hatch for already-tagged objects. */
  AD.HatchLines.refresh = function (obj) {
    const id = obj && obj.ad && (obj.ad.material ||
      (obj.ad.hatchAt && Array.from(obj.ad.hatchAt.values())[0]));
    if (id) AD.HatchLines.apply(obj, id);
  };
})();
