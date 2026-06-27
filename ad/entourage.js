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

  /* Built-in extras — plants and additional people, bundled as SVG
     line-art assets under ad/entourage_plants/ and ad/entourage_people/.
     (Recovered from earlier in-app uploads and made permanent, so they
     ship in every build and no longer depend on localStorage.)
     Tuple = [id, category, label, heightMetres]. */
  const EXTRA = [
    ["custom_mpkftl3l_8s3l", "plants", "p_A-8", 3],
    ["custom_mpkftu9n_wcvi", "plants", "p_A-7", 3],
    ["custom_mpkftxw6_ywmn", "plants", "p_A-6", 3],
    ["custom_mpkfu0ob_g8q8", "plants", "p_A-5", 3],
    ["custom_mpkfu65i_r9z4", "plants", "p_A-4", 3],
    ["custom_mpkfub7d_urli", "plants", "p_A-3", 3],
    ["custom_mpkfue5b_ifkp", "plants", "p_A-2", 3],
    ["custom_mpkfuheh_26w2", "plants", "p_A-1", 3],
    ["custom_mpkfv6sg_e10z", "plants", "p_B-8", 3],
    ["custom_mpkfv9w5_2ure", "plants", "p_B-7", 3],
    ["custom_mpkfvdb5_3x5f", "plants", "p_B-6", 3],
    ["custom_mpkfvgy5_yb9h", "plants", "p_B-5", 3],
    ["custom_mpkfvkie_9rmj", "plants", "p_B-4", 3],
    ["custom_mpkfvt6l_pkmg", "plants", "p_B-3", 3],
    ["custom_mpkfvw4o_7yzp", "plants", "p_B-2", 3],
    ["custom_mpkfvz7y_ipns", "plants", "p_B-1", 3],
    ["custom_mpkfwu5n_z3nu", "plants", "p_C-14", 3],
    ["custom_mpkfwzfb_g0ap", "plants", "p_C-13", 3],
    ["custom_mpkfx23k_x0su", "plants", "p_C-12", 3],
    ["custom_mpkfx5cs_e9v9", "plants", "p_C-11", 3],
    ["custom_mpkfx86n_sq3g", "plants", "p_C-10", 3],
    ["custom_mpkfxb0z_e400", "plants", "p_C-9", 3],
    ["custom_mpkfxe63_acew", "plants", "p_C-8", 3],
    ["custom_mpkfxhra_uv62", "plants", "p_C-7", 3],
    ["custom_mpkfxkp3_klf8", "plants", "p_C-6", 3],
    ["custom_mpkfxnat_1mpk", "plants", "p_C-5", 3],
    ["custom_mpkfxq56_c09y", "plants", "p_C-4", 3],
    ["custom_mpkfxtm5_qi8m", "plants", "p_C-3", 3],
    ["custom_mpkfxw6p_vdc6", "plants", "p_C-2", 3],
    ["custom_mpkfxzfl_6jlb", "plants", "p_C-1", 3],
    ["custom_mpkfz3to_a2qp", "plants", "p_D-18", 0.4],
    ["custom_mpkfzbpv_dqkw", "plants", "p_D-17", 0.4],
    ["custom_mpkfzp4z_z5vw", "plants", "p_D-16", 0.6],
    ["custom_mpkfzzb0_w8si", "plants", "p_D-15", 0.6],
    ["custom_mpkg0555_5cmq", "plants", "p_D-14", 0.6],
    ["custom_mpkg0get_36i7", "plants", "p_D-13", 0.6],
    ["custom_mpkg0lt8_bp16", "plants", "p_D-12", 0.4],
    ["custom_mpkg0utw_0jxy", "plants", "p_D-11", 0.4],
    ["custom_mpkg123t_ogpt", "plants", "p_D-10", 0.5],
    ["custom_mpkg18n2_je3l", "plants", "p_D-9", 0.5],
    ["custom_mpkg1fsc_e8u0", "plants", "p_D-8", 0.4],
    ["custom_mpkg1nxy_x0xh", "plants", "p_D-7", 0.4],
    ["custom_mpkg1uz3_xlvj", "plants", "p_D-6", 0.4],
    ["custom_mpkg22jl_f818", "plants", "p_D-5", 0.6],
    ["custom_mpkg2a3d_orid", "plants", "p_D-4", 0.6],
    ["custom_mpkg2kco_jdqg", "plants", "p_D-3", 0.4],
    ["custom_mpkg2v94_77w6", "plants", "p_D-2", 0.3],
    ["custom_mpkg334j_8c0l", "plants", "p_D-1", 0.4],
    ["custom_mpksus8x_x8ub", "people", "C-37", 0.6],
    ["custom_mpksuy64_5k3g", "people", "C-36", 0.6],
    ["custom_mpksvi50_qvkg", "people", "C-35", 1],
    ["custom_mpksvt2j_y7bd", "people", "C-34", 1.5],
    ["custom_mpksw03p_kus9", "people", "C-33", 1.5],
    ["custom_mpksw8rb_b45j", "people", "C-32", 1.5],
    ["custom_mpkswhra_vka2", "people", "C-31", 0.9],
    ["custom_mpkswqgl_ex32", "people", "C-30", 1.7],
    ["custom_mpkswwk2_2xw0", "people", "C-29", 1.8],
    ["custom_mpksx2ed_ukvs", "people", "C-28", 1.8],
    ["custom_mpksxa4l_op6n", "people", "C-27", 1.8],
    ["custom_mpksxe2i_f85l", "people", "C-26", 1.7],
    ["custom_mpksxp70_o33t", "people", "C-25", 0.6],
    ["custom_mpksxuwu_r6fa", "people", "C-24", 0.6],
    ["custom_mpksy9s7_onzo", "people", "C-23", 1.2],
    ["custom_mpksygcx_qrso", "people", "C-22", 1.1],
    ["custom_mpksynw2_mot9", "people", "C-21", 1.2],
    ["custom_mpksytj0_1bol", "people", "C-20", 1.2],
    ["custom_mpksz0fw_6t68", "people", "C-19", 1.2],
    ["custom_mpkszaq0_raad", "people", "C-18", 1.7],
    ["custom_mpkszffo_oyga", "people", "C-17", 1.7],
    ["custom_mpkszpgk_urhp", "people", "C-16", 1.8],
    ["custom_mpkszwu9_5q5c", "people", "C-15", 1.7],
    ["custom_mpkt03n0_s99n", "people", "C-14", 1.7],
    ["custom_mpkt0cby_j6cp", "people", "C-13", 1.8],
    ["custom_mpkt0hp7_k0p2", "people", "C-12", 1.7],
    ["custom_mpkt0ofe_9rn6", "people", "C-11", 1.8],
    ["custom_mpkt0ylt_ctjq", "people", "C-10", 1.8],
    ["custom_mpkt14o0_4und", "people", "C-9", 1.8],
    ["custom_mpkt1ans_bs4h", "people", "C-8", 1.7],
    ["custom_mpkt1lt7_6nsz", "people", "C-7", 1.8],
    ["custom_mpkt1r59_ee9c", "people", "C-6", 1.8],
    ["custom_mpkt1ur4_153l", "people", "C-5", 1.7],
    ["custom_mpkt22ax_kotm", "people", "C-4", 1.8],
    ["custom_mpkt2atu_ksre", "people", "C-3", 1.8],
    ["custom_mpkt2i7l_as5f", "people", "C-2", 1.8],
    ["custom_mpkt2qwk_sdv4", "people", "C-1", 1.7],
    ["custom_mpkt32yb_f63w", "people", "B-29", 1.2],
    ["custom_mpkt3d3t_bpnk", "people", "B-28", 1.5],
    ["custom_mpkt3ji5_atq1", "people", "B-27", 1.8],
    ["custom_mpkt3q20_n7er", "people", "B-26", 1.8],
    ["custom_mpkt3w3o_g6qq", "people", "B-25", 1.7],
    ["custom_mpkt43ns_ramx", "people", "B-24", 1.5],
    ["custom_mpkt49dr_kuuy", "people", "B-23", 1.4],
    ["custom_mpkt4mzj_ie43", "people", "B-22", 1.6],
    ["custom_mpkt4tif_vfws", "people", "B-21", 1.8],
    ["custom_mpkt50ar_qnkt", "people", "B-20", 1.7],
    ["custom_mpkt551e_75kz", "people", "B-19", 1.7],
    ["custom_mpkt5g1z_dsbs", "people", "B-18", 1.5],
    ["custom_mpkt5m6p_76pu", "people", "B-17", 1.5],
    ["custom_mpkt5tum_8w9j", "people", "B-16", 1.8],
    ["custom_mpkt6084_rxpw", "people", "B-15", 1.8],
    ["custom_mpkt64ej_j9mf", "people", "B-14", 1.7],
    ["custom_mpkt6ajd_ujm0", "people", "B-13", 1.7],
    ["custom_mpkt6hkk_ie1f", "people", "B-12", 1.7],
    ["custom_mpkt6y22_2np9", "people", "B-11", 1.6],
    ["custom_mpkt7860_f9jg", "people", "B-10", 1.65],
    ["custom_mpkt7e80_z6zn", "people", "B-9", 1.6],
    ["custom_mpkt7jzw_znvd", "people", "B-8", 1.45],
    ["custom_mpkt7p2r_cbx1", "people", "B-7", 1.7],
    ["custom_mpkt7v4d_g7bh", "people", "B-6", 1.6],
    ["custom_mpkt7ydq_qoqz", "people", "B-5", 1.7],
    ["custom_mpkt81br_8qii", "people", "B-4", 1.7],
    ["custom_mpkt8488_s1ia", "people", "B-3", 1.7],
    ["custom_mpkt8ce4_m433", "people", "B-2", 1.7],
    ["custom_mpkt8f90_13fk", "people", "B-1", 1.7],
  ].map(([id, cat, label, height]) => ({
    id, cat, label, height,
    svgUrl: 'ad/entourage_' + (cat === 'plants' ? 'plants' : 'people')
            + '/' + label + '.svg',
  }));

  const ITEMS = PEOPLE_IDS.map((id, i) => ({
    id, cat: 'people',
    label: 'A-' + (i + 1),
    height: 1.70,
    svgUrl: 'ad/entourage_people/A-' + (i + 1) + '.svg',
  })).concat(EXTRA);

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
      // Dedupe: if an item was promoted to a built-in (same id now in
      // ITEMS), don't also show the leftover localStorage copy.
      return ITEMS.filter(i => i.cat === cat)
        .concat(CUSTOM.filter(i => i.cat === cat && !ITEMS.some(b => b.id === i.id)));
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

      // Billboard basis — IDENTICAL to _tickFaceCamera (normal = camPos − centre,
      // right = worldUp × normal, up = normal × right). The old basis used the
      // camera's FORWARD vector, whose `right` is the OPPOSITE sign, so the figure
      // appeared and then the first per-frame face-camera tick flipped it left-right.
      // Using the tick's exact formula makes that first tick reproduce these same
      // vertices → the figure appears correctly in one shot, no flip.
      const worldUp = new THREE.Vector3(0, 1, 0);
      // Bottom-center anchored: place with base at worldPos.
      const centre = worldPos.clone().add(worldUp.clone().multiplyScalar(H / 2));
      let normal = camera.position.clone().sub(centre);
      if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
      normal.normalize();
      let rightVec = new THREE.Vector3().crossVectors(worldUp, normal);
      if (rightVec.lengthSq() < 1e-6) rightVec.set(1, 0, 0);
      rightVec.normalize();
      const upVec = new THREE.Vector3().crossVectors(normal, rightVec).normalize();
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
