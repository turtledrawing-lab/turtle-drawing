/* ============================================================================
   AD.UI — Right-panel sections unique to Turtle Drawing.
   ----------------------------------------------------------------------------
   Adds:
     • "SECTION" panel  — select an active section plane + per-plane scene pose
     • "HATCH"   panel  — drag a hatch swatch onto a cut face to assign it
     • "MATERIAL" panel — (future) structured library of architectural materials
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});
  AD.UI = AD.UI || {};

  /* Load a raster image data URL, knock out near-white background pixels
     (flood-fill from the four edges so internal white stays opaque), and
     return a new data URL with proper alpha. Includes a soft tolerance
     near the edge so jagged outlines look smooth. */
  async function _stripWhiteBg(srcUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 100;
          const h = img.naturalHeight || img.height || 100;
          const cnv = document.createElement('canvas');
          cnv.width = w; cnv.height = h;
          const ctx = cnv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, w, h);
          const data = imgData.data;
          const total = w * h;
          // "near-white" test — generous so anti-aliased edges go too
          const WHITE = 240;
          const isWhite = (i) =>
            data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE && data[i + 3] > 0;
          // Flood-fill from edges
          const visited = new Uint8Array(total);
          const stack = [];
          const push = (x, y) => {
            if (x < 0 || y < 0 || x >= w || y >= h) return;
            const idx = y * w + x;
            if (visited[idx]) return;
            const di = idx * 4;
            if (!isWhite(di)) return;
            visited[idx] = 1;
            stack.push([x, y]);
          };
          for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
          for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
          while (stack.length) {
            const [x, y] = stack.pop();
            const di = (y * w + x) * 4;
            data[di + 3] = 0;        // make transparent
            push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
          }
          // Soft edge: any pixel touching a transparent neighbour and still
          // mostly-white gets feathered (alpha scaled by darkness).
          const out = new Uint8ClampedArray(data);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              const di = i * 4;
              if (data[di + 3] === 0) continue;
              if (data[di] < WHITE - 10 || data[di + 1] < WHITE - 10 || data[di + 2] < WHITE - 10) continue;
              // Check neighbours for transparent
              const has = (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h
                && data[((yy * w + xx) * 4) + 3] === 0;
              if (has(x + 1, y) || has(x - 1, y) || has(x, y + 1) || has(x, y - 1)) {
                // brightness 0..1 (1=pure white)
                const b = (data[di] + data[di + 1] + data[di + 2]) / (3 * 255);
                out[di + 3] = Math.round((1 - b) * 255 * 2);
              }
            }
          }
          imgData.data.set(out);
          ctx.putImageData(imgData, 0, 0);
          resolve({ dataUrl: cnv.toDataURL('image/png'), w, h });
        } catch (e) {
          console.warn('[entourage] _stripWhiteBg failed', e);
          resolve({ dataUrl: srcUrl, w: 100, h: 100 });
        }
      };
      img.onerror = () => resolve({ dataUrl: srcUrl, w: 100, h: 100 });
      img.src = srcUrl;
    });
  }

  AD.UI.install = function () {
    injectHatchPanel();
    injectEntouragePanel();
    bindSectionPlaneDblClick();
  };

  /* ---- CONTEXT panel --------------------------------------------------- */
  function injectContextPanel() {
    const right = document.getElementById('rightpanel');
    if (!right) return;
    if (document.getElementById('adContextPanel')) return;
    if (!window.AD || !AD.Context) return;
    const sec = document.createElement('div');
    sec.className = 'panel-section collapsible';
    sec.id = 'adContextPanel';
    sec.style.cssText = 'flex:0 0 auto;';
    sec.innerHTML = `
      <div class="panel-header" data-toggle="adCtxBody">
        <span><span class="arrow">▸</span>
          <svg class="panel-icon" viewBox="0 0 24 24" width="16" height="16"
               fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 17 L21 17"/>
            <path d="M5 14 Q9 10 13 14 Q17 11 21 14"/>
            <path d="M6 7 Q8 5 11 6 Q13 4 16 5"/>
          </svg>
          Context
        </span>
      </div>
      <div class="panel-body" id="adCtxBody" style="padding:8px;display:none;">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;">
            <input type="checkbox" id="adCtxGround"/> Ground (earth hatch, cut-aware)
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;">
            <input type="checkbox" id="adCtxSky"/> Sky background
          </label>
        </div>
      </div>`;
    right.appendChild(sec);
    const head = sec.querySelector('.panel-header');
    const body = sec.querySelector('#adCtxBody');
    const arrow = head.querySelector('.arrow');
    head.style.cursor = 'pointer';
    head.addEventListener('click', () => {
      const nowOpen = (body.style.display === 'none');
      body.style.display = nowOpen ? 'block' : 'none';
      if (arrow) arrow.textContent = nowOpen ? '▾' : '▸';
      if (nowOpen) refresh();
    });
    const cbG = sec.querySelector('#adCtxGround');
    const cbS = sec.querySelector('#adCtxSky');
    const refresh = () => {
      cbG.checked = !!(typeof Model !== 'undefined' &&
        Model.objects.find(o => o._isContextGround));
      cbS.checked = !!AD.Context._skyOn;
    };
    cbG.addEventListener('change', (e) => {
      if (e.target.checked) AD.Context.addGround();
      else AD.Context.removeGround();
      refresh();
    });
    cbS.addEventListener('change', (e) => {
      AD.Context.setSky(e.target.checked);
      refresh();
    });
  }

  /* ---- HATCH panel ----------------------------------------------------- */
  function injectHatchPanel() {
    const right = document.getElementById('rightpanel');
    if (!right) return;
    if (document.getElementById('adHatchPanel')) return;
    const sec = document.createElement('div');
    sec.className = 'panel-section collapsible';
    sec.id = 'adHatchPanel';
    sec.style.cssText = 'flex:0 0 auto;';
    sec.innerHTML = `
      <div class="panel-header" data-toggle="adHatchBody">
        <span><span class="arrow">▸</span>
          <svg class="panel-icon" viewBox="0 0 24 24" width="16" height="16"
               fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20 L20 4 M9 20 L20 9 M14 20 L20 14 M4 15 L15 4 M4 10 L10 4"/>
          </svg>
          Hatch
        </span>
      </div>
      <div class="panel-body" id="adHatchBody" style="padding:8px;display:none;">
        <div id="adHatchGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(60px, 1fr));gap:4px;"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10px;color:#444;">
          <span style="flex:0 0 auto;">Scale</span>
          <input id="adHatchScale" type="range" min="0.25" max="4" step="0.05" value="1"
                 style="flex:1;" />
          <span id="adHatchScaleVal" style="flex:0 0 28px;text-align:right;">1.00</span>
        </div>
      </div>`;
    // Toggle handling is centralised — see turtle_drawing.html's
    // MutationObserver-driven _wirePanelHeader. We just append the section.
    right.appendChild(sec);

    const grid = sec.querySelector('#adHatchGrid');
    const makeCell = (id, label, innerHTML) => {
      const cell = document.createElement('div');
      cell.title = label;
      cell.dataset.hatch = id || '';
      cell.style.cssText =
        'border-radius:5px;cursor:pointer;border:0.5px solid rgba(0,0,0,0.18);' +
        'background:#fff;overflow:hidden;position:relative;';
      cell.innerHTML = `<div style="height:40px;display:flex;align-items:center;justify-content:center;">${innerHTML}</div>
        <div style="font-size:9px;padding:1px 2px;text-align:center;color:#333;border-top:0.5px solid rgba(0,0,0,0.1);background:#fafafa;">${label}</div>`;
      cell.addEventListener('click', () => {
        // Toggle off if the same swatch is already armed.
        if (paintHatchId === (id || null) && cell.style.outline) { exitPaintMode(); return; }
        enterPaintMode(id || null, cell);
      });
      return cell;
    };
    // "None" swatch — acts as the Clear action.
    grid.appendChild(makeCell(null, 'None',
      `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'>
         <rect width='48' height='48' fill='#ffffff' stroke='#ccc'/>
         <line x1='6' y1='6' x2='42' y2='42' stroke='#c33' stroke-width='1.2'/>
       </svg>`));
    for (const p of AD.Hatch.PATTERNS) {
      const svgMarkup = (AD.HatchLines && AD.HatchLines.swatchSVG)
        ? AD.HatchLines.swatchSVG(p.id, 48) : '';
      grid.appendChild(makeCell(p.id, p.label, svgMarkup));
    }
    // Scale slider — affects every hatch pattern (3D overlay + cut fills + swatches).
    const slider = sec.querySelector('#adHatchScale');
    const valLbl = sec.querySelector('#adHatchScaleVal');
    if (slider) {
      slider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value) || 1;
        AD.HatchLines.scale = v;
        valLbl.textContent = v.toFixed(2);
        // Refresh swatches
        const cells = sec.querySelectorAll('#adHatchGrid > div');
        cells.forEach(cell => {
          const id = cell.dataset.hatch;
          if (!id) return;
          const inner = cell.firstElementChild;
          if (inner && AD.HatchLines.swatchSVG) {
            inner.innerHTML = AD.HatchLines.swatchSVG(id, 48);
          }
        });
        // Refresh 3D hatch overlays on tagged objects
        for (const o of (Model.objects || [])) {
          if (AD.HatchLines.refresh) AD.HatchLines.refresh(o);
        }
        // Refresh cut fills
        if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
      });
    }
  }

  /* ---- Paint mode ------------------------------------------------------ */
  let paintHatchId;   // undefined = disarmed; null = "remove hatch" mode; string = pattern id
  let paintCursor = null;

  function enterPaintMode(hatchId, cellEl) {
    paintHatchId = hatchId;
    document.querySelectorAll('#adHatchGrid > div').forEach(d => d.style.outline = 'none');
    if (cellEl) cellEl.style.outline = '2px solid #0a84ff';
    installCursor();
    document.body.style.cursor = 'crosshair';
    if (typeof setStatus === 'function') {
      setStatus('msg', `${hatchId ? AD.Hatch.byId(hatchId).label : 'Clear'} — click an object.`);
    }
  }
  function exitPaintMode() {
    document.querySelectorAll('#adHatchGrid > div').forEach(d => d.style.outline = 'none');
    removeCursor();
    document.body.style.cursor = '';
  }
  function installCursor() {
    const can = document.getElementById('canvas') || document.querySelector('canvas');
    if (!can || paintCursor) return;
    paintCursor = (e) => {
      // Hard-gate: if paint mode is not armed, bail immediately — never
      // consume the event so the Select tool behaves normally.
      if (paintHatchId === undefined) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (typeof raycastObjects === 'function') {
        const hits = raycastObjects(e);
        if (hits && hits.length) {
          const obj = hits[0].object.userData.sketchObject;
          if (obj) applyHatchToObject(obj, paintHatchId);
        }
      }
      // One-shot: auto-exit so the user can go back to selecting without
      // having to remember to press Esc.
      exitPaintMode();
    };
    can.addEventListener('pointerdown', paintCursor, true);
    window.addEventListener('keydown', escPaintMode, true);
  }
  function removeCursor() {
    const can = document.getElementById('canvas') || document.querySelector('canvas');
    if (can && paintCursor) can.removeEventListener('pointerdown', paintCursor, true);
    window.removeEventListener('keydown', escPaintMode, true);
    paintCursor = null;
    paintHatchId = undefined;   // fully disarm
  }
  function escPaintMode(e) {
    if (e.key === 'Escape') { exitPaintMode(); e.preventDefault(); }
  }

  /* ---- Entourage panel ------------------------------------------------- */
  function injectEntouragePanel() {
    const right = document.getElementById('rightpanel');
    if (!right) return;
    if (document.getElementById('adEntouragePanel')) return;
    if (!window.AD || !AD.Entourage) return;

    const sec = document.createElement('div');
    sec.className = 'panel-section collapsible';
    sec.id = 'adEntouragePanel';
    sec.style.cssText = 'flex:0 0 auto;';
    sec.innerHTML = `
      <div class="panel-header" data-toggle="adEntBody">
        <span><span class="arrow">▸</span>
          <svg class="panel-icon" viewBox="0 0 24 24" width="16" height="16"
               fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="7" r="2.5"/>
            <path d="M8 9.5 L8 15 M5.5 12 L10.5 12 M6 15 L6 20 M10 15 L10 20"/>
            <path d="M16 6 L16 20 M16 6 Q13 9 13 12 Q13 15 16 15 M16 6 Q19 9 19 12 Q19 15 16 15"/>
          </svg>
          Entourage
        </span>
      </div>
      <div class="panel-body" id="adEntBody" style="padding:8px;display:none;">
        <div id="adEntTabs" style="display:flex;gap:2px;margin-bottom:6px;flex-wrap:wrap;"></div>
        <div id="adEntGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(60px, 1fr));gap:4px;"></div>
        <div style="margin-top:8px;display:flex;gap:4px;">
          <button id="adEntUpload"
            style="flex:1;font-size:10px;padding:4px 6px;border:0.5px solid rgba(0,0,0,0.2);
                   border-radius:5px;background:#f5f5f7;cursor:pointer;"
            title="SVG, PNG (Transparent transparent background recommended), JPG supported">＋ Upload (SVG · PNG · JPG)</button>
        </div>
        <input type="file" id="adEntFile"
               accept=".svg,image/svg+xml,.png,image/png,.jpg,.jpeg,image/jpeg,.ai"
               multiple style="display:none;" />
      </div>`;
    right.appendChild(sec);

    // Collapse toggle (same pattern as HATCH).
    // Toggle is handled centrally in turtle_drawing.html (_wirePanelHeader).
    const tabsEl = sec.querySelector('#adEntTabs');
    const gridEl = sec.querySelector('#adEntGrid');
    let activeCat = 'people';

    const renderGrid = () => {
      gridEl.innerHTML = '';
      for (const item of AD.Entourage.byCategory(activeCat)) {
        const cell = document.createElement('div');
        cell.title = item.label + ' (' + item.height.toFixed(2) + ' m)';
        cell.dataset.item = item.id;
        cell.style.cssText =
          'border-radius:5px;cursor:pointer;border:0.5px solid rgba(0,0,0,0.18);' +
          'background:#fff;overflow:hidden;position:relative;';
        const swatchUrl = item.svgUrl
          ? item.svgUrl
          : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(item.svg);
        cell.innerHTML =
          `<div style="height:56px;display:flex;align-items:center;justify-content:center;">`
          + `<img src="${swatchUrl}" loading="lazy" decoding="async" style="max-height:52px;max-width:90%;"/>`
          + `</div>`
          + `<div style="font-size:9px;padding:1px 2px;text-align:center;color:#333;`
          + `border-top:0.5px solid rgba(0,0,0,0.1);background:#fafafa;">${item.label}</div>`
          + (item.custom && !item.builtin
              ? `<span class="ad-ent-del" title="Remove"
                   style="position:absolute;top:1px;right:2px;width:14px;height:14px;
                          line-height:12px;text-align:center;font-size:10px;color:#b00;
                          cursor:pointer;background:rgba(255,255,255,0.8);border-radius:50%;">×</span>`
              : '');
        cell.addEventListener('click', (ev) => {
          if (ev.target.classList && ev.target.classList.contains('ad-ent-del')) {
            ev.stopPropagation();
            if (AD.Entourage.removeCustom(item.id)) renderGrid();
            return;
          }
          enterPlaceMode(item, cell);
        });
        gridEl.appendChild(cell);
      }
    };
    const renderTabs = () => {
      tabsEl.innerHTML = '';
      for (const cat of AD.Entourage.categories) {
        const btn = document.createElement('button');
        btn.textContent = AD.Entourage.categoryLabel[cat] || cat;
        btn.style.cssText =
          'flex:1;font-size:10px;padding:3px 4px;' +
          'border:0.5px solid rgba(0,0,0,0.2);border-radius:4px;cursor:pointer;' +
          (cat === activeCat ? 'background:#0a84ff;color:#fff;' : 'background:#f5f5f7;color:#333;');
        btn.onclick = () => { activeCat = cat; renderTabs(); renderGrid(); };
        tabsEl.appendChild(btn);
      }
    };
    renderTabs();
    // Defer the thumbnail grid until the panel is first EXPANDED. Rendering
    // it at boot placed ~88 <img> tags (~12 MB of entourage SVGs) inside the
    // display:none body — and hidden images still download, which made this
    // the single largest chunk of the web build's first load.
    let _gridRendered = false;
    const _renderGridOnce = () => {
      if (_gridRendered) return;
      _gridRendered = true;
      renderGrid();
    };
    // Trigger on the grid actually becoming visible, regardless of HOW the
    // panel was opened. There are at least three opening mechanisms: the
    // header click toggle writes body.style.display inline; the collapsed
    // (icon-strip) right panel opens sections as popups via a
    // 'collapsed-active' CLASS with !important CSS (no inline style change);
    // and floating detach sets display directly. An IntersectionObserver on
    // the grid catches all of them; the style/class observers and the header
    // click listener are belt-and-suspenders.
    const bodyEl = sec.querySelector('#adEntBody');
    const _gridMO = new MutationObserver(() => {
      const visible = bodyEl.style.display !== 'none' || sec.classList.contains('collapsed-active');
      if (visible) { _renderGridOnce(); _gridMO.disconnect(); }
    });
    _gridMO.observe(bodyEl, { attributes: true, attributeFilter: ['style'] });
    _gridMO.observe(sec, { attributes: true, attributeFilter: ['class'] });
    if (typeof IntersectionObserver === 'function') {
      const _gridIO = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) { _renderGridOnce(); _gridIO.disconnect(); }
      });
      _gridIO.observe(gridEl);
    }
    sec.querySelector('.panel-header').addEventListener('click', _renderGridOnce);

    // Upload button → file picker → ask for category/height → save.
    const uploadBtn = sec.querySelector('#adEntUpload');
    const fileInput = sec.querySelector('#adEntFile');
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const f of files) {
        const name = f.name.toLowerCase();
        const label = f.name.replace(/\.(svg|png|jpe?g|ai)$/i, '');
        try {
          if (name.endsWith('.ai')) {
            if (typeof showError === 'function') {
              showError(".ai files can't be opened directly.\nIn Illustrator: File → Export As → SVG (or PNG with transparent background), then upload.");
            } else {
              alert('.ai files are not supported. Export to SVG or transparent PNG and upload.');
            }
            continue;
          }
          if (name.endsWith('.svg') || f.type === 'image/svg+xml') {
            const text = await f.text();
            _askEntourageMeta(label, (meta) => {
              if (!meta) return;
              AD.Entourage.addCustom({
                svgText: text,
                label: meta.label,
                category: meta.category,
                height: meta.height,
              });
              activeCat = meta.category;
              renderTabs();
              renderGrid();
            });
          } else if (name.match(/\.(png|jpe?g)$/) || /^image\//.test(f.type)) {
            // Raster — convert to a data-URL and wrap in a minimal SVG
            // so the rest of the pipeline treats it uniformly.
            const rawUrl = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = ev => res(ev.target.result);
              r.onerror = rej;
              r.readAsDataURL(f);
            });
            // Strip a near-white background to alpha so PNG/JPG cutouts
            // sit cleanly in the scene. Flood-fills from each edge so
            // interior white (e.g. inside a shirt) is preserved.
            const { dataUrl, w: pw, h: ph } = await _stripWhiteBg(rawUrl);
            const dims = { w: pw, h: ph };
            const svgText =
              `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${dims.w} ${dims.h}'>`
              + `<image href='${dataUrl}' x='0' y='0' width='${dims.w}' height='${dims.h}'/>`
              + `</svg>`;
            _askEntourageMeta(label, (meta) => {
              if (!meta) return;
              AD.Entourage.addCustom({
                svgText,
                label: meta.label,
                category: meta.category,
                height: meta.height,
              });
              activeCat = meta.category;
              renderTabs();
              renderGrid();
            });
          }
        } catch (err) {
          console.error('[entourage upload]', err);
        }
      }
    });
  }

  /* Small modal: name, category, height for a newly-uploaded SVG. */
  function _askEntourageMeta(defaultLabel, cb) {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:100000;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font:13px -apple-system,sans-serif;';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:16px 20px;min-width:320px;
                  box-shadow:0 8px 24px rgba(0,0,0,0.25);">
        <div style="font-weight:600;margin-bottom:10px;">New entourage item</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="font-size:11px;color:#555;">Name
            <input id="_entLabel" value="${defaultLabel}"
              style="width:100%;padding:4px 8px;border:0.5px solid rgba(0,0,0,0.25);border-radius:4px;" />
          </label>
          <label style="font-size:11px;color:#555;">Category
            <select id="_entCat"
              style="width:100%;padding:4px 8px;border:0.5px solid rgba(0,0,0,0.25);border-radius:4px;">
              <option value="people">People</option>
              <option value="plants">Plants</option>
              <option value="furniture">Furniture</option>
              <option value="vehicles">Vehicles</option>
              <option value="custom" selected>Custom</option>
            </select>
          </label>
          <label style="font-size:11px;color:#555;">Real height (m)
            <input id="_entHeight" type="number" step="0.05" value="1.70"
              style="width:100%;padding:4px 8px;border:0.5px solid rgba(0,0,0,0.25);border-radius:4px;" />
          </label>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px;">
          <button id="_entCancel"
            style="padding:4px 12px;border:0.5px solid rgba(0,0,0,0.25);
                   border-radius:4px;background:#f5f5f7;cursor:pointer;">Cancel</button>
          <button id="_entOK"
            style="padding:4px 12px;border:none;border-radius:4px;
                   background:#0a84ff;color:#fff;cursor:pointer;">Add</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = (val) => { try { wrap.remove(); } catch (_) {} cb(val); };
    wrap.querySelector('#_entCancel').onclick = () => close(null);
    wrap.querySelector('#_entOK').onclick = () => {
      const label = wrap.querySelector('#_entLabel').value.trim() || defaultLabel;
      const category = wrap.querySelector('#_entCat').value;
      const height = parseFloat(wrap.querySelector('#_entHeight').value) || 1.7;
      close({ label, category, height });
    };
  }

  /* Place-mode for entourage — click a swatch, click viewport to drop. */
  let placeItem = null;
  let placeCursor = null;

  function enterPlaceMode(item, cellEl) {
    placeItem = item;
    document.querySelectorAll('#adEntGrid > div').forEach(d => d.style.outline = 'none');
    if (cellEl) cellEl.style.outline = '2px solid #0a84ff';
    installPlaceCursor();
    document.body.style.cursor = 'crosshair';
    if (typeof setStatus === 'function') {
      setStatus('msg', `${item.label} — click viewport to place, Esc to cancel.`);
    }
  }
  function exitPlaceMode() {
    placeItem = null;
    document.querySelectorAll('#adEntGrid > div').forEach(d => d.style.outline = 'none');
    removePlaceCursor();
    document.body.style.cursor = '';
  }
  function installPlaceCursor() {
    const can = document.getElementById('canvas') || document.querySelector('canvas');
    if (!can || placeCursor) return;
    placeCursor = (e) => {
      if (!placeItem) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      // Ray-cast to scene to find placement; ground plane y=0 as fallback.
      let worldPos = null;
      try {
        if (typeof ndc === 'function' && typeof raycaster !== 'undefined') {
          ndc(e);
          raycaster.setFromCamera(pointer, camera);
          let hits = raycaster.intersectObjects(
            Model.objects.filter(o => o.group.visible).map(o => o.mesh), false);
          // Filter out hits on the clipped-away side of active section planes
          const activeSPs = (Model.sectionPlanes || []).filter(sp => sp.enabled);
          if (activeSPs.length) {
            hits = hits.filter(h => activeSPs.every(sp => sp.plane.distanceToPoint(h.point) >= -0.001));
          }
          if (hits && hits.length) worldPos = hits[0].point.clone();
          else {
            const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
            const p = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(ground, p)) worldPos = p;
          }
        }
      } catch (_) {}
      if (!worldPos) worldPos = new THREE.Vector3(0, 0, 0);
      AD.Entourage.placeAt(placeItem, worldPos);
      exitPlaceMode();
    };
    can.addEventListener('pointerdown', placeCursor, true);
    window.addEventListener('keydown', escPlaceMode, true);
  }
  function removePlaceCursor() {
    const can = document.getElementById('canvas') || document.querySelector('canvas');
    if (can && placeCursor) can.removeEventListener('pointerdown', placeCursor, true);
    window.removeEventListener('keydown', escPlaceMode, true);
    placeCursor = null;
  }
  function escPlaceMode(e) {
    if (e.key === 'Escape') { exitPlaceMode(); e.preventDefault(); }
  }

  function applyHatchToObject(obj, hatchId) {
    AD.Core.ensureMetadata(obj);
    const activeSP = (Model.sectionPlanes || []).find(sp => sp.enabled);
    if (activeSP) {
      if (hatchId) obj.ad.hatchAt.set(activeSP, hatchId);
      else         obj.ad.hatchAt.delete(activeSP);
    } else {
      obj.ad.material = hatchId;
    }
    // Real vector line hatch on the 3D faces (not a bitmap texture).
    if (AD.HatchLines && typeof AD.HatchLines.apply === 'function') {
      AD.HatchLines.apply(obj, hatchId);
    }
    if (typeof setStatus === 'function') {
      setStatus('msg', `${obj.name} ← ${hatchId ? AD.Hatch.byId(hatchId).label : 'Remove hatch'}` +
        (activeSP ? ' (this section only)' : ''));
    }
  }

  function swatchDataUrl(pattern) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60'>
                   ${pattern.svg.replace(/id="h_\w+"/, 'id="tile"')}
                   <rect width='60' height='60' fill='url(#tile)'/>
                 </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }


  /* ---- Section-plane affordance --------------------------------------- */
  /* Double-clicking a section plane already activates it in Turtle Drawing.
     We hook in after that so the Hatch panel auto-opens and the user
     can immediately start tagging cut faces. */
  function bindSectionPlaneDblClick() {
    const can = document.getElementById('canvas') || document.querySelector('canvas');
    if (!can) return;
    can.addEventListener('dblclick', () => {
      setTimeout(() => {
        if ((Model.sectionPlanes || []).some(sp => sp.enabled)) {
          const body = document.getElementById('adHatchBody');
          if (body) body.style.display = 'block';
        }
      }, 60);
    });
  }
})();
