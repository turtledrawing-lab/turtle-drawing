/* ============================================================================
   AD.Export — 2D vector export (SVG / PDF / DXF).
   ----------------------------------------------------------------------------
   Projects the current 3D view to 2D primitives (edges + hatch fills) and
   emits them in three formats:
     • SVG  — native vector, opens in Illustrator / CAD / browser
     • PDF  — universal, via pdf-lib loaded from CDN
     • DXF  — CAD ASCII format, LAYER-aware
   The same 2D scene graph feeds all three, so line weights / layers /
   hatches are preserved across formats.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});
  AD.Export = AD.Export || {};

  /* ---------- Build the 2D scene graph ---------------------------------- */
  AD.Export.buildScene2D = function (opts) {
    opts = opts || {};
    const W = opts.width  || renderer.domElement.clientWidth;
    const H = opts.height || renderer.domElement.clientHeight;
    const proj = (v) => {
      const p = v.clone().project(camera);
      return {
        x: (p.x + 1) * 0.5 * W,
        y: (1 - p.y) * 0.5 * H,
        z: p.z,
        ok: p.z > -1 && p.z < 1,
      };
    };
    let   edges = [];
    const fills = [];
    const baseW = (AD.Layers && AD.Layers.BASE_WEIGHT) || 0.20;

    // WYSIWYG mode: walk the live Three.js scene under the user's model
    // roots and project every rendered line to 2D. This matches the
    // viewport exactly — thick cut edges, surface hatch, cut hatch,
    // white fills — without the "smart" HLR / seam / distance
    // post-processing that was making the result look inconsistent.
    const activePlanes = (Model.sectionPlanes || []).filter(sp => sp.enabled);
    const EPS = 1e-4;

    const clipSeg3 = (a, b) => {
      let aC = a.clone(), bC = b.clone();
      for (const sp of activePlanes) {
        const da = sp.plane.distanceToPoint(aC);
        const db = sp.plane.distanceToPoint(bC);
        if (da >= -EPS && db >= -EPS) continue;
        if (da <= EPS && db <= EPS) return null;
        const t = da / (da - db);
        const hit = new THREE.Vector3().lerpVectors(aC, bC, t);
        if (da < 0) aC = hit; else bC = hit;
      }
      return [aC, bC];
    };

    const colourOf = (mat) => {
      if (!mat || !mat.color) return '#2a2a2a';
      return '#' + mat.color.getHexString();
    };
    const weightOf = (mat) => {
      if (mat && mat.isLineMaterial && typeof mat.linewidth === 'number') {
        // LineMaterial.linewidth is in screen pixels; convert to mm
        // (~0.25 mm/px at 96 dpi). This preserves the per-layer cut
        // weights set by AD.SectionStyle.
        return Math.max(0.05, mat.linewidth * 0.25);
      }
      return baseW;
    };

    // ---- Hidden-line test so the export reads as a hidden-line view,
    //      not a wireframe. Any edge whose midpoint sits behind another
    //      object's solid face (from the camera) is dropped. Tolerance
    //      scales with the scene size so long-range edges don't get
    //      falsely culled by floating-point noise. Cut edges are
    //      exempt — they live on the section plane and should always
    //      draw.
    /* ============================================================
       Pixel-based HLR: render the live scene normally (faces + lines
       with their usual depth-test) into an offscreen canvas, then for
       each geometric edge we check if it's actually drawn in that
       image. This sidesteps every float-tolerance question because
       it uses Three.js's own z-buffer output — what the viewport
       shows IS what gets exported.
       ============================================================ */
    let viewPixels = null;
    let viewW = 0, viewH = 0;
    try {
      const _dpr2 = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
      viewW = Math.max(256, Math.floor(W * _dpr2));
      viewH = Math.max(256, Math.floor(H * _dpr2));
      const target2 = new THREE.WebGLRenderTarget(viewW, viewH, {
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      const savedTarget = renderer.getRenderTarget();
      const savedClear = renderer.getClearColor(new THREE.Color());
      const savedAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(target2);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(savedTarget);
      renderer.setClearColor(savedClear, savedAlpha);
      viewPixels = new Uint8Array(viewW * viewH * 4);
      renderer.readRenderTargetPixels(target2, 0, 0, viewW, viewH, viewPixels);
      target2.dispose();
      // ---- DEBUG: dump the HLR reference image to a floating panel so
      //      we can visually confirm it looks like a correct hidden-line
      //      view (if it looks like wireframe, LineMaterial's depth
      //      testing is the real culprit).
      try {
        const dbg = document.createElement('canvas');
        dbg.width = viewW; dbg.height = viewH;
        const ctx = dbg.getContext('2d');
        const img = ctx.createImageData(viewW, viewH);
        // Flip Y because readRenderTargetPixels returns bottom-up.
        for (let y = 0; y < viewH; y++) {
          const srcRow = (viewH - 1 - y) * viewW * 4;
          const dstRow = y * viewW * 4;
          for (let x = 0; x < viewW * 4; x++) {
            img.data[dstRow + x] = viewPixels[srcRow + x];
          }
        }
        ctx.putImageData(img, 0, 0);
        const url = dbg.toDataURL('image/png');
        let panel = document.getElementById('_adHlrDebug');
        if (!panel) {
          panel = document.createElement('div');
          panel.id = '_adHlrDebug';
          panel.style.cssText =
            'position:fixed;right:8px;bottom:8px;z-index:10000;' +
            'width:240px;border:1px solid #333;background:#fff;' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.25);padding:4px;' +
            'font:10px -apple-system,sans-serif;';
          panel.innerHTML =
            '<div style="display:flex;justify-content:space-between;padding:2px 4px;">'
            + '<span>HLR reference</span><span id="_adHlrClose" style="cursor:pointer;color:#888;">×</span></div>'
            + '<img id="_adHlrImg" style="width:100%;display:block;border:0.5px solid #aaa;">';
          document.body.appendChild(panel);
          panel.querySelector('#_adHlrClose').onclick = () => panel.remove();
        }
        panel.querySelector('#_adHlrImg').src = url;
      } catch (_) {}
    } catch (err) {
      console.warn('[export] pixel HLR pass failed', err);
      viewPixels = null;
    }
    /* Is a screen-space pixel "dark" (likely a line stroke or deep
       shade)?  Anything with an average channel below 200 passes. */
    const pixelIsDark = (px, py) => {
      if (!viewPixels) return true;
      const dpr = (renderer.getPixelRatio ? renderer.getPixelRatio() : 1);
      const x = Math.max(0, Math.min(viewW - 1, Math.round(px * dpr)));
      const y = Math.max(0, Math.min(viewH - 1, viewH - 1 - Math.round(py * dpr)));
      const idx = (y * viewW + x) * 4;
      const avg = (viewPixels[idx] + viewPixels[idx + 1] + viewPixels[idx + 2]) / 3;
      return avg < 210;
    };
    /* Is the 2D edge (in screen px coords) actually painted on the
       rendered canvas?  Sample along the line at 1-pixel steps; an
       edge counts as "visible" if ≥ 25 % of its samples match a dark
       viewport pixel. */
    const is2DEdgeVisible = (x1, y1, x2, y2) => {
      if (!viewPixels) return true;            // fallback to raycast later
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) return true;
      const steps = Math.ceil(len);
      let hits = 0, samples = 0;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = x1 + dx * t, py = y1 + dy * t;
        // Check 3 x 3 neighbourhood to tolerate antialiased strokes.
        let localHit = false;
        for (let oy = -1; oy <= 1 && !localHit; oy++) {
          for (let ox = -1; ox <= 1 && !localHit; ox++) {
            if (pixelIsDark(px + ox, py + oy)) localHit = true;
          }
        }
        samples++;
        if (localHit) hits++;
      }
      return samples > 0 && (hits / samples) >= 0.25;
    };

    /* ============================================================
       GPU depth buffer HLR — the authoritative approach.
       ------------------------------------------------------------
       Render all solid meshes to an off-screen depth target using
       MeshDepthMaterial (RGBA-packed depth). Then for each edge
       sample we project to screen, read the depth buffer at that
       pixel, and compare with the edge's own NDC-z. If the scene
       in front of the edge is closer → edge hidden. This mirrors
       exactly what the GPU does when rendering the viewport.
       ============================================================ */
    const _dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const depthW = Math.max(64, Math.floor(W * _dpr));
    const depthH = Math.max(64, Math.floor(H * _dpr));
    let depthPixels = null;
    try {
      const target = new THREE.WebGLRenderTarget(depthW, depthH, {
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      // Build the clip-plane list BEFORE creating the depth material so
      // we can attach it to the material directly. MeshDepthMaterial
      // doesn't automatically honour renderer.clippingPlanes when used
      // as scene.overrideMaterial — it needs its own copy.
      const clipList = activePlanes.map(sp => sp.plane);
      const depthMat = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        side: THREE.DoubleSide,
      });
      if (clipList.length) {
        depthMat.clippingPlanes = clipList;
        depthMat.clipShadows = true;
      }
      // Hide everything that isn't an opaque solid — lines / sprites /
      // helper geometry should NOT write depth.
      const savedVis = [];
      const solidMeshes = new Set(occMeshes);
      scene.traverse(node => {
        if (!node.visible) return;
        const isSolid = solidMeshes.has(node);
        if (isSolid) return;
        // Keep intermediate groups visible; only hide leaves we don't want.
        if (node.isMesh || node.isLine || node.isLineSegments ||
            node.isLineSegments2 || node.isSprite || node.isPoints) {
          savedVis.push(node);
          node.visible = false;
        }
      });
      const savedOverride = scene.overrideMaterial;
      const savedClipEnabled = renderer.localClippingEnabled;
      const savedClippingPlanes = renderer.clippingPlanes;
      const savedClearColor = renderer.getClearColor(new THREE.Color());
      const savedClearAlpha = renderer.getClearAlpha();
      scene.overrideMaterial = depthMat;
      renderer.localClippingEnabled = true;
      renderer.clippingPlanes = clipList;
      const savedTarget = renderer.getRenderTarget();
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(savedTarget);
      // Restore state before we early-out to readPixels.
      renderer.clippingPlanes = savedClippingPlanes;
      renderer.localClippingEnabled = savedClipEnabled;
      renderer.setClearColor(savedClearColor, savedClearAlpha);
      scene.overrideMaterial = savedOverride;
      for (const n of savedVis) n.visible = true;
      depthPixels = new Uint8Array(depthW * depthH * 4);
      renderer.readRenderTargetPixels(target, 0, 0, depthW, depthH, depthPixels);
      // Sanity check — if the entire buffer is "far" (white pixels =
      // nothing rendered), the depth pass silently failed. In that case
      // fall back to raycast so we don't mistakenly mark every edge
      // as visible.
      let hasDepth = false;
      for (let i = 0; i < depthPixels.length; i += 1024) {
        if (depthPixels[i] < 250 || depthPixels[i + 1] < 250 ||
            depthPixels[i + 2] < 250 || depthPixels[i + 3] < 250) {
          hasDepth = true; break;
        }
      }
      if (!hasDepth) {
        console.warn('[export] depth pass returned empty — falling back to raycast');
        depthPixels = null;
      } else if (typeof setStatus === 'function') {
        setStatus('msg', 'HLR: GPU depth buffer active.');
      }
      target.dispose();
      depthMat.dispose();
    } catch (err) {
      console.warn('[export] depth pass failed, using raycast fallback', err);
      depthPixels = null;
    }

    const unpackDepth = (r, g, b, a) =>
      r / Math.pow(256, 4) + g / Math.pow(256, 3) +
      b / Math.pow(256, 2) + a / 256;
    const depthAt = (px, py) => {
      if (!depthPixels) return null;
      const x = Math.max(0, Math.min(depthW - 1, Math.round(px * _dpr)));
      const yFlip = Math.max(0, Math.min(depthH - 1, depthH - 1 - Math.round(py * _dpr)));
      const idx = (yFlip * depthW + x) * 4;
      return unpackDepth(
        depthPixels[idx], depthPixels[idx + 1],
        depthPixels[idx + 2], depthPixels[idx + 3]
      );
    };

    const occRay = new THREE.Raycaster();
    // Exclude transparent (glass, water) surfaces — they don't occlude
    // in the viewport and shouldn't here either.
    const occMeshes = Model.objects
      .filter(o => o.group && o.group.visible && o.em && o.em.faces.length)
      .filter(o => !o.mat || !o.mat.transparent || (o.mat.opacity || 0) > 0.9)
      .map(o => {
        o.mesh.updateMatrixWorld(true);
        // Raycaster needs fresh bounding volumes when geometry changes.
        try {
          o.mesh.geometry.computeBoundingBox();
          o.mesh.geometry.computeBoundingSphere();
        } catch (_) {}
        return o.mesh;
      });
    const camPos = camera.position.clone();
    const _sceneBBox = new THREE.Box3();
    for (const o of Model.objects) {
      if (!o.group || !o.group.visible || !o.em) continue;
      for (const v of o.em.vertices) _sceneBBox.expandByPoint(v);
    }
    const sceneDiag = _sceneBBox.isEmpty()
      ? 10 : _sceneBBox.getSize(new THREE.Vector3()).length();
    // Tight absolute tolerance — previously scaled with scene diagonal
    // which made hlrEps too large on bigger models (e.g. 60 mm for a
    // 20 m building), keeping both front and back edges of every wall.
    // 1 mm is small enough to cull back faces but forgiving of the
    // usual float-precision noise at face boundaries.
    const hlrEps = 0.001;
    /* Sample THREE points along each edge (0.2, 0.5, 0.8) — an edge is
       "visible" only if at least one sample is unobstructed. This is
       more robust than a single midpoint test: long edges that are
       mostly hidden but peek out at a corner still get drawn; edges
       buried behind a solid are reliably dropped. */
    const isSampleVisible = (p3) => {
      // Primary: GPU depth buffer comparison. Pixel-accurate, matches
      // exactly what Three.js z-tests during viewport rendering.
      if (depthPixels) {
        const projVec = p3.clone().project(camera);
        if (projVec.z < -1 || projVec.z > 1) return true;
        const sx = (projVec.x + 1) * 0.5 * W;
        const sy = (1 - projVec.y) * 0.5 * H;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) return true;
        const edgeDepth = (projVec.z + 1) * 0.5;  // NDC → [0,1]
        const sceneDepth = depthAt(sx, sy);
        if (sceneDepth == null) return true;
        if (sceneDepth >= 0.9999) return true;     // nothing rendered
        return edgeDepth <= sceneDepth + 0.0008;   // small bias for self-hit
      }
      // Raycast fallback.
      const dir = new THREE.Vector3().subVectors(p3, camPos);
      const dist = dir.length();
      if (dist < 1e-4) return true;
      dir.normalize();
      occRay.set(camPos, dir);
      occRay.far = dist + 1;
      const hits = occRay.intersectObjects(occMeshes, false);
      if (!hits || hits.length === 0) return true;
      for (const h of hits) {
        let hiddenByClip = false;
        for (const sp of activePlanes) {
          if (sp.plane.distanceToPoint(h.point) < -EPS) { hiddenByClip = true; break; }
        }
        if (hiddenByClip) continue;
        const tol = Math.max(hlrEps, dist * 0.0005);
        return h.distance > dist - tol;
      }
      return true;
    };
    const isVisibleAgainstSolid = (a3, b3) => {
      const dir = new THREE.Vector3().subVectors(b3, a3);
      for (const t of [0.2, 0.5, 0.8]) {
        const p = new THREE.Vector3().copy(a3).addScaledVector(dir, t);
        if (isSampleVisible(p)) return true;
      }
      return false;
    };

    /* Point-in-polygon helper shared with the cut-mask below. */
    const _pip2 = (x, y, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        if (((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    };

    const pushLineSeg = (a3, b3, mat, layer, kind) => {
      const clipped = clipSeg3(a3, b3);
      if (!clipped) return;
      const pa = proj(clipped[0]);
      const pb = proj(clipped[1]);
      if (!pa.ok && !pb.ok) return;
      // Hidden-line removal for non-cut edges:
      //   1. Pixel-overlap test against the rendered viewport buffer.
      //   2. Fallback: raycast HLR.
      if (kind !== 'cut') {
        if (viewPixels) {
          if (!is2DEdgeVisible(pa.x, pa.y, pb.x, pb.y)) return;
        } else if (!isVisibleAgainstSolid(clipped[0], clipped[1])) {
          return;
        }
      }
      edges.push({
        x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
        weight: weightOf(mat),
        color: colourOf(mat),
        layer: layer || 'Default',
        kind: kind || 'visible',
      });
    };

    const resolveLayer = (node) => {
      let p = node;
      while (p) {
        if (p.userData && p.userData.sketchObject && p.userData.sketchObject.layerId) {
          return p.userData.sketchObject.layerId;
        }
        p = p.parent;
      }
      return 'Default';
    };
    const isExcluded = (node) => {
      // Skip section-plane helper visuals, tool helpers, ground shadow,
      // grid, axes — these aren't part of the drawing.
      let p = node;
      while (p) {
        const n = p.name || '';
        if (p === (typeof sectionRoot !== 'undefined' ? sectionRoot : null)) return true;
        if (p === (typeof helperRoot !== 'undefined' ? helperRoot : null)) return true;
        if (n === 'grid' || n === 'axes' || n === 'gridGroup' || n === 'axesHelper') return true;
        p = p.parent;
      }
      return false;
    };

    const worldA = new THREE.Vector3();
    const worldB = new THREE.Vector3();

    /* ============================================================
       Edge source 1: user model via EditableMesh directly.
       ------------------------------------------------------------
       Building edges from EM data gives us FACE ADJACENCY — each
       edge knows which faces border it, so we can:
         (a) drop back-only edges immediately (huge purge),
         (b) keep silhouette + front-facing edges,
         (c) finally HLR-test the survivors against other solids.
       This is much stronger than pulling LineSegments2 blindly
       from the scene graph, which has no face orientation info.
       ============================================================ */
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);

    for (const o of Model.objects) {
      if (!o.group || !o.group.visible) continue;
      if (!o.em || !o.em.faces.length) continue;
      const layer = o.layerId || 'Default';
      const weight = (AD.Layers && AD.Layers.BASE_WEIGHT) || 0.20;

      // Force fresh face normals — stale normals (left behind by a
      // Move / Push-Pull that modified the mesh) would break the
      // back-face classification below.
      for (const f of o.em.faces) o.em.computeFaceNormal(f);

      // Build edge → face list map.
      const edgeMap = new Map();
      for (const f of o.em.faces) {
        const vs = f.verts;
        for (let i = 0; i < vs.length; i++) {
          const a = vs[i], b = vs[(i + 1) % vs.length];
          const k = a < b ? a + ':' + b : b + ':' + a;
          if (!edgeMap.has(k)) edgeMap.set(k, { a, b, faces: [] });
          edgeMap.get(k).faces.push(f);
        }
      }
      for (const [, info] of edgeMap) {
        // Face-side analysis:
        //   frontCount = number of adjacent faces whose normal faces
        //                the camera
        //   backCount  = faces whose normal points away
        // An edge is RELEVANT when:
        //   • frontCount ≥ 1 AND backCount ≥ 1 → SILHOUETTE, keep
        //   • frontCount = adjacent count      → interior front crease;
        //     keep ONLY if at least one neighbouring face is actually
        //     visible (we defer this to the raycast)
        //   • backCount = adjacent count       → hidden; drop
        let frontCount = 0, backCount = 0;
        for (const f of info.faces) {
          const d = f.normal.dot(camDir);
          if (d < -1e-4) frontCount++;
          else if (d > 1e-4) backCount++;
        }
        if (frontCount === 0) continue;       // all back → cull
        const a3 = o.em.vertices[info.a];
        const b3 = o.em.vertices[info.b];
        if (!a3 || !b3) continue;
        pushLineSeg(a3, b3, {
          color: { getHexString: () => '1a1a1a' },
          isLineMaterial: true,
          linewidth: weight / 0.25 * 1.1,
        }, layer, 'visible');
      }
    }

    /* Edge source 2: section cut visuals (thick cut edges, hatch
       lines, white fills). These already come out right in the
       scene graph — just pull them and tag as 'cut' so HLR skips. */
    if (typeof sectionFillRoot !== 'undefined') {
      sectionFillRoot.traverse(node => {
        if (!node.visible) return;
        const mat = node.material;
        const layer = resolveLayer(node);

        if (node.isLineSegments2 ||
            (node.geometry && node.geometry.isLineSegmentsGeometry)) {
          const geo = node.geometry;
          const starts = geo.attributes.instanceStart;
          const ends   = geo.attributes.instanceEnd;
          if (!starts || !ends) return;
          node.updateMatrixWorld(true);
          const m = node.matrixWorld;
          for (let i = 0; i < starts.count; i++) {
            worldA.set(starts.getX(i), starts.getY(i), starts.getZ(i)).applyMatrix4(m);
            worldB.set(ends.getX(i),   ends.getY(i),   ends.getZ(i)  ).applyMatrix4(m);
            pushLineSeg(worldA, worldB, mat, layer, 'cut');
          }
          return;
        }
        if (node.isLineSegments) {
          const pos = node.geometry && node.geometry.attributes.position;
          if (!pos) return;
          node.updateMatrixWorld(true);
          const m = node.matrixWorld;
          for (let i = 0; i < pos.count; i += 2) {
            worldA.fromBufferAttribute(pos, i).applyMatrix4(m);
            worldB.fromBufferAttribute(pos, i + 1).applyMatrix4(m);
            pushLineSeg(worldA, worldB, mat, layer, 'cut');
          }
          return;
        }
        // White cut-fill meshes (for the SVG/PDF fill underlay).
        if (node.isMesh && mat && mat.color) {
          const c = mat.color;
          const isWhite = c.r > 0.98 && c.g > 0.98 && c.b > 0.98;
          if (!isWhite) return;
          const pos = node.geometry && node.geometry.attributes.position;
          if (!pos) return;
          node.updateMatrixWorld(true);
          const m = node.matrixWorld;
          for (let i = 0; i < pos.count; i += 3) {
            const tri = [];
            let anyOk = false;
            for (let k = 0; k < 3; k++) {
              worldA.fromBufferAttribute(pos, i + k).applyMatrix4(m);
              const p = proj(worldA);
              if (p.ok) anyOk = true;
              tri.push([p.x, p.y]);
            }
            if (!anyOk) continue;
            fills.push({ poly: tri, hatch: null, layer });
          }
          return;
        }
      });
    }

    // ---- Cut-mask pass: drop every NON-cut edge that lies inside an
    //      active cut polygon. The cut area is owned by its hatch
    //      lines only; all other model edges get masked out so the
    //      section read is clean. ------------------------------------
    if (fills.length && edges.length) {
      // Pre-compute cut polygon screen bounding boxes for fast reject.
      const fbbs = fills.map(f => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of f.poly) {
          if (x < minX) minX = x; if (y < minY) minY = y;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        return { minX, minY, maxX, maxY, poly: f.poly };
      });
      const inAnyCut = (x, y) => {
        for (const f of fbbs) {
          if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
          if (_pip2(x, y, f.poly)) return true;
        }
        return false;
      };
      edges = edges.filter(e => {
        if (e.kind === 'cut') return true;
        // If both endpoints AND the midpoint are inside the cut mask,
        // drop the edge. This preserves edges that merely cross the
        // cut silhouette (those meet the cut boundary legitimately).
        const mx = (e.x1 + e.x2) / 2;
        const my = (e.y1 + e.y2) / 2;
        if (inAnyCut(e.x1, e.y1) && inAnyCut(e.x2, e.y2) && inAnyCut(mx, my)) {
          return false;
        }
        return true;
      });
    }

    // Compute a tight bounding box around everything, with padding.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of edges) {
      minX = Math.min(minX, e.x1, e.x2); minY = Math.min(minY, e.y1, e.y2);
      maxX = Math.max(maxX, e.x1, e.x2); maxY = Math.max(maxY, e.y1, e.y2);
    }
    for (const f of fills) {
      for (const [x, y] of f.poly) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    /* ---- Dimension annotations: project to 2D for SVG/DXF emitters ----- */
    const dims = [];
    for (const dim of (Model.dimensions || [])) {
      // Skip dims on hidden layers (matches viewport behavior)
      if (dim.layerId && typeof getLayer === 'function') {
        const L = getLayer(dim.layerId);
        if (L && L.visible === false) continue;
      }
      const ov = dim.offsetVec || new THREE.Vector3();
      const pa = proj(dim.a), pb = proj(dim.b);
      const da = proj(dim.a.clone().add(ov)), db = proj(dim.b.clone().add(ov));
      if (!pa.ok || !pb.ok || !da.ok || !db.ok) continue;
      const dist = dim.a.distanceTo(dim.b);
      const text = (dim.textOverride != null && dim.textOverride !== '')
        ? String(dim.textOverride)
        : (typeof Units !== 'undefined' && Units.formatDim ? Units.formatDim(dist) : (dist * 1000).toFixed(0));
      dims.push({
        a: { x: pa.x, y: pa.y },
        b: { x: pb.x, y: pb.y },
        da: { x: da.x, y: da.y },
        db: { x: db.x, y: db.y },
        text,
        layer: dim.layerId || 'Layer0',
        // expand bbox below using these
      });
      // expand viewport bbox so dim is fully visible in the SVG/PDF output
      for (const p of [pa, pb, da, db]) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = W; maxY = H; }
    const pad = 20;
    return {
      width: W, height: H,
      viewBox: [minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2],
      edges, fills, dims,
    };
  };

  /* ---------- SVG emitter ----------------------------------------------- */
  AD.Export.toSVG = function (s2d) {
    const vb = s2d.viewBox;
    const defs = (window.AD && AD.Hatch && AD.Hatch.defsMarkup) ? AD.Hatch.defsMarkup() : '<defs></defs>';
    const byLayer = new Map();
    for (const e of s2d.edges) {
      if (!byLayer.has(e.layer)) byLayer.set(e.layer, { fills: [], edges: [] });
      byLayer.get(e.layer).edges.push(e);
    }
    for (const f of s2d.fills) {
      if (!byLayer.has(f.layer)) byLayer.set(f.layer, { fills: [], edges: [] });
      byLayer.get(f.layer).fills.push(f);
    }
    const patMap = {
      concrete_exposed: 'h_concrete', timber_grain: 'h_timber',
      insulation_rigid: 'h_insul', brick: 'h_brick', tile: 'h_tile',
      gravel: 'h_gravel', earth: 'h_earth', metal: 'h_metal', poche_solid: 'h_poche',
      stone_rubble: 'h_stone', concrete_block: 'h_cmu', plaster: 'h_plaster',
      plywood: 'h_plywood', sand: 'h_sand', glass: 'h_glass', water: 'h_water',
      crosshatch_45: 'h_xhatch', diagonal_45: 'h_diag',
      horizontal_lines: 'h_horiz', vertical_lines: 'h_vert', roof_tile: 'h_roof',
    };
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    out += `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `;
    out += `viewBox="${vb[0].toFixed(2)} ${vb[1].toFixed(2)} ${vb[2].toFixed(2)} ${vb[3].toFixed(2)}" `;
    out += `width="${vb[2].toFixed(2)}" height="${vb[3].toFixed(2)}">`;
    out += defs;
    // Three-pass paint order so cut areas always read as "hatch only":
    //   1) Non-cut (elevation) edges
    //   2) White cut-fills (masks any elevation edge inside the cut)
    //   3) Cut edges + hatch lines on top
    const emitLine = (e) => {
      const sw = Math.max(0.05, e.weight).toFixed(3);
      return `<line x1="${e.x1.toFixed(2)}" y1="${e.y1.toFixed(2)}" `
           + `x2="${e.x2.toFixed(2)}" y2="${e.y2.toFixed(2)}" `
           + `stroke="${e.color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    };
    out += `<g id="elevation">`;
    for (const [, g] of byLayer) {
      for (const e of g.edges) {
        if (e.kind !== 'cut') out += emitLine(e);
      }
    }
    out += '</g>';
    out += `<g id="cut-fill">`;
    for (const [, g] of byLayer) {
      for (const f of g.fills) {
        const pts = f.poly.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
        out += `<polygon points="${pts}" fill="#ffffff" stroke="none"/>`;
      }
    }
    out += '</g>';
    out += `<g id="cut">`;
    for (const [, g] of byLayer) {
      for (const e of g.edges) {
        if (e.kind === 'cut') out += emitLine(e);
      }
    }
    out += '</g>';
    /* Dimensions overlay — extension lines, dim line, arrows, text. */
    if (s2d.dims && s2d.dims.length) {
      const ds = (typeof DimStyle !== 'undefined') ? DimStyle : {
        textSize:11, lineWidth:1.3, lineColor:'#1a1a1a', arrowSize:7, arrowStyle:'filled'
      };
      const sw = Math.max(0.1, ds.lineWidth).toFixed(3);
      const col = ds.lineColor || '#1a1a1a';
      const ARROW = ds.arrowSize, GAP = 5, TICK = 8;
      out += `<g id="dimensions" stroke="${col}" stroke-width="${sw}" fill="${col}" stroke-linecap="round">`;
      for (const d of s2d.dims) {
        const ddx = d.db.x - d.da.x, ddy = d.db.y - d.da.y;
        const dlen = Math.hypot(ddx, ddy) || 1;
        // Extension lines
        const drawExt = (ox, oy, tx, ty) => {
          const ex = tx - ox, ey = ty - oy;
          const el = Math.hypot(ex, ey) || 1;
          const eux = ex / el, euy = ey / el;
          const x1 = ox + eux * GAP, y1 = oy + euy * GAP;
          const x2 = tx + eux * TICK, y2 = ty + euy * TICK;
          out += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
        };
        drawExt(d.a.x, d.a.y, d.da.x, d.da.y);
        drawExt(d.b.x, d.b.y, d.db.x, d.db.y);
        // Dim line
        out += `<line x1="${d.da.x.toFixed(2)}" y1="${d.da.y.toFixed(2)}" x2="${d.db.x.toFixed(2)}" y2="${d.db.y.toFixed(2)}"/>`;
        // Arrows
        const drawArrow = (px, py, tx, ty) => {
          const ax = tx - px, ay = ty - py;
          const al = Math.hypot(ax, ay) || 1;
          const uX = ax / al, uY = ay / al, pX = -uY, pY = uX;
          if (ds.arrowStyle === 'tick') {
            const tlen = ARROW * 0.85;
            const sx = px - (uX + pX) * tlen * 0.5, sy = py - (uY + pY) * tlen * 0.5;
            const ex = px + (uX + pX) * tlen * 0.5, ey = py + (uY + pY) * tlen * 0.5;
            out += `<line x1="${sx.toFixed(2)}" y1="${sy.toFixed(2)}" x2="${ex.toFixed(2)}" y2="${ey.toFixed(2)}"/>`;
            return;
          }
          if (ds.arrowStyle === 'open') {
            const x1 = px + uX*ARROW + pX*ARROW*0.38, y1 = py + uY*ARROW + pY*ARROW*0.38;
            const x2 = px + uX*ARROW - pX*ARROW*0.38, y2 = py + uY*ARROW - pY*ARROW*0.38;
            out += `<polyline points="${x1.toFixed(2)},${y1.toFixed(2)} ${px.toFixed(2)},${py.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}" fill="none"/>`;
            return;
          }
          // filled triangle
          const x1 = px + uX*ARROW + pX*ARROW*0.38, y1 = py + uY*ARROW + pY*ARROW*0.38;
          const x2 = px + uX*ARROW - pX*ARROW*0.38, y2 = py + uY*ARROW - pY*ARROW*0.38;
          out += `<polygon points="${px.toFixed(2)},${py.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}" stroke="none"/>`;
        };
        drawArrow(d.da.x, d.da.y, d.db.x, d.db.y);
        drawArrow(d.db.x, d.db.y, d.da.x, d.da.y);
        // Text — rotated, readable
        const midX = (d.da.x + d.db.x) / 2, midY = (d.da.y + d.db.y) / 2;
        let angDeg = Math.atan2(ddy, ddx) * 180 / Math.PI;
        if (angDeg >  90) angDeg -= 180;
        if (angDeg < -90) angDeg += 180;
        const safeText = String(d.text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const tsz = Math.max(6, ds.textSize);
        out += `<text x="${midX.toFixed(2)}" y="${(midY - 2).toFixed(2)}" font-family="-apple-system,'SF Pro Text',sans-serif" font-size="${tsz}" font-weight="600" text-anchor="middle" fill="${col}" stroke="none" transform="rotate(${angDeg.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)})">${safeText}</text>`;
      }
      out += '</g>';
    }
    // Section label: top-left badge showing active section name(s) so the
    // exported drawing self-documents which view it represents.
    try {
      const active = (Model.sectionPlanes || []).filter(s => s.enabled);
      if (active.length) {
        const names = active.map(s => s.name).join(' / ');
        const txt = `Section ${names}`;
        const x = vb[0] + 14, y = vb[1] + 22;
        const safeText = String(txt).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        out += `<g id="section-label">`;
        out += `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="-apple-system,'SF Pro Text',sans-serif" font-size="14" font-weight="700" fill="#0a84ff" stroke="none">${safeText}</text>`;
        out += `</g>`;
      }
    } catch (_) {}
    /* Title block — bottom-right corner, drawn last so it sits on top. */
    try {
      const tb = (window.TitleBlock && window.TitleBlock.enabled) ? window.TitleBlock : null;
      if (tb) {
        const W = 220, H = 110;
        const margin = 8;
        const x = vb[0] + vb[2] - W - margin;
        const y = vb[1] + vb[3] - H - margin;
        const rows = [
          { label: 'PROJECT', value: tb.project },
          { label: 'DRAWING', value: tb.drawingName },
          { label: 'NUMBER',  value: tb.number },
          { label: 'SCALE',   value: tb.scale },
          { label: 'DATE',    value: tb.date },
          { label: 'AUTHOR',  value: tb.author },
        ].filter(r => r.value);
        if (rows.length || tb.company) {
          out += `<g id="titleblock">`;
          out += `<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="#ffffff" stroke="#1a1a1a" stroke-width="0.6"/>`;
          // Company line at top
          if (tb.company) {
            out += `<text x="${x + W/2}" y="${y + 11}" font-family="-apple-system,'SF Pro Text',sans-serif" font-size="9" font-weight="600" text-anchor="middle" fill="#1a1a1a">${(tb.company+'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</text>`;
            out += `<line x1="${x}" y1="${y + 16}" x2="${x + W}" y2="${y + 16}" stroke="#1a1a1a" stroke-width="0.4"/>`;
          }
          const headerH = tb.company ? 16 : 0;
          const rowH = (H - headerH) / Math.max(1, rows.length);
          for (let i = 0; i < rows.length; i++) {
            const ry = y + headerH + i * rowH;
            out += `<line x1="${x + 70}" y1="${ry}" x2="${x + 70}" y2="${ry + rowH}" stroke="#bbb" stroke-width="0.3"/>`;
            if (i > 0) out += `<line x1="${x}" y1="${ry}" x2="${x + W}" y2="${ry}" stroke="#bbb" stroke-width="0.3"/>`;
            out += `<text x="${x + 6}" y="${ry + rowH/2 + 3}" font-family="-apple-system,'SF Pro Text',sans-serif" font-size="7" fill="#666">${rows[i].label}</text>`;
            const val = (rows[i].value+'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
            out += `<text x="${x + 76}" y="${ry + rowH/2 + 3}" font-family="-apple-system,'SF Pro Text',sans-serif" font-size="8" font-weight="500" fill="#1a1a1a">${val}</text>`;
          }
          out += '</g>';
        }
      }
    } catch (_) {}
    out += '</svg>';
    return out;
  };

  /* ---------- PDF emitter (via pdf-lib) --------------------------------- */
  AD.Export.toPDF = async function (s2d) {
    if (typeof PDFLib === 'undefined') {
      throw new Error('PDFLib not loaded');
    }
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const vb = s2d.viewBox;
    const page = doc.addPage([vb[2], vb[3]]);
    const flipY = (y) => vb[3] - (y - vb[1]);   // PDF origin bottom-left
    const hexToRgb = (hex) => {
      const c = hex.replace('#', '');
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      return rgb(r, g, b);
    };
    // Pass 1: non-cut (elevation) edges first.
    for (const e of s2d.edges) {
      if (e.kind === 'cut') continue;
      page.drawLine({
        start: { x: e.x1 - vb[0], y: flipY(e.y1) },
        end:   { x: e.x2 - vb[0], y: flipY(e.y2) },
        thickness: Math.max(0.05, e.weight) * 2.83,
        color: hexToRgb(e.color || '#000000'),
      });
    }
    // Pass 2: white cut-fills, masking any elevation edge inside.
    for (const f of s2d.fills) {
      const path = 'M' + f.poly.map(p => (p[0] - vb[0]).toFixed(2) + ' ' + flipY(p[1]).toFixed(2)).join(' L') + ' Z';
      page.drawSvgPath(path, { color: rgb(1, 1, 1), borderWidth: 0 });
    }
    // Hatch lines are already emitted as regular edges by the viewport
    // walk — no extra pass needed here.
    // Pass 3: cut edges + hatch lines on top of the fill.
    for (const e of s2d.edges) {
      if (e.kind !== 'cut') continue;
      page.drawLine({
        start: { x: e.x1 - vb[0], y: flipY(e.y1) },
        end:   { x: e.x2 - vb[0], y: flipY(e.y2) },
        thickness: Math.max(0.05, e.weight) * 2.83,
        color: hexToRgb(e.color || '#000000'),
      });
    }
    // Dimensions overlay
    if (s2d.dims && s2d.dims.length) {
      const ds = (typeof DimStyle !== 'undefined') ? DimStyle : {
        textSize:11, lineWidth:1.3, lineColor:'#1a1a1a', arrowSize:7, arrowStyle:'filled'
      };
      const col = hexToRgb(ds.lineColor || '#1a1a1a');
      const sw  = Math.max(0.05, ds.lineWidth) * 2.83;
      const ARROW = ds.arrowSize, GAP = 5, TICK = 8;
      const drawL = (x1, y1, x2, y2) => {
        page.drawLine({
          start:{ x: x1 - vb[0], y: flipY(y1) },
          end:  { x: x2 - vb[0], y: flipY(y2) },
          thickness: sw, color: col,
        });
      };
      for (const d of s2d.dims) {
        const ext = (ox, oy, tx, ty) => {
          const ex = tx - ox, ey = ty - oy;
          const el = Math.hypot(ex, ey) || 1;
          const eux = ex/el, euy = ey/el;
          drawL(ox + eux*GAP, oy + euy*GAP, tx + eux*TICK, ty + euy*TICK);
        };
        ext(d.a.x, d.a.y, d.da.x, d.da.y);
        ext(d.b.x, d.b.y, d.db.x, d.db.y);
        drawL(d.da.x, d.da.y, d.db.x, d.db.y);
        const drawArrow = (px, py, tx, ty) => {
          const ax = tx - px, ay = ty - py;
          const al = Math.hypot(ax, ay) || 1;
          const uX = ax/al, uY = ay/al, pX = -uY, pY = uX;
          if (ds.arrowStyle === 'tick') {
            const tl = ARROW * 0.85;
            drawL(px - (uX + pX)*tl*0.5, py - (uY + pY)*tl*0.5,
                  px + (uX + pX)*tl*0.5, py + (uY + pY)*tl*0.5);
            return;
          }
          const x1 = px + uX*ARROW + pX*ARROW*0.38, y1 = py + uY*ARROW + pY*ARROW*0.38;
          const x2 = px + uX*ARROW - pX*ARROW*0.38, y2 = py + uY*ARROW - pY*ARROW*0.38;
          drawL(px, py, x1, y1); drawL(px, py, x2, y2); drawL(x1, y1, x2, y2);
        };
        drawArrow(d.da.x, d.da.y, d.db.x, d.db.y);
        drawArrow(d.db.x, d.db.y, d.da.x, d.da.y);
        // Text
        const midX = (d.da.x + d.db.x) / 2, midY = (d.da.y + d.db.y) / 2;
        const ddx = d.db.x - d.da.x, ddy = d.db.y - d.da.y;
        let angDeg = Math.atan2(-ddy, ddx) * 180 / Math.PI;
        if (angDeg >  90) angDeg -= 180;
        if (angDeg < -90) angDeg += 180;
        try {
          const tsz = Math.max(4, ds.textSize);
          page.drawText(String(d.text), {
            x: midX - vb[0],
            y: flipY(midY) + 1,
            size: tsz,
            color: col,
            rotate: PDFLib.degrees(angDeg),
          });
        } catch (_) { /* font glyphs missing — skip */ }
      }
    }
    const bytes = await doc.save();
    return bytes;
  };

  /* ---------- DXF emitter (minimal, ENTITIES-only). --------------------- */
  AD.Export.toDXF = function (s2d) {
    const vb = s2d.viewBox;
    // DXF uses Y-up. Flip from SVG/pixel Y-down.
    const flipY = (y) => vb[3] - (y - vb[1]);
    const fx = (x) => (x - vb[0]).toFixed(3);
    const fy = (y) => flipY(y).toFixed(3);

    let dxf = '';
    const emit = (code, val) => {
      // Group codes must be a space-padded 3-digit number then newline.
      dxf += String(code).padStart(3, ' ') + '\n' + String(val) + '\n';
    };

    emit(0, 'SECTION'); emit(2, 'ENTITIES');

    // White solid fills under each polygon.
    for (const f of s2d.fills) {
      const tris = fanTriangulate(f.poly);
      for (const t of tris) {
        emit(0, 'SOLID'); emit(8, safe(f.layer));
        emit(10, fx(t[0][0])); emit(20, fy(t[0][1])); emit(30, '0.0');
        emit(11, fx(t[1][0])); emit(21, fy(t[1][1])); emit(31, '0.0');
        emit(12, fx(t[2][0])); emit(22, fy(t[2][1])); emit(32, '0.0');
        emit(13, fx(t[2][0])); emit(23, fy(t[2][1])); emit(33, '0.0');
      }
    }

    // Hatch lines are already in `s2d.edges` (from the viewport walk).

    // Edges.
    for (const e of s2d.edges) {
      emit(0, 'LINE'); emit(8, safe(e.layer));
      emit(10, fx(e.x1)); emit(20, fy(e.y1)); emit(30, '0.0');
      emit(11, fx(e.x2)); emit(21, fy(e.y2)); emit(31, '0.0');
    }
    // Dimensions: emit as plain LINEs (extension + dim line + arrow strokes)
    // and a TEXT entity for the label. We don't use the AcDbAlignedDimension
    // entity because that requires a proper DXF header / DIMSTYLE setup which
    // most receivers ignore in ENTITIES-only output anyway.
    if (s2d.dims && s2d.dims.length) {
      const ds = (typeof DimStyle !== 'undefined') ? DimStyle : {
        textSize:11, arrowSize:7, arrowStyle:'filled'
      };
      const ARROW = ds.arrowSize, GAP = 5, TICK = 8;
      const tsz = Math.max(2, ds.textSize);
      const emitLine2 = (layer, x1, y1, x2, y2) => {
        emit(0, 'LINE'); emit(8, safe(layer));
        emit(10, fx(x1)); emit(20, fy(y1)); emit(30, '0.0');
        emit(11, fx(x2)); emit(21, fy(y2)); emit(31, '0.0');
      };
      for (const d of s2d.dims) {
        const layer = d.layer || 'Dim';
        const ddx = d.db.x - d.da.x, ddy = d.db.y - d.da.y;
        // Extension lines
        const ext = (ox, oy, tx, ty) => {
          const ex = tx - ox, ey = ty - oy;
          const el = Math.hypot(ex, ey) || 1;
          const eux = ex/el, euy = ey/el;
          emitLine2(layer, ox + eux*GAP, oy + euy*GAP, tx + eux*TICK, ty + euy*TICK);
        };
        ext(d.a.x, d.a.y, d.da.x, d.da.y);
        ext(d.b.x, d.b.y, d.db.x, d.db.y);
        // Dim line
        emitLine2(layer, d.da.x, d.da.y, d.db.x, d.db.y);
        // Arrow strokes (approximate: 2 strokes for triangle/V, 1 for tick)
        const drawArrow = (px, py, tx, ty) => {
          const ax = tx - px, ay = ty - py;
          const al = Math.hypot(ax, ay) || 1;
          const uX = ax/al, uY = ay/al, pX = -uY, pY = uX;
          if (ds.arrowStyle === 'tick') {
            const tl = ARROW * 0.85;
            emitLine2(layer,
              px - (uX + pX) * tl * 0.5, py - (uY + pY) * tl * 0.5,
              px + (uX + pX) * tl * 0.5, py + (uY + pY) * tl * 0.5);
            return;
          }
          const x1 = px + uX*ARROW + pX*ARROW*0.38, y1 = py + uY*ARROW + pY*ARROW*0.38;
          const x2 = px + uX*ARROW - pX*ARROW*0.38, y2 = py + uY*ARROW - pY*ARROW*0.38;
          emitLine2(layer, px, py, x1, y1);
          emitLine2(layer, px, py, x2, y2);
          emitLine2(layer, x1, y1, x2, y2);
        };
        drawArrow(d.da.x, d.da.y, d.db.x, d.db.y);
        drawArrow(d.db.x, d.db.y, d.da.x, d.da.y);
        // Text — TEXT entity at midpoint, rotated to dim direction (DXF angle = degrees CCW from +X)
        const midX = (d.da.x + d.db.x) / 2, midY = (d.da.y + d.db.y) / 2;
        let angDeg = Math.atan2(-ddy, ddx) * 180 / Math.PI; // DXF Y is up → flip
        if (angDeg >  90) angDeg -= 180;
        if (angDeg < -90) angDeg += 180;
        emit(0, 'TEXT'); emit(8, safe(layer));
        emit(10, fx(midX)); emit(20, fy(midY)); emit(30, '0.0');
        emit(40, tsz.toFixed(2));        // text height
        emit(1, String(d.text));         // text content
        emit(50, angDeg.toFixed(2));     // rotation angle
        emit(72, '1');                   // horizontal align: center
        emit(73, '2');                   // vertical align: middle
        emit(11, fx(midX)); emit(21, fy(midY)); emit(31, '0.0');
      }
    }
    emit(0, 'ENDSEC'); emit(0, 'EOF');
    return dxf;
  };

  /* ---------- shared 2D helpers ---------------------------------------- */
  function bbox2(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  function fanTriangulate(poly) {
    const out = [];
    for (let i = 1; i < poly.length - 1; i++) {
      out.push([poly[0], poly[i], poly[i + 1]]);
    }
    return out;
  }
  function clipSegToPoly(seg, poly) {
    const [x0, y0, x1, y1] = seg;
    const ts = [0, 1];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const rx = x1 - x0, ry = y1 - y0;
      const sx = bx - ax, sy = by - ay;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - x0) * sy - (ay - y0) * sx) / den;
      const u = ((ax - x0) * ry - (ay - y0) * rx) / den;
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
  function safe(name) {
    return (name || 'Layer0').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /* Compute a hatch scale factor (pixels per metre) so the exported
     pattern density matches what the viewport shows. We probe by
     projecting two world points 1 m apart on screen. */
  AD.Export._hatchScaleForExport = function (s2d) {
    try {
      const W = s2d.width, H = s2d.height;
      const proj = (v) => {
        const p = v.clone().project(camera);
        return { x: (p.x + 1) * 0.5 * W, y: (1 - p.y) * 0.5 * H };
      };
      // Use the scene centre as a reference point — hatch density at the
      // middle of the view is the most representative.
      const centre = new THREE.Vector3();
      let n = 0;
      for (const o of Model.objects) {
        if (!o.group.visible) continue;
        for (const v of o.em.vertices) { centre.add(v); n++; }
      }
      if (n) centre.divideScalar(n); else centre.set(0, 0, 0);
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const p0 = proj(centre);
      const p1 = proj(centre.clone().add(camRight));
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (!isFinite(d) || d < 1) return 60;      // safe fallback
      return d;
    } catch (_) { return 60; }
  };

  /* ---------- public entry points: download a file ---------------------- */
  AD.Export.download = function (filename, data, mime) {
    const blob = (data instanceof Uint8Array || data instanceof ArrayBuffer)
      ? new Blob([data], { type: mime })
      : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function _defaultName(ext) {
    const stem = (window.Model && Model.docName)
      ? Model.docName.replace(/\.[a-zA-Z0-9]+$/, '')
      : 'turtle';
    const now = new Date();
    const stamp = now.getFullYear().toString().slice(2)
      + ('0' + (now.getMonth() + 1)).slice(-2)
      + ('0' + now.getDate()).slice(-2)
      + '_' + ('0' + now.getHours()).slice(-2)
      + ('0' + now.getMinutes()).slice(-2);
    return `${stem}_${stamp}.${ext}`;
  }
  function _promptName(defaultName) {
    try { return window.prompt('File name', defaultName) || null; }
    catch (_) { return defaultName; }
  }
  AD.Export.saveSVG = function () {
    const name = _promptName(_defaultName('svg'));
    if (!name) return;
    const s2d = AD.Export.buildScene2D();
    AD.Export.download(name, AD.Export.toSVG(s2d), 'image/svg+xml');
  };
  AD.Export.savePDF = async function () {
    if (typeof PDFLib === 'undefined') {
      alert('PDF library not loaded yet. Try again shortly.');
      return;
    }
    const name = _promptName(_defaultName('pdf'));
    if (!name) return;
    const s2d = AD.Export.buildScene2D();
    const bytes = await AD.Export.toPDF(s2d);
    AD.Export.download(name, bytes, 'application/pdf');
  };
  AD.Export.saveDXF = function () {
    const name = _promptName(_defaultName('dxf'));
    if (!name) return;
    const s2d = AD.Export.buildScene2D();
    AD.Export.download(name, AD.Export.toDXF(s2d), 'application/dxf');
  };
})();
