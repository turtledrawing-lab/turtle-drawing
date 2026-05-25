/* ============================================================================
   AD.Entourage — people / plants / furniture / vehicles SVG library.
   ----------------------------------------------------------------------------
   Click a swatch in the Entourage panel, then click in the viewport to
   place the item. Each entourage lands as an image-plane SketchObject
   (vector SVG rasterised into a CanvasTexture) sized to its real-world
   height, Face-Cam enabled so it always faces the camera.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  const STROKE = '#1a1a1a';
  const svg = (viewBox, inner) =>
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${viewBox}'>
       <g fill='none' stroke='${STROKE}' stroke-width='1.2'
          stroke-linecap='round' stroke-linejoin='round'>${inner}</g>
     </svg>`;

  /* People — 21 built-in poses loaded from local SVG files. */
  const PEOPLE_IDS = Array.from({ length: 21 }, (_, i) => 'person_A' + (i + 1));
  const ITEMS = PEOPLE_IDS.map((id, i) => ({
    id, cat: 'people',
    label: 'A-' + (i + 1),
    height: 1.70,
    svgUrl: 'ad/entourage_people/A-' + (i + 1) + '.svg',
  })).concat([
    /* Default plants, furniture and vehicles were removed —
       upload your own via the panel's "Upload" button. The uploaded
       items become permanent (built-in) and can't be deleted by
       accident, matching the look of your own illustrations. */
  ]);

  // ----- Custom items (persisted) ---------------------------------------
  function _loadCustom() {
    try {
      const raw = localStorage.getItem('turtle_entourage_custom');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // Migrate previously-uploaded items to be treated as built-in
      // (permanent / not deletable) — matches the new default behaviour.
      let changed = false;
      for (const it of arr) {
        if (it && it.custom && !it.builtin) { it.builtin = true; changed = true; }
      }
      if (changed) {
        try { localStorage.setItem('turtle_entourage_custom', JSON.stringify(arr)); }
        catch (_) {}
      }
      return arr;
    } catch (_) { return []; }
  }
  function _saveCustom(list) {
    try { localStorage.setItem('turtle_entourage_custom', JSON.stringify(list)); }
    catch (_) {}
  }
  const CUSTOM = _loadCustom();

  AD.Entourage = {
    ITEMS,
    CUSTOM,
    byCategory(cat) {
      return ITEMS.filter(i => i.cat === cat)
        .concat(CUSTOM.filter(i => i.cat === cat));
    },
    byId(id) {
      return ITEMS.find(i => i.id === id) || CUSTOM.find(i => i.id === id) || null;
    },
    /* Rasterise an SVG src into a 1024px CanvasTexture and assign it
       to the given material. Fallback to TextureLoader for non-SVG. */
    /* Draw an image into a canvas with a white halo so the outline stays
       readable against dark backgrounds. Multi-pass white shadow builds
       up the glow, then a clean pass paints the image on top. */
    drawWithHalo(ctx, img, w, h) {
      // 1) Rasterise the SVG normally (black strokes on transparent bg).
      ctx.drawImage(img, 0, 0, w, h);

      // 2) Flood-fill white into the INTERIOR of the closed outline.
      //    Seed the flood from all four borders across transparent
      //    pixels — anything it reaches is exterior. Every remaining
      //    transparent pixel is interior and gets painted opaque white,
      //    so the figure reads as a solid silhouette against dark
      //    backdrops without covering the outlines themselves.
      try {
        const TH = 40;             // alpha threshold for "transparent"
        const id = ctx.getImageData(0, 0, w, h);
        const data = id.data;
        const total = w * h;
        const visited = new Uint8Array(total);
        const stack = [];
        const pushIfOpen = (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return;
          const i = y * w + x;
          if (visited[i]) return;
          if (data[i * 4 + 3] >= TH) return;  // blocked by stroke
          visited[i] = 1;
          stack.push(i);
        };
        for (let x = 0; x < w; x++) { pushIfOpen(x, 0); pushIfOpen(x, h - 1); }
        for (let y = 0; y < h; y++) { pushIfOpen(0, y); pushIfOpen(w - 1, y); }
        while (stack.length) {
          const i = stack.pop();
          const x = i % w, y = (i - x) / w;
          pushIfOpen(x + 1, y);
          pushIfOpen(x - 1, y);
          pushIfOpen(x, y + 1);
          pushIfOpen(x, y - 1);
        }
        // Fill interior transparent pixels with white.
        for (let i = 0; i < total; i++) {
          if (!visited[i] && data[i * 4 + 3] < TH) {
            const o = i * 4;
            data[o]     = 255;
            data[o + 1] = 255;
            data[o + 2] = 255;
            data[o + 3] = 255;
          }
        }
        ctx.putImageData(id, 0, 0);
      } catch (err) {
        console.warn('[entourage] interior fill failed', err);
      }
    },
    /* Set up alpha-tested depth materials on the mesh so shadows follow the
       silhouette of the texture instead of the rectangular plane. Call right
       after assigning the entourage material; map will sync via _shadowDepth
       reference held on mat as textures load. */
    setupAlphaShadow(mesh, mat) {
      if (!mesh || !mat) return;
      mesh.castShadow = true;
      // Build the alpha-discard depth materials lazily once the texture is
      // available so the shader's sampler is never bound to nothing (which
      // would cause every fragment to discard and erase the shadow entirely).
      mat._shadowMesh = mesh;
      AD.Entourage._installAlphaShadow(mesh, mat);
    },
    _installAlphaShadow(mesh, mat) {
      if (!mat || !mat.map) return;     // wait until texture exists
      if (mat._alphaShadowInstalled) {  // refresh uniforms only on later calls
        if (mat._shadowDepth && mat._shadowDepth._tUni) mat._shadowDepth._tUni.value = mat.map;
        if (mat._shadowDist  && mat._shadowDist._tUni)  mat._shadowDist._tUni.value  = mat.map;
        return;
      }
      const tUni = { value: mat.map };
      const patch = (shader) => {
        shader.uniforms.tEntourage = tUni;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vEntUv;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEntUv = uv;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D tEntourage;\nvarying vec2 vEntUv;')
          .replace('void main() {', 'void main() {\n  if (texture2D(tEntourage, vEntUv).a < 0.5) discard;');
      };
      const depth = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        side: THREE.DoubleSide,
      });
      depth.onBeforeCompile = patch;
      depth._tUni = tUni;
      const dist = new THREE.MeshDistanceMaterial({});
      dist.onBeforeCompile = patch;
      dist._tUni = tUni;
      mesh.customDepthMaterial = depth;
      mesh.customDistanceMaterial = dist;
      mat._shadowDepth = depth;
      mat._shadowDist = dist;
      mat._alphaShadowInstalled = true;
    },
    applyHiResTexture(src, mat) {
      if (!src || !mat) return;
      const sync = (tex) => {
        mat.map = tex; mat.needsUpdate = true;
        if (mat._shadowMesh) AD.Entourage._installAlphaShadow(mat._shadowMesh, mat);
      };
      const isSvg = /^data:image\/svg/.test(src) || /\.svg(\?|$)/i.test(src);
      if (!isSvg) {
        const loader = new THREE.TextureLoader();
        loader.load(src, (tex) => {
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          if (typeof THREE.sRGBEncoding !== 'undefined') tex.encoding = THREE.sRGBEncoding;
          tex.needsUpdate = true;
          sync(tex);
        });
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const natW = img.naturalWidth || img.width || 128;
        const natH = img.naturalHeight || img.height || 128;
        const target = 2048;
        const ratio = Math.max(natW, natH) < target
          ? target / Math.max(natW, natH) : 1;
        const cnv = document.createElement('canvas');
        cnv.width  = Math.round(natW * ratio);
        cnv.height = Math.round(natH * ratio);
        const ctx = cnv.getContext('2d', { willReadFrequently: true });
        AD.Entourage.drawWithHalo(ctx, img, cnv.width, cnv.height);
        const tex = new THREE.CanvasTexture(cnv);
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        if (typeof THREE.sRGBEncoding !== 'undefined') tex.encoding = THREE.sRGBEncoding;
        tex.needsUpdate = true;
        sync(tex);
      };
      img.onerror = (e) => console.warn('[entourage] hires load failed', e);
      img.src = src;
    },
    categories: ['people', 'plants', 'furniture', 'vehicles', 'custom'],
    categoryLabel: {
      people: 'People', plants: 'Plants',
      furniture: 'Furniture', vehicles: 'Vehicles',
      custom: 'Custom',
    },

    /* Add a user-supplied SVG as a custom entourage item. */
    addCustom({ svgText, label, category, height }) {
      if (!svgText) return null;
      // Ensure root <svg> has xmlns and a viewBox; many exports omit.
      let s = svgText.trim();
      if (!/<svg[^>]*xmlns=/.test(s)) {
        s = s.replace(/<svg/, "<svg xmlns='http://www.w3.org/2000/svg'");
      }
      const id = 'custom_' + Date.now().toString(36) +
                 '_' + Math.random().toString(36).slice(2, 6);
      const item = {
        id,
        cat: category || 'custom',
        label: label || 'Item',
        height: typeof height === 'number' ? height : 1.7,
        svg: s,
        custom: true,
        // Treat user uploads as built-in default entourage going forward:
        // they're persisted in localStorage AND not removable via the UI.
        builtin: true,
      };
      CUSTOM.push(item);
      _saveCustom(CUSTOM);
      return item;
    },
    removeCustom(id) {
      const i = CUSTOM.findIndex(it => it.id === id);
      if (i < 0) return false;
      if (CUSTOM[i].builtin) return false;   // built-in items can't be deleted
      CUSTOM.splice(i, 1);
      _saveCustom(CUSTOM);
      return true;
    },

    /* Return the URL to load for an item. External SVG files use their
       local path directly; inline SVGs are encoded as data-URLs. */
    svgDataUrl(item) {
      if (item.svgUrl) return item.svgUrl;
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(item.svg);
    },

    /* Place an entourage at a 3D world point. Uses the same image-plane
       pattern as the drag-drop image importer, then snaps Face-Cam on so
       the figure stays upright and always turns toward the camera. The
       SVG's *rendered content bbox* is measured asynchronously so
       real-world height matches the ink, regardless of empty viewBox
       padding. */
    placeAt(item, worldPos, opts) {
      if (!item || !worldPos) return null;
      if (typeof EditableMesh === 'undefined') return null;

      // Initial guess for aspect ratio from viewBox — refined after the
      // image loads and we measure the actual content.
      let vbW = 40, vbH = 100;
      if (item.svg) {
        const vbMatch = item.svg.match(/viewBox=['"]([^'"]+)['"]/);
        if (vbMatch) {
          const p = vbMatch[1].split(/\s+/).map(parseFloat);
          vbW = p[2]; vbH = p[3];
        }
      }
      const H = item.height;
      const W = H * (vbW / vbH);

      // Billboard basis — initially face the current camera horizontally.
      const camFwd = new THREE.Vector3();
      camera.getWorldDirection(camFwd);
      camFwd.y = 0;
      if (camFwd.lengthSq() < 1e-6) camFwd.set(0, 0, -1);
      camFwd.normalize();
      const rightVec = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), camFwd).normalize();
      const upVec    = new THREE.Vector3(0, 1, 0);

      // Bottom-center anchored: place with base at worldPos.
      const centre = worldPos.clone().add(upVec.clone().multiplyScalar(H / 2));
      const r = rightVec.clone().multiplyScalar(W / 2);
      const u = upVec.clone().multiplyScalar(H / 2);

      const em = new EditableMesh();
      const bl = centre.clone().sub(r).sub(u);
      const br = centre.clone().add(r).sub(u);
      const tr = centre.clone().add(r).add(u);
      const tl = centre.clone().sub(r).add(u);
      em.addVertex(bl);
      em.addVertex(br);
      em.addVertex(tr);
      em.addVertex(tl);
      em.addFace([0, 1, 2, 3], 0xffffff, Model.activeLayerId);

      const so = new SketchObject(em, item.label || 'Entourage');

      // Texture from SVG data URL via TextureLoader.
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.01,
        depthWrite: true,
      });
      const dataUrl = AD.Entourage.svgDataUrl(item);
      // Load the SVG into an Image first so we can measure its content
      // bounding-box; scale the plane so the INK is exactly `height` m.
      const img = new Image();
      img.crossOrigin = 'anonymous';
      // Shared canvas so both the bbox-measure block and the final
      // CanvasTexture see the same hi-res rasterisation.
      const cnv = document.createElement('canvas');
      img.onload = () => {
        try {
          const natW = img.naturalWidth || img.width || 128;
          const natH = img.naturalHeight || img.height || 128;
          const target = 2048;
          const ratio = Math.max(natW, natH) < target
            ? target / Math.max(natW, natH) : 1;
          cnv.width = Math.round(natW * ratio);
          cnv.height = Math.round(natH * ratio);
          const ctx = cnv.getContext('2d', { willReadFrequently: true });
          AD.Entourage.drawWithHalo(ctx, img, cnv.width, cnv.height);
          const data = ctx.getImageData(0, 0, cnv.width, cnv.height).data;
          // Scan for opaque pixels
          let pxTop = -1, pxBottom = -1, pxLeft = cnv.width, pxRight = -1;
          for (let y = 0; y < cnv.height; y++) {
            for (let x = 0; x < cnv.width; x++) {
              const idx = (y * cnv.width + x) * 4;
              if (data[idx + 3] > 10) {
                if (pxTop < 0) pxTop = y;
                pxBottom = y;
                if (x < pxLeft)  pxLeft  = x;
                if (x > pxRight) pxRight = x;
              }
            }
          }
          if (pxTop >= 0 && pxBottom > pxTop && pxRight > pxLeft) {
            const contentH = pxBottom - pxTop + 1;
            const contentW = pxRight - pxLeft + 1;
            const newH = item.height;
            const newW = newH * (contentW / contentH);
            // Re-position vertices: base at worldPos, centre at newH/2,
            // using the SAME billboard basis (rightVec / upVec) we
            // captured outside this callback.
            const centreNew = worldPos.clone().add(upVec.clone().multiplyScalar(newH / 2));
            const rv = rightVec.clone().multiplyScalar(newW / 2);
            const uv = upVec.clone().multiplyScalar(newH / 2);
            const V = em.vertices;
            V[0].copy(centreNew).sub(rv).sub(uv);
            V[1].copy(centreNew).add(rv).sub(uv);
            V[2].copy(centreNew).add(rv).add(uv);
            V[3].copy(centreNew).sub(rv).add(uv);
            // UV bounds crop the texture to the content bbox.
            so._uvBounds = {
              u0: pxLeft / cnv.width,
              u1: (pxRight + 1) / cnv.width,
              v0: 1 - (pxBottom + 1) / cnv.height,
              v1: 1 - pxTop / cnv.height,
            };
            so._bbW = newW;
            so._bbH = newH;
            so.rebuild();
          }
        } catch (err) { console.warn('[entourage] bbox measure failed', err); }
        // Use the high-resolution canvas as the texture so strokes stay
        // crisp (SVG's intrinsic image size often equals tiny viewBox px).
        const tex = new THREE.CanvasTexture(cnv);
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        if (typeof THREE.sRGBEncoding !== 'undefined') tex.encoding = THREE.sRGBEncoding;
        tex.needsUpdate = true;
        mat.map = tex;
        mat.needsUpdate = true;
        if (mat._shadowMesh) AD.Entourage._installAlphaShadow(mat._shadowMesh, mat);
      };
      img.onerror = (err) => console.warn('[entourage] svg load failed', err);
      img.src = dataUrl;

      so.mesh.material = mat;
      so.mat = mat;
      AD.Entourage.setupAlphaShadow(so.mesh, mat);
      so.isImagePlane = true;
      so.isEntourage = true;
      so.entourageId = item.id;
      so._skipEdges = true;
      if (so.edges && so.edges.geometry) {
        so.edges.geometry.dispose();
        so.edges.geometry = new THREE.BufferGeometry();
      }

      so.rebuild = function () {
        const V = this.em.vertices;
        if (V.length < 4) return;
        const A = V[0], B = V[1], C = V[2], D = V[3];
        const n = new THREE.Vector3()
          .crossVectors(new THREE.Vector3().subVectors(B, A),
                        new THREE.Vector3().subVectors(D, A)).normalize();
        const positions = new Float32Array([
          A.x,A.y,A.z, B.x,B.y,B.z, C.x,C.y,C.z,
          A.x,A.y,A.z, C.x,C.y,C.z, D.x,D.y,D.z,
        ]);
        const normals = new Float32Array([
          n.x,n.y,n.z, n.x,n.y,n.z, n.x,n.y,n.z,
          n.x,n.y,n.z, n.x,n.y,n.z, n.x,n.y,n.z,
        ]);
        // UV bounds — default (0..1 full texture) or cropped to the
        // content bbox after measurement (so padding doesn't count
        // toward the world-space size).
        const ub = this._uvBounds || { u0: 0, u1: 1, v0: 0, v1: 1 };
        const uvs = new Float32Array([
          ub.u0, ub.v0, ub.u1, ub.v0, ub.u1, ub.v1,
          ub.u0, ub.v0, ub.u1, ub.v1, ub.u0, ub.v1,
        ]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
        g.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
        g.userData.faceIdxMap = [0, 0];
        g.computeBoundingBox(); g.computeBoundingSphere();
        if (this.mesh.geometry) this.mesh.geometry.dispose();
        this.mesh.geometry = g;
      };
      so.rebuild();

      addObject(so);
      // Auto-turn on Face Cam so the figure always faces the camera.
      try {
        if (typeof setObjectFaceCamera === 'function') setObjectFaceCamera(so, true);
        else so.faceCamera = true;
      } catch (_) {}
      return so;
    },
  };
})();
