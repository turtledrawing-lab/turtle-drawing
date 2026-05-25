/* ============================================================================
   AD.Hatch — vector hatch pattern library for architectural sections.
   ----------------------------------------------------------------------------
   Each pattern is defined as a small SVG <pattern> that tiles. We expose
   both DOM-usable <svg defs> (for the hatch panel preview & SVG export)
   and a CanvasTexture generator (for live Three.js fill on cut faces).
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  const PATTERNS = [
    { id: 'concrete_exposed',
      label: 'Concrete',
      svg: `<pattern id="h_concrete" patternUnits="userSpaceOnUse" width="12" height="12">
              <rect width="12" height="12" fill="#f6f5f2"/>
              <circle cx="3" cy="4" r="0.6" fill="#5a5a5a"/>
              <circle cx="8" cy="2" r="0.5" fill="#6a6a6a"/>
              <circle cx="10" cy="9" r="0.4" fill="#4a4a4a"/>
              <circle cx="5" cy="10" r="0.55" fill="#7a7a7a"/>
              <circle cx="2" cy="8" r="0.3" fill="#8a8a8a"/>
            </pattern>` },
    { id: 'timber_grain',
      label: 'Timber',
      svg: `<pattern id="h_timber" patternUnits="userSpaceOnUse" width="30" height="12">
              <rect width="30" height="12" fill="#eadfc8"/>
              <path d="M0 3 q7 -2 15 0 t15 0" stroke="#8a6a42" stroke-width="0.5" fill="none"/>
              <path d="M0 7 q7 2 15 0 t15 0"  stroke="#a8845a" stroke-width="0.35" fill="none"/>
              <path d="M0 10 q7 -1 15 0 t15 0" stroke="#7a5a36" stroke-width="0.3" fill="none"/>
            </pattern>` },
    { id: 'insulation_rigid',
      label: 'Insulation',
      svg: `<pattern id="h_insul" patternUnits="userSpaceOnUse" width="14" height="14">
              <rect width="14" height="14" fill="#fef6d5"/>
              <path d="M0 7 q3.5 -6 7 0 t7 0" stroke="#c7aa30" stroke-width="0.6" fill="none"/>
            </pattern>` },
    { id: 'brick',
      label: 'Brick',
      svg: `<pattern id="h_brick" patternUnits="userSpaceOnUse" width="24" height="10">
              <rect width="24" height="10" fill="#d9a88a"/>
              <path d="M0 0 H24 M0 5 H24 M0 10 H24" stroke="#6a3a22" stroke-width="0.4"/>
              <path d="M0 0 V5 M12 5 V10 M24 0 V5" stroke="#6a3a22" stroke-width="0.4"/>
            </pattern>` },
    { id: 'tile',
      label: 'Tile',
      svg: `<pattern id="h_tile" patternUnits="userSpaceOnUse" width="10" height="10">
              <rect width="10" height="10" fill="#f2f3f4"/>
              <path d="M0 0 H10 M0 0 V10" stroke="#8a8a8a" stroke-width="0.4"/>
            </pattern>` },
    { id: 'gravel',
      label: 'Gravel',
      svg: `<pattern id="h_gravel" patternUnits="userSpaceOnUse" width="18" height="18">
              <rect width="18" height="18" fill="#e9e7e0"/>
              <circle cx="4" cy="4" r="1.5" fill="#a8a8a8" stroke="#555" stroke-width="0.3"/>
              <circle cx="11" cy="6" r="1.1" fill="#b8b8b8" stroke="#555" stroke-width="0.3"/>
              <circle cx="15" cy="12" r="1.4" fill="#a0a0a0" stroke="#555" stroke-width="0.3"/>
              <circle cx="6" cy="14" r="1.2" fill="#c0c0c0" stroke="#555" stroke-width="0.3"/>
            </pattern>` },
    { id: 'earth',
      label: 'Earth',
      svg: `<pattern id="h_earth" patternUnits="userSpaceOnUse" width="16" height="16">
              <rect width="16" height="16" fill="#e3d7b8"/>
              <path d="M0 12 l4 -4 l4 4 l4 -4 l4 4" stroke="#6a5030" stroke-width="0.5" fill="none"/>
              <path d="M0 16 l4 -4 l4 4 l4 -4 l4 4" stroke="#6a5030" stroke-width="0.5" fill="none"/>
            </pattern>` },
    { id: 'metal',
      label: 'Metal',
      svg: `<pattern id="h_metal" patternUnits="userSpaceOnUse" width="8" height="8">
              <rect width="8" height="8" fill="#dcdfe3"/>
              <path d="M0 0 L8 8 M-2 6 L2 10 M6 -2 L10 2" stroke="#5a6068" stroke-width="0.4"/>
            </pattern>` },
    { id: 'poche_solid',
      label: 'Poché',
      svg: `<pattern id="h_poche" patternUnits="userSpaceOnUse" width="4" height="4">
              <rect width="4" height="4" fill="#1a1a1a"/>
            </pattern>` },
    { id: 'stone_rubble',
      label: 'Stone',
      svg: `<pattern id="h_stone" patternUnits="userSpaceOnUse" width="22" height="18">
              <rect width="22" height="18" fill="#dcd8d0"/>
              <path d="M2 5 q3 -3 6 0 t6 0 t6 0" stroke="#5a544a" stroke-width="0.45" fill="none"/>
              <path d="M0 12 q3 -2 6 -0.5 t6 0 t6 0" stroke="#5a544a" stroke-width="0.45" fill="none"/>
              <path d="M3 5 V12 M9 5 V12 M15 5 V12 M21 5 V12 M0 12 V18 M6 12 V18 M12 12 V18 M18 12 V18" stroke="#7a7468" stroke-width="0.35"/>
            </pattern>` },
    { id: 'concrete_block',
      label: 'CMU Block',
      svg: `<pattern id="h_cmu" patternUnits="userSpaceOnUse" width="32" height="14">
              <rect width="32" height="14" fill="#cfcdc8"/>
              <path d="M0 0 H32 M0 7 H32 M0 14 H32" stroke="#5a5a5a" stroke-width="0.5"/>
              <path d="M0 0 V7 M16 0 V7 M32 0 V7 M8 7 V14 M24 7 V14" stroke="#5a5a5a" stroke-width="0.5"/>
            </pattern>` },
    { id: 'plaster',
      label: 'Plaster',
      svg: `<pattern id="h_plaster" patternUnits="userSpaceOnUse" width="6" height="6">
              <rect width="6" height="6" fill="#fafaf6"/>
              <circle cx="1.5" cy="1.5" r="0.18" fill="#888"/>
              <circle cx="4" cy="3" r="0.15" fill="#aaa"/>
              <circle cx="2.5" cy="4.5" r="0.2" fill="#888"/>
            </pattern>` },
    { id: 'plywood',
      label: 'Plywood',
      svg: `<pattern id="h_plywood" patternUnits="userSpaceOnUse" width="20" height="20">
              <rect width="20" height="20" fill="#e8d4a8"/>
              <path d="M0 4 q5 -2 10 0 t10 0" stroke="#9a7138" stroke-width="0.35" fill="none"/>
              <path d="M0 12 q5 1 10 0 t10 0" stroke="#9a7138" stroke-width="0.4" fill="none"/>
              <path d="M0 18 q5 -2 10 0 t10 0" stroke="#9a7138" stroke-width="0.35" fill="none"/>
            </pattern>` },
    { id: 'sand',
      label: 'Sand',
      svg: `<pattern id="h_sand" patternUnits="userSpaceOnUse" width="10" height="10">
              <rect width="10" height="10" fill="#f0e0b0"/>
              <circle cx="2" cy="3" r="0.25" fill="#8a6c30"/>
              <circle cx="6" cy="2" r="0.2"  fill="#8a6c30"/>
              <circle cx="8" cy="6" r="0.3"  fill="#8a6c30"/>
              <circle cx="4" cy="7" r="0.25" fill="#8a6c30"/>
              <circle cx="1" cy="9" r="0.2"  fill="#8a6c30"/>
              <circle cx="9" cy="9" r="0.22" fill="#8a6c30"/>
            </pattern>` },
    { id: 'glass',
      label: 'Glass',
      svg: `<pattern id="h_glass" patternUnits="userSpaceOnUse" width="14" height="14">
              <rect width="14" height="14" fill="#e8eef2"/>
              <path d="M-2 16 L16 -2 M-2 8 L8 -2 M6 16 L16 6" stroke="#5a7896" stroke-width="0.35"/>
            </pattern>` },
    { id: 'water',
      label: 'Water',
      svg: `<pattern id="h_water" patternUnits="userSpaceOnUse" width="20" height="14">
              <rect width="20" height="14" fill="#dceaf2"/>
              <path d="M0 4 q5 -3 10 0 t10 0"  stroke="#4a86a6" stroke-width="0.5" fill="none"/>
              <path d="M0 10 q5 -3 10 0 t10 0" stroke="#4a86a6" stroke-width="0.4" fill="none"/>
            </pattern>` },
    { id: 'crosshatch_45',
      label: 'Crosshatch',
      svg: `<pattern id="h_xhatch" patternUnits="userSpaceOnUse" width="8" height="8">
              <rect width="8" height="8" fill="#ffffff"/>
              <path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" stroke="#3a3a3a" stroke-width="0.45"/>
              <path d="M0 0 L8 8 M-2 6 L2 10 M6 -2 L10 2" stroke="#3a3a3a" stroke-width="0.45"/>
            </pattern>` },
    { id: 'diagonal_45',
      label: 'Diagonal',
      svg: `<pattern id="h_diag" patternUnits="userSpaceOnUse" width="8" height="8">
              <rect width="8" height="8" fill="#ffffff"/>
              <path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" stroke="#3a3a3a" stroke-width="0.45"/>
            </pattern>` },
    { id: 'horizontal_lines',
      label: 'Horizontal',
      svg: `<pattern id="h_horiz" patternUnits="userSpaceOnUse" width="8" height="4">
              <rect width="8" height="4" fill="#ffffff"/>
              <path d="M0 2 H8" stroke="#3a3a3a" stroke-width="0.4"/>
            </pattern>` },
    { id: 'vertical_lines',
      label: 'Vertical',
      svg: `<pattern id="h_vert" patternUnits="userSpaceOnUse" width="4" height="8">
              <rect width="4" height="8" fill="#ffffff"/>
              <path d="M2 0 V8" stroke="#3a3a3a" stroke-width="0.4"/>
            </pattern>` },
    { id: 'roof_tile',
      label: 'Roof Tile',
      svg: `<pattern id="h_roof" patternUnits="userSpaceOnUse" width="20" height="10">
              <rect width="20" height="10" fill="#c08868"/>
              <path d="M0 5 q5 -5 10 0 t10 0" stroke="#5a3018" stroke-width="0.5" fill="none"/>
              <path d="M0 10 q5 -5 10 0 t10 0" stroke="#5a3018" stroke-width="0.5" fill="none"/>
            </pattern>` },
  ];

  AD.Hatch = {
    PATTERNS,
    byId(id) { return PATTERNS.find(p => p.id === id) || null; },

    /* Generate a <defs> block containing every pattern — inject once per
       SVG render so <rect fill="url(#h_concrete)"/> works. */
    defsMarkup() {
      return '<defs>' + PATTERNS.map(p => p.svg).join('') + '</defs>';
    },

    /* Build a CanvasTexture for a given pattern id, for live Three.js
       fill on cut faces before SVG export. Uses a blank canvas up front
       so the texture is valid immediately; the SVG is rasterised as soon
       as the Image finishes decoding. */
    canvasTexture(id) {
      const p = this.byId(id);
      if (!p) return null;
      const size = 256;
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = size;
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(cvs);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const svgStr = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
                        ${p.svg.replace(/id="h_\w+"/, 'id="tile"')}
                        <rect width='${size}' height='${size}' fill='url(#tile)'/>
                      </svg>`;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        tex.needsUpdate = true;
      };
      img.onerror = (err) => console.warn('[AD.Hatch] SVG decode failed', err);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
      return tex;
    },
  };
})();
