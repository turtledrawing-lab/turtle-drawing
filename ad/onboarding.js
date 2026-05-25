/* ============================================================================
   Onboarding Tour — modern comic-style speech bubble with mascot Toby,
   live UI demos for every step. English copy by default.
   ============================================================================ */
(function () {
  /* Build one tour step that demos a single drawing tool: cursor clicks the
     toolbar icon, then click1 → drag (rubber-band) → click2 in the viewport
     at coordinates that correctly project onto the 3D ground plane so the
     final shape lands exactly where the cursor clicked. */
  function _toolStep(toolLabel, body, _unusedToolBtnY, rbType, color, finalize, off1, off2) {
    // rbType doubles as the toolbar data-tool id (line / rect / circle)
    const toolId = rbType;
    return {
      // Point the bubble tail at the actual icon button so it lines up
      sel: `[data-tool="${toolId}"]`,
      title: toolLabel,
      body,
      pos: 'right',
      demo: function () {
        _clearDemo();
        _hideExisting();
        const btn = document.querySelector(`[data-tool="${toolId}"]`);
        // Light up the icon like the real tool selection (blue active state)
        if (btn) btn.classList.add('active');
        const [vx, vy] = _viewportCenter();
        let p1 = [vx + off1[0], vy + off1[1] + 60];
        let p2 = [vx + off2[0], vy + off2[1] + 60];
        // For the Line tool, snap p2 in WORLD space to be axis-aligned with
        // p1, then project back to screen so cursor/anchor match the line.
        if (toolId === 'line') {
          const wA = _screenToGround(p1[0], p1[1]);
          const wB = _screenToGround(p2[0], p2[1]);
          if (wA && wB) {
            const ddx = Math.abs(wB.x - wA.x), ddz = Math.abs(wB.z - wA.z);
            const snapped = (ddx >= ddz)
              ? new THREE.Vector3(wB.x, 0, wA.z)
              : new THREE.Vector3(wA.x, 0, wB.z);
            p2 = _worldToScreen(snapped);
          }
        }
        const seq = [];
        if (btn) {
          const br = btn.getBoundingClientRect();
          const ix = br.left + br.width / 2, iy = br.top + br.height / 2;
          seq.push({ move: [ix, iy], delay: 200 });
          seq.push({ click: [ix, iy], delay: 400 });
        }
        // Step 1 — click first point
        seq.push({ delay: 300, run: () => _showKey('1. Click first point', vx + 40, vy + 180) });
        seq.push({ move: p1, delay: 700 });
        seq.push({ click: p1, delay: 700, run: () => {
          _dropAnchor(p1[0], p1[1], color);
          _rbStart(rbType, p1[0], p1[1], color);
          _hideKey();
        } });
        // Step 2 — click second point
        seq.push({ delay: 300, run: () => _showKey('2. Click second point', vx + 40, vy + 180) });
        seq.push({ move: p2, delay: 800, run: () => _rbUpdate(p2[0], p2[1]) });
        seq.push({ click: p2, delay: 1100, run: () => {
          _rbClear();
          _dropAnchor(p2[0], p2[1], color);
          _hideKey();
          const wA = _screenToGround(p1[0], p1[1]);
          const wB = _screenToGround(p2[0], p2[1]);
          finalize(wA, wB);
          if (btn) btn.classList.remove('active');
        } });
        _scriptCursor(seq);
      },
    };
  }

  const STEPS = [
    {
      sel: '#viewport',
      title: "Hi! I'm Toby 🐢",
      body: "Welcome to Turtle Drawing.\nI'll walk you through the core features — and show each one live in the viewport.\n\n<b>← →</b> navigate · <b>Esc</b> exit · or hit <b>Skip</b> any time.",
      pos: 'center',
    },
    _toolStep('Line (L)',      'Pick the <b>Line</b> tool from the toolbar.\n\nClick the <b>first point</b>, move, then click the <b>second point</b>.',      130, 'line',   '#0a84ff', _ensureDemoLine,   [-150, 80],    [150, -80]),
    _toolStep('Rectangle (R)', 'Pick the <b>Rectangle</b> tool.\n\nClick one corner, drag to the opposite corner and click again.',                     165, 'rect',   '#34c759', _ensureDemoRect,   [-130, -80],   [130, 80]),
    _toolStep('Circle (C)',    'Pick the <b>Circle</b> tool.\n\nClick the <b>center</b>, then click a second point to set the <b>radius</b>.',           200, 'circle', '#ff9500', _ensureDemoCircle, [0, 0],        [120, 0]),
    {
      sel: '#viewport',
      title: 'Extrude (P) — step by step',
      body: '<b>1.</b> Draw a flat face\n<b>2.</b> Press <b>P</b> (Extrude)\n<b>3.</b> Drag the face up\n<b>4.</b> Push the other way to cut a hole\n\nWatch the cursor sketch and pull ⤵️',
      pos: 'top-left',
      demo: function () {
        _clearDemo();
        _hideExisting();
        const [vx, vy] = _viewportCenter();
        _scriptCursor([
          // Step 1 — pick Rectangle tool (visual cue)
          { delay: 200, run: () => _showKey('1. Draw a face', vx - 100, vy + 140) },
          { move: [vx - 70, vy + 120], delay: 600 },
          { click: [vx - 70, vy + 120], delay: 500, run: () => {
            _hideKey();
            _dropAnchor(vx - 70, vy + 120, '#0a84ff');
            _rbStart('rect', vx - 70, vy + 120, '#0a84ff');
            _showKey('Drag to set the face…', vx, vy + 200);
          } },
          { move: [vx + 70, vy + 40], delay: 200, run: () => _rbUpdate(vx + 70, vy + 40) },
          { click: [vx + 70, vy + 40], delay: 1100, run: () => {
            _rbClear();
            _dropAnchor(vx + 70, vy + 40, '#0a84ff');
            _hideKey();
            const wA = _screenToGround(vx - 70, vy + 120);
            const wB = _screenToGround(vx + 70, vy + 40);
            _ensureDemoFlatRect(wA, wB);
          } },
          // Step 2 — press P
          { delay: 400, run: () => _showKey('2. Press P', vx + 40, vy + 100) },
          { delay: 700, run: () => { _hideKey(); _showKey('P', vx + 40, vy + 40); } },
          // Step 3 — drag the face up (arrow indicator follows cursor)
          { delay: 500, run: () => {
            _hideKey();
            _showKey('3. Drag up', vx + 50, vy + 40);
            _ppArrowShow(vx, vy + 20);
          } },
          { move: [vx, vy + 20], delay: 200 },
          { move: [vx, vy - 80], delay: 900, run: () => {
            _ppArrowMove(vx, vy - 80);
            _animateDemoExtrude();
          } },
          { delay: 1800, run: () => { _hideKey(); _ppArrowHide(); } },
        ]);
      },
    },
    {
      sel: '#viewport',
      title: 'Viewport controls',
      body: '<b>🖱️ Middle-drag</b> orbit\n<b>🖱️ Shift + middle-drag</b> pan\n<b>🖱️ Wheel</b> zoom\n\n<b>⌨️ Space</b> tool ↔ select · <b>F</b> frame · <b>Esc</b> cancel',
      pos: 'top-left',
      demo: function () {
        _clearDemo();
        _hideExisting();
        const ref = _makeBox(0, 0.5, 0, 1.4, 1, 1.4, '#d7c9a8', 'Demo Ref');
        ref._isOnboardingDemo = true;
        addObject(ref); ref.rebuild && ref.rebuild();
        _demoObjs.push(ref);
        const cam = (typeof camera !== 'undefined') ? camera : window.camera;
        const ctrl = (typeof controls !== 'undefined') ? controls : window.controls;
        if (!cam || !ctrl) return;
        // Temporarily disable user input AND no-op controls.update — by
        // default update() recomputes camera position from its internal
        // spherical, which would snap our manual moves back to the start.
        const prevEnabled = ctrl.enabled;
        const prevUpdate  = ctrl.update;
        ctrl.enabled = false;
        ctrl.update  = function () {};
        const origPos = cam.position.clone();
        const origTgt = ctrl.target ? ctrl.target.clone() : new THREE.Vector3();
        const radius = origPos.distanceTo(origTgt);
        const theta0 = Math.atan2(origPos.x - origTgt.x, origPos.z - origTgt.z);
        const phi0   = Math.asin((origPos.y - origTgt.y) / radius);
        const [vx, vy] = _viewportCenter();
        _ensureCursor();

        function setSpherical(theta, phi, r) {
          cam.position.set(
            origTgt.x + r * Math.cos(phi) * Math.sin(theta),
            origTgt.y + r * Math.sin(phi),
            origTgt.z + r * Math.cos(phi) * Math.cos(theta)
          );
          cam.lookAt(origTgt);
        }

        // === 1. ORBIT — sweep theta around in a smooth arc ===
        _showKey('🖱️ Middle-drag = orbit', vx + 30, vy - 30);
        _moveCursor(vx - 80, vy);
        let i = 0;
        const FR1 = 60;
        const orbitTimer = setInterval(() => {
          i++;
          const t = i / FR1;
          const dT = Math.sin(t * Math.PI * 2) * 0.8;
          const dP = Math.sin(t * Math.PI * 2 + Math.PI / 2) * 0.15;
          setSpherical(theta0 + dT, phi0 + dP, radius);
          _moveCursor(vx - 80 + dT * 60, vy + dP * 200);
          if (i >= FR1) {
            clearInterval(orbitTimer);
            cam.position.copy(origPos); cam.lookAt(origTgt);
            startPan();
          }
        }, 40);

        // === 2. PAN — slide controls.target sideways then back ===
        function startPan() {
          _hideKey();
          _showKey('Shift + Middle-drag = pan', vx + 30, vy - 30);
          _moveCursor(vx, vy);
          const startTgt = ctrl.target.clone();
          const startPos = cam.position.clone();
          let j = 0; const FR = 50;
          const panTimer = setInterval(() => {
            j++;
            const t = j / FR;
            const dx = Math.sin(t * Math.PI * 2) * 1.5;
            ctrl.target.set(startTgt.x + dx, startTgt.y, startTgt.z);
            cam.position.set(startPos.x + dx, startPos.y, startPos.z);
            _moveCursor(vx + dx * 60, vy);
            if (j >= FR) {
              clearInterval(panTimer);
              ctrl.target.copy(startTgt); cam.position.copy(startPos);
              startZoom();
            }
          }, 40);
        }

        // === 3. ZOOM — dolly camera in then out ===
        function startZoom() {
          _hideKey();
          _showKey('Wheel = zoom', vx + 30, vy - 30);
          _moveCursor(vx, vy);
          const startPos = cam.position.clone();
          const tgt = ctrl.target.clone();
          let k = 0; const FR = 50;
          const zoomTimer = setInterval(() => {
            k++;
            const t = k / FR;
            const f = 1 + Math.sin(t * Math.PI * 2) * 0.30;
            const dir = new THREE.Vector3().subVectors(startPos, tgt);
            cam.position.copy(tgt).add(dir.multiplyScalar(f));
            if (k >= FR) {
              clearInterval(zoomTimer);
              cam.position.copy(origPos);
              ctrl.target.copy(origTgt);
              _hideKey();
              ctrl.enabled = prevEnabled;
              ctrl.update  = prevUpdate;
              ctrl.update();
            }
          }, 40);
        }
      },
    },
    {
      sel: '#rightpanel',
      title: 'Side panel — 3 modes',
      body: "<b>1.</b> Full panel (default)\n<b>2.</b> Collapsed — click an icon to peek at one section\n<b>3.</b> Popped out — section floats as its own panel\n\nWatch me cycle through ⤵️",
      pos: 'left',
      demo: function () {
        const btn = document.getElementById('rightPanelCollapse');
        const rp  = document.getElementById('rightpanel');
        if (!btn || !rp) return;
        const matSec = document.querySelector('#materialSection');
        _ensureCursor();
        // Helper: move the spotlight ring to a fresh element each phase
        const moveRing = (el) => { if (el) placeRing(el); };
        // === Phase 1: Collapse to icon strip ===
        moveRing(btn);
        _setT(() => {
          if (!rp.classList.contains('is-collapsed')) try { btn.click(); } catch (_) {}
          const br = btn.getBoundingClientRect();
          _moveCursor(br.left + br.width / 2, br.top + br.height / 2);
          _clickFx(br.left + br.width / 2, br.top + br.height / 2);
        }, 300);
        // === Phase 2: Click the icon → popup appears ===
        _setT(() => {
          if (!matSec) return;
          const header = matSec.querySelector('.panel-header');
          if (!header) return;
          moveRing(header);
          const hr = header.getBoundingClientRect();
          const x = hr.left + hr.width / 2, y = hr.top + hr.height / 2;
          _moveCursor(x, y);
          _clickFx(x, y);
          // The app's listener on #rightpanel (CAPTURE phase, `click`
          // event) toggles .collapsed-active and sets --popup-top.
          try {
            header.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, clientX: x, clientY: y,
            }));
          } catch (_) {}
          // After popup opens, move ring onto it
          _setT(() => {
            if (matSec.classList.contains('collapsed-active')) {
              moveRing(matSec);
            }
          }, 350);
        }, 1800);
        // === Phase 3: Close popup, expand full panel ===
        _setT(() => {
          if (matSec) {
            matSec.classList.remove('collapsed-active');
            matSec.style.removeProperty('--popup-top');
          }
          if (rp.classList.contains('is-collapsed')) try { btn.click(); } catch (_) {}
          moveRing(btn);
          const br = btn.getBoundingClientRect();
          _moveCursor(br.left + br.width / 2, br.top + br.height / 2);
          _clickFx(br.left + br.width / 2, br.top + br.height / 2);
          // Then highlight the whole expanded rightpanel
          _setT(() => moveRing(rp), 400);
        }, 4000);
      },
    },
    {
      sel: '#layersList',
      title: 'Layers (CAD-style)',
      body: 'Group, hide and lock objects with layers.\n\n• Per-layer <b>line weight (mm)</b> drives export hierarchy\n• Per-layer <b>hatch pattern</b> fills cuts automatically\n• Color-coded for quick reading',
      pos: 'left',
      expand: '#layersList',
    },
    {
      sel: '#materialSection',
      title: 'Materials',
      body: 'Select an object and paint it.\n\n• <b>Wheel</b>, <b>Sliders</b>, <b>Spectrum</b> tabs\n• Paint bucket auto-opens this panel\n• Drag in an image as a texture\n• Save favorites to the library',
      pos: 'left',
      expand: '#materialSection',
    },
    {
      sel: '#viewport',
      title: 'Section Plane',
      body: "Slice the model to see inside.\n\nI'm dropping a cube and cutting it from the front. The cut face fills with hatch automatically via the layer settings.\n\nNext: a real wall assembly on the cut side ⤵️",
      pos: 'top-left',
      demo: function () {
        _clearDemo();
        _hideExisting();
        // Ensure the active layer has NO hatch when the cut first appears —
        // otherwise leftover hatch from a previous demo would show the
        // diagonal pattern immediately.
        try {
          if (Array.isArray(Model.layers)) {
            if (!_origLayerHatchMap) _origLayerHatchMap = new Map();
            for (const L of Model.layers) {
              if (!_origLayerHatchMap.has(L.id)) _origLayerHatchMap.set(L.id, L.cutHatch ?? null);
              L.cutHatch = null;
            }
          }
        } catch (_) {}
        _ensureDemoCube();
        _setT(() => _ensureDemoSection(), 600);
        // Cycle through 3 hatch patterns so users see the effect
        _setT(() => _applyDemoHatch('brick'),             1800);
        _setT(() => _applyDemoHatch('concrete_exposed'),  3300);
        _setT(() => _applyDemoHatch('tile'),              4800);
      },
    },
    {
      sel: '#wallLayerSection',
      title: 'Wall Layers',
      body: "Pick a wall face → stack <b>layers</b> (finish + insulation + structure) outward.\n\nWatch the cursor: it grabs the side face, then clicks <b>Generate</b>. New material slabs appear on the outside of the cube ⤵️",
      pos: 'left',
      expand: '#wallLayerSection',
      demo: function () {
        _ensureDemoCube();
        _ensureDemoSection();
        const [vx, vy] = _viewportCenter();
        const sideX = vx + 140;   // approx position of +X face on screen
        const sideY = vy;
        const genBtn = document.getElementById('wallLayerApplyBtn');
        const r = genBtn ? genBtn.getBoundingClientRect() : null;
        const bx = r ? r.left + r.width / 2 : window.innerWidth - 120;
        const by = r ? r.top  + r.height / 2 : 400;
        _scriptCursor([
          { move: [sideX, sideY], delay: 200 },
          { click: [sideX, sideY], delay: 700 },
          { move: [bx, by], delay: 400 },
          { click: [bx, by], delay: 500, run: _applyDemoWallLayersOnSide },
        ]);
      },
    },
    {
      sel: '#wallToolSection',
      title: 'Wall Tool',
      body: 'Draw walls with <b>thickness & height</b> in one stroke.\n\n• Click the start point, then click each successive point\n• Corners auto-align (mitered join)\n• Set wall thickness and height in this panel\n• Add openings for windows & doors later',
      pos: 'left',
      expand: '#wallToolSection',
    },
    {
      sel: '[data-toggle="sceneTabsBody"], #sceneTabsBody',
      title: 'Scenes',
      body: "Capture camera + section state as a <b>Scene</b>.\n\n• <b>+ Add</b> to save the current view\n• Click to fly back to it\n• Perfect for presentations & portfolio shots",
      pos: 'left',
      expand: '#sceneTabsBody',
      _disabled_demo: function () {
        _clearDemo();
        _hideExisting();
        // Drop a reference box so camera moves are perceptible
        const ref = _makeBox(0, 0.5, 0, 1.6, 1, 1.6, '#d7c9a8', 'Demo Ref');
        ref._isOnboardingDemo = true; addObject(ref); ref.rebuild && ref.rebuild();
        _demoObjs.push(ref);
        const cam = (typeof camera !== 'undefined') ? camera : window.camera;
        const ctrl = (typeof controls !== 'undefined') ? controls : window.controls;
        const addSceneFn = (typeof addScene === 'function') ? addScene : window.addScene;
        const activateSceneFn = (typeof activateScene === 'function') ? activateScene : window.activateScene;
        if (!cam || !ctrl || typeof addSceneFn !== 'function' || typeof activateSceneFn !== 'function') {
          console.warn('[onboarding] Scenes API not found');
          return;
        }
        const tgt = ctrl.target.clone();
        const savedIds = [];
        // 1) Move to View A (front-on) and save
        setTimeout(() => {
          cam.position.set(tgt.x, tgt.y + 1.5, tgt.z + 8);
          if (ctrl.target) ctrl.target.copy(tgt);
          cam.lookAt(tgt); if (ctrl.update) ctrl.update();
          addSceneFn('Tour A');
          const last = Model.scenes[Model.scenes.length - 1];
          if (last) { savedIds.push(last.id); last._isOnboardingDemo = true; }
          if (typeof renderSceneTabs === 'function') renderSceneTabs();
        }, 600);
        // 2) Move to View B (top-down) and save
        setTimeout(() => {
          cam.position.set(tgt.x, tgt.y + 8, tgt.z + 0.5);
          if (ctrl.target) ctrl.target.copy(tgt);
          cam.lookAt(tgt); if (ctrl.update) ctrl.update();
          addSceneFn('Tour B');
          const last = Model.scenes[Model.scenes.length - 1];
          if (last) { savedIds.push(last.id); last._isOnboardingDemo = true; }
        }, 1900);
        // 3) Activate A
        setTimeout(() => { if (savedIds[0]) activateSceneFn(savedIds[0], true); }, 3300);
        // 4) Activate B
        setTimeout(() => { if (savedIds[1]) activateSceneFn(savedIds[1], true); }, 5000);
        // 5) Cleanup demo scenes when the user leaves the step (handled in _clearDemo)
        // Track ids so we can delete on cleanup
        _demoSceneIds = savedIds;
      },
    },
    {
      sel: '#adEntouragePanel, [data-panel="entourage"]',
      title: 'Entourage',
      body: 'Drag in trees, people, furniture, vehicles…\n\nPick from the panel, then click in the viewport to drop. Watch me place a person ⤵️',
      pos: 'left',
      expand: '#adEntouragePanel',
      demo: function () {
        _clearDemo();
        _hideExisting();
        const [vx, vy] = _viewportCenter();
        const panel = document.getElementById('adEntouragePanel');
        if (!panel) return;
        // Grab the first entourage swatch in the panel grid
        const swatch = panel.querySelector('.ent-card, button, [data-ent-id]')
          || panel.querySelector('img');
        const sr = swatch ? swatch.getBoundingClientRect() : panel.getBoundingClientRect();
        const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
        // Drop ONE person + ONE plant for a clean composition.
        const drops = [
          [vx - 80,  vy + 100],
          [vx + 80, vy + 100],
        ];
        const items = [];
        if (window.AD && AD.Entourage && AD.Entourage.byCategory) {
          const ppl = AD.Entourage.byCategory('people') || [];
          if (ppl[0]) items.push(ppl[0]);
          if (ppl[1]) items.push(ppl[1]);
          else if (ppl[0]) items.push(ppl[0]); // fallback to same if only one
        }
        const place = (dp, idx) => {
          const w = _screenToGround(dp[0], dp[1]);
          const item = items[idx % Math.max(1, items.length)];
          if (!item || !window.AD || !AD.Entourage || !AD.Entourage.placeAt) return;
          try {
            const before = new Set(Model.objects);
            AD.Entourage.placeAt(item, w || new THREE.Vector3(0, 0, 0));
            for (const o of Model.objects) {
              if (!before.has(o)) { o._isOnboardingDemo = true; _demoObjs.push(o); }
            }
          } catch (e) { console.warn('[onboarding] entourage placeAt failed', e); }
        };
        const seq = [
          { move: [sx, sy], delay: 300 },
          { click: [sx, sy], delay: 500, run: () => {
            _showKey('Pick an item', sx + 30, sy);
            if (swatch && typeof swatch.click === 'function') {
              try { swatch.click(); } catch (_) {}
            }
          } },
        ];
        // Drop 3 sequentially
        for (let i = 0; i < drops.length; i++) {
          const dp = drops[i];
          seq.push({ delay: 500, run: () => _showKey('Click in the viewport (' + (i + 1) + '/' + drops.length + ')', dp[0] + 30, dp[1] - 30) });
          seq.push({ move: dp, delay: 700 });
          seq.push({ click: dp, delay: 600, run: ((j) => () => { place(dp, j); _hideKey(); })(i) });
        }
        _scriptCursor(seq);
      },
    },
    {
      sel: '[data-toggle="outlinerList"], #outlinerList',
      title: 'Objects',
      body: 'Every object, group and section in one tree.\n\n• Click to select, double-click to enter a group\n• Rename, lock, hide inline\n• Stay oriented in complex scenes',
      pos: 'left',
      expand: '#outlinerList',
    },
    {
      sel: '[data-toggle="historyBody"], #historyBody',
      title: 'History',
      body: 'Every action is recorded.\n\n• <b>Cmd+Z</b> / <b>Cmd+Shift+Z</b>\n• Jump back to any earlier state from this panel\n• Experiment freely!',
      pos: 'left',
      expand: '#historyBody',
    },
    {
      sel: '#menubar, body',
      title: 'Save & export',
      body: 'Use the <b>File menu</b>:\n\n• Save as <b>.tt</b> (Cmd+S)\n• Export <b>SVG / PNG</b> with auto-labelled drawing sheets\n• Drag a tab out of the window to detach it',
      pos: 'bottom',
    },
    {
      sel: '#viewport',
      title: "You're ready! 🎉",
      body: "That's the tour — go draw something 🐢💨\n\n• Shortcuts make all the difference; most tools are a single letter.\n• Stuck? Open <b>Help → Onboarding Tour</b> any time.\n\nHave fun!",
      // Position the bubble lower-right so the mascot reads as a small
      // figure standing in the viewport speaking to the user.
      pos: 'top-right',
      demo: function () { _restoreExisting(); _clearDemo(); },
    },
  ];

  /* ==================== Demo state =================================== */
  let _demoObjs = [];
  let _demoCubeObj = null;
  let _demoFlatObj = null;
  let _demoSectionPlane = null;
  let _demoWallApplied = false;
  let _origLayerHatch = null;
  let _hiddenExisting = [];   // [{obj, prevVisible}]
  let _extrudeTimer = null;
  let _demoSceneIds = [];
  let _origLayerHatchMap = null;
  let _tourStartObjects = null;
  let _tourStartScenes  = null;
  // Tracked setTimeouts so we can cancel ALL pending timers on step change
  // and prevent leftover sequences from previous steps clobbering the
  // current one.
  let _pendingTimers = [];
  function _setT(fn, delay) {
    const id = setTimeout(() => {
      try { fn(); } catch (e) { console.warn('[onboarding] timer error', e); }
    }, delay);
    _pendingTimers.push(id);
    return id;
  }
  function _clearAllTimers() {
    for (const id of _pendingTimers) clearTimeout(id);
    _pendingTimers = [];
  }

  function _track(obj) { obj._isOnboardingDemo = true; _demoObjs.push(obj); }

  /* -------------------- Virtual mouse cursor ------------------------ */
  let _cursorEl = null, _keyEl = null;
  function _ensureCursor() {
    if (_cursorEl) return _cursorEl;
    _cursorEl = document.createElement('div');
    _cursorEl.className = '_obCursor';
    _cursorEl.innerHTML = `<svg viewBox="0 0 22 30">
      <path d="M2 2 L20 16 L12 17 L17 27 L13 29 L8 19 L2 24 Z"
        fill="#fff" stroke="#1a1208" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    _cursorEl.style.left = '-100px'; _cursorEl.style.top = '-100px';
    document.body.appendChild(_cursorEl);
    return _cursorEl;
  }
  function _moveCursor(x, y) {
    _ensureCursor();
    _cursorEl.style.left = x + 'px';
    _cursorEl.style.top  = y + 'px';
  }
  function _clickFx(x, y) {
    const el = document.createElement('div');
    el.className = '_obClick';
    el.style.left = x + 'px'; el.style.top = y + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('fire'));
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
  }
  function _showKey(label, x, y) {
    if (!_keyEl) {
      _keyEl = document.createElement('div');
      _keyEl.className = '_obKey';
      document.body.appendChild(_keyEl);
    }
    _keyEl.textContent = label;
    _keyEl.style.left = x + 'px';
    _keyEl.style.top  = y + 'px';
    _keyEl.classList.add('show');
  }
  function _hideKey() { if (_keyEl) _keyEl.classList.remove('show'); }
  function _hideCursor() {
    if (_cursorEl && _cursorEl.parentNode) _cursorEl.parentNode.removeChild(_cursorEl);
    if (_keyEl && _keyEl.parentNode) _keyEl.parentNode.removeChild(_keyEl);
    _cursorEl = null; _keyEl = null;
    _rbClear();
    _clearAnchors();
    _ppArrowHide();
  }
  // Tween cursor through a series of {x,y,delay,onArrive} waypoints
  function _scriptCursor(steps) {
    _ensureCursor();
    let t = 0;
    for (const s of steps) {
      t += (s.delay || 0);
      _setT(() => {
        if (s.move) _moveCursor(s.move[0], s.move[1]);
        if (s.click) _clickFx(s.click[0], s.click[1]);
        if (s.key) _showKey(s.key[0], s.key[1], s.key[2]);
        if (s.hideKey) _hideKey();
        if (s.run) try { s.run(); } catch (_) {}
      }, t);
    }
  }
  /* Rubber-band drawing preview — a translucent shape that grows from p1
     to p2 over `dur` ms via CSS transitions, mimicking what the user sees
     while drawing a primitive. */
  let _rb = null;
  /* Up-arrow indicator that floats above the cursor during Push/Pull's
     drag phase — mimics the small directional arrow the real tool shows. */
  let _ppArrow = null;
  function _ppArrowShow(x, y) {
    if (_ppArrow) _ppArrowHide();
    _ppArrow = document.createElement('div');
    Object.assign(_ppArrow.style, {
      position: 'fixed', left: (x - 12) + 'px', top: (y - 60) + 'px',
      width: '24px', height: '60px', zIndex: '1000002', pointerEvents: 'none',
      transition: 'top 0.5s cubic-bezier(.4,.4,.6,1)',
    });
    _ppArrow.innerHTML = `<svg viewBox="0 0 24 60" width="24" height="60">
      <line x1="12" y1="55" x2="12" y2="15" stroke="#0a84ff" stroke-width="3" stroke-linecap="round"/>
      <polygon points="12,5 4,17 20,17" fill="#0a84ff"/>
    </svg>`;
    document.body.appendChild(_ppArrow);
  }
  function _ppArrowMove(x, y) {
    if (!_ppArrow) return;
    _ppArrow.style.left = (x - 12) + 'px';
    _ppArrow.style.top  = (y - 60) + 'px';
  }
  function _ppArrowHide() {
    if (_ppArrow && _ppArrow.parentNode) _ppArrow.parentNode.removeChild(_ppArrow);
    _ppArrow = null;
  }

  function _rbStart(type, x1, y1, color) {
    _rbClear();
    _rb = document.createElement('div');
    _rb.style.cssText = 'position:fixed;pointer-events:none;z-index:1000001;';
    if (type === 'line') {
      _rb.innerHTML = `<svg style="overflow:visible;width:1px;height:1px;"><line id="_rbl" x1="${x1}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="6 4"/></svg>`;
    } else if (type === 'rect') {
      _rb.innerHTML = `<svg style="overflow:visible;width:1px;height:1px;"><rect id="_rbl" x="${x1}" y="${y1}" width="0" height="0" fill="${color}AA" stroke="${color}" stroke-width="2"/></svg>`;
      _rb._origin = [x1, y1];
    } else if (type === 'circle') {
      _rb.innerHTML = `<svg style="overflow:visible;width:1px;height:1px;"><circle id="_rbl" cx="${x1}" cy="${y1}" r="0" fill="${color}AA" stroke="${color}" stroke-width="2"/></svg>`;
      _rb._origin = [x1, y1];
    }
    _rb._type = type;
    document.body.appendChild(_rb);
    // Add CSS transition to the inner element so attribute changes animate
    const inner = _rb.querySelector('#_rbl');
    if (inner) inner.style.transition = 'all 0.9s cubic-bezier(.4,.4,.6,1)';
  }
  function _rbUpdate(x2, y2) {
    if (!_rb) return;
    const inner = _rb.querySelector('#_rbl');
    if (!inner) return;
    const type = _rb._type;
    if (type === 'line') {
      inner.setAttribute('x2', x2);
      inner.setAttribute('y2', y2);
    } else if (type === 'rect') {
      const [ox, oy] = _rb._origin;
      const x = Math.min(ox, x2), y = Math.min(oy, y2);
      const w = Math.abs(x2 - ox), h = Math.abs(y2 - oy);
      inner.setAttribute('x', x); inner.setAttribute('y', y);
      inner.setAttribute('width', w); inner.setAttribute('height', h);
    } else if (type === 'circle') {
      const [ox, oy] = _rb._origin;
      const r = Math.hypot(x2 - ox, y2 - oy);
      inner.setAttribute('r', r);
    }
  }
  function _rbClear() {
    if (_rb && _rb.parentNode) _rb.parentNode.removeChild(_rb);
    _rb = null;
  }

  // Persistent click marker — drops a small dot at (x,y) that lingers until
  // _clearAnchors() so users can see the "first point" of a 2-click draw.
  let _anchors = [];
  function _dropAnchor(x, y, color) {
    const d = document.createElement('div');
    Object.assign(d.style, {
      position: 'fixed', left: (x - 6) + 'px', top: (y - 6) + 'px',
      width: '12px', height: '12px', borderRadius: '50%',
      background: color || '#0a84ff',
      border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      zIndex: '1000001', pointerEvents: 'none',
    });
    document.body.appendChild(d);
    _anchors.push(d);
  }
  function _clearAnchors() {
    for (const a of _anchors) { if (a.parentNode) a.parentNode.removeChild(a); }
    _anchors = [];
  }

  function _viewportCenter() {
    const vp = document.getElementById('viewport');
    if (!vp) return [window.innerWidth / 2, window.innerHeight / 2];
    const r = vp.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }
  function _activeLayerId() { return (typeof Model !== 'undefined' && Model.activeLayerId) || 'Layer0'; }

  function _hideExisting() {
    if (typeof Model === 'undefined' || !Array.isArray(Model.objects)) return;
    // Walk every time — newly added objects (or ones that crept back in)
    // get hidden too. Each obj is tracked once via _hiddenExisting.
    const seen = new Set(_hiddenExisting.map(e => e.obj));
    for (const o of Model.objects) {
      if (!o || o._isOnboardingDemo || seen.has(o) || !o.group) continue;
      const parent = o.group.parent;
      _hiddenExisting.push({ obj: o, parent, prev: o.group.visible });
      o.group.visible = false;
      if (parent) parent.remove(o.group);
    }
  }

  function _restoreExisting() {
    for (const e of _hiddenExisting) {
      try {
        if (e.obj && e.obj.group) {
          e.obj.group.visible = e.prev;
          if (e.parent && !e.obj.group.parent) e.parent.add(e.obj.group);
        }
      } catch (_) {}
    }
    _hiddenExisting = [];
  }

  /* Project a world-space Vector3 to screen pixel coords. */
  function _worldToScreen(v) {
    const cam = (typeof camera !== 'undefined') ? camera : window.camera;
    const rnd = (typeof renderer !== 'undefined') ? renderer : window.renderer;
    if (!cam || !rnd) return [0, 0];
    const p = v.clone().project(cam);
    const r = rnd.domElement.getBoundingClientRect();
    return [r.left + (p.x * 0.5 + 0.5) * r.width, r.top + (1 - (p.y * 0.5 + 0.5)) * r.height];
  }

  /* Convert screen-space coordinates to world coordinates on the ground
     plane (y=0) using the active camera. Returns a THREE.Vector3. */
  function _screenToGround(sx, sy) {
    const cam = (typeof camera !== 'undefined') ? camera : window.camera;
    const rnd = (typeof renderer !== 'undefined') ? renderer : window.renderer;
    try {
      if (cam && rnd && rnd.domElement) {
        const r = rnd.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((sx - r.left) / r.width) * 2 - 1,
          -((sy - r.top) / r.height) * 2 + 1
        );
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, cam);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const out = new THREE.Vector3();
        if (ray.ray.intersectPlane(plane, out)) return out;
      }
    } catch (e) { console.warn('[onboarding] screenToGround failed', e); }
    // Fallback: rough manual mapping from viewport offsets to world units.
    const vp = document.getElementById('viewport');
    if (vp) {
      const r = vp.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const scale = 0.02; // px → world units
      return new THREE.Vector3((sx - cx) * scale, 0, (sy - cy) * scale);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  function _clearDemo() {
    if (_extrudeTimer) { clearTimeout(_extrudeTimer); _extrudeTimer = null; }
    try {
      if (_demoSectionPlane && Array.isArray(Model.sectionPlanes)) {
        const i = Model.sectionPlanes.indexOf(_demoSectionPlane);
        if (i >= 0) {
          if (_demoSectionPlane.visual && _demoSectionPlane.visual.parent) {
            _demoSectionPlane.visual.parent.remove(_demoSectionPlane.visual);
          }
          Model.sectionPlanes.splice(i, 1);
        }
        _demoSectionPlane = null;
      }
      if (Array.isArray(Model.objects)) {
        const demos = Model.objects.filter(o => o && o._isOnboardingDemo);
        for (const o of demos) {
          if (o.group && o.group.parent) o.group.parent.remove(o.group);
          const i = Model.objects.indexOf(o); if (i >= 0) Model.objects.splice(i, 1);
        }
      }
      // Also clean up raw demo wrappers (e.g. the Three.js Line for the
      // Line tool demo) that live in _demoObjs but not Model.objects.
      for (const w of _demoObjs) {
        if (w && w.group && w.group.parent) {
          try { w.group.parent.remove(w.group); } catch (_) {}
        }
      }
      _demoObjs = [];
      if (Array.isArray(Model.objects)) {
        _demoCubeObj = null;
        _demoFlatObj = null;
        _demoWallApplied = false;
        if (typeof renderOutliner === 'function') renderOutliner();
      }
      // Remove any demo Scenes
      if (_demoSceneIds.length && Array.isArray(Model.scenes)) {
        for (const id of _demoSceneIds) {
          try {
            if (typeof deleteScene === 'function') deleteScene(id);
            else {
              const i = Model.scenes.findIndex(s => s.id === id);
              if (i >= 0) Model.scenes.splice(i, 1);
            }
          } catch (_) {}
        }
        _demoSceneIds = [];
        if (typeof renderSceneTabs === 'function') renderSceneTabs();
      }
      if (_origLayerHatch !== null) {
        const L = (Model.layers || []).find(x => x.id === _activeLayerId());
        if (L) L.cutHatch = _origLayerHatch;
        _origLayerHatch = null;
      }
      if (_origLayerHatchMap && Array.isArray(Model.layers)) {
        for (const L of Model.layers) {
          if (_origLayerHatchMap.has(L.id)) L.cutHatch = _origLayerHatchMap.get(L.id);
        }
        _origLayerHatchMap = null;
      }
      if (typeof updateClippingPlanes === 'function') updateClippingPlanes();
      if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
      if (typeof sectionFillRoot !== 'undefined' && sectionFillRoot) {
        sectionFillRoot.visible = true;
      }
    } catch (_) {}
  }

  /* ==================== Demo builders =============================== */
  function _makeBox(cx, cy, cz, sx, sy, sz, color, name) {
    const em = new EditableMesh();
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const V = [
      new THREE.Vector3(cx - hx, cy - hy, cz - hz),
      new THREE.Vector3(cx + hx, cy - hy, cz - hz),
      new THREE.Vector3(cx + hx, cy - hy, cz + hz),
      new THREE.Vector3(cx - hx, cy - hy, cz + hz),
      new THREE.Vector3(cx - hx, cy + hy, cz - hz),
      new THREE.Vector3(cx + hx, cy + hy, cz - hz),
      new THREE.Vector3(cx + hx, cy + hy, cz + hz),
      new THREE.Vector3(cx - hx, cy + hy, cz + hz),
    ];
    const idx = V.map(v => em.addVertex(v));
    const lay = _activeLayerId();
    // Winding: each face vertex order produces an OUTWARD-pointing normal so
    // WallLayer.apply() extrudes layers outside the box.
    em.addFace([idx[0], idx[1], idx[2], idx[3]], color, lay); // bottom -Y
    em.addFace([idx[4], idx[7], idx[6], idx[5]], color, lay); // top    +Y
    em.addFace([idx[0], idx[4], idx[5], idx[1]], color, lay); // back   -Z
    em.addFace([idx[1], idx[5], idx[6], idx[2]], color, lay); // right  +X
    em.addFace([idx[2], idx[6], idx[7], idx[3]], color, lay); // front  +Z
    em.addFace([idx[3], idx[7], idx[4], idx[0]], color, lay); // left   -X
    const so = new SketchObject(em, name || 'Demo');
    so.layerId = lay;
    return so;
  }

  function _ensureDemoLine(pA, pB) {
    if (!pA || !pB) return;
    // No snapping here — the caller (_toolStep for line) snaps p2's screen
    // position so the cursor, anchor dots and final line all align.
    // Render as a proper Three.js line (not a thin ribbon).
    const y = 0.03;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(pA.x, y, pA.z),
      new THREE.Vector3(pB.x, y, pB.z),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0x1a1208, linewidth: 2 });
    const line = new THREE.Line(geo, mat);
    line.userData._isOnboardingDemo = true;
    const root = (typeof worldRoot !== 'undefined' && worldRoot) ? worldRoot : scene;
    root.add(line);
    // Track in _demoObjs via a lightweight wrapper so cleanup removes it.
    _demoObjs.push({
      _isOnboardingDemo: true,
      name: 'Demo Line',
      group: line,
    });
  }
  function _ensureDemoRect(pA, pB) {
    if (!pA || !pB) return;
    const em = new EditableMesh();
    const y = 0.01;
    const x0 = Math.min(pA.x, pB.x), x1 = Math.max(pA.x, pB.x);
    const z0 = Math.min(pA.z, pB.z), z1 = Math.max(pA.z, pB.z);
    const i0 = em.addVertex(new THREE.Vector3(x0, y, z0));
    const i1 = em.addVertex(new THREE.Vector3(x1, y, z0));
    const i2 = em.addVertex(new THREE.Vector3(x1, y, z1));
    const i3 = em.addVertex(new THREE.Vector3(x0, y, z1));
    em.addFace([i0, i1, i2, i3], '#c8e0ff', _activeLayerId());
    const so = new SketchObject(em, 'Demo Rect');
    so.layerId = _activeLayerId();
    so._isOnboardingDemo = true;
    addObject(so); so.rebuild && so.rebuild();
    _demoObjs.push(so);
  }
  function _ensureDemoCircle(pC, pE) {
    if (!pC || !pE) return;
    const r = Math.hypot(pE.x - pC.x, pE.z - pC.z) || 1;
    const em = new EditableMesh();
    const y = 0.01, n = 32;
    const idxs = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      idxs.push(em.addVertex(new THREE.Vector3(pC.x + Math.cos(t) * r, y, pC.z + Math.sin(t) * r)));
    }
    em.addFace(idxs, '#ffd6a8', _activeLayerId());
    const so = new SketchObject(em, 'Demo Circle');
    so.layerId = _activeLayerId();
    so._isOnboardingDemo = true;
    addObject(so); so.rebuild && so.rebuild();
    _demoObjs.push(so);
  }

  function _ensureDemoCube() {
    if (_demoCubeObj) return;
    const so = _makeBox(0, 1, 0, 2.4, 2, 2, '#d7c9a8', 'Demo Cube');
    so._isOnboardingDemo = true;
    addObject(so); so.rebuild && so.rebuild();
    _demoObjs.push(so); _demoCubeObj = so;
  }

  function _ensureDemoFlatRect(pA, pB) {
    if (_demoFlatObj) return;
    const wA = pA || new THREE.Vector3(-1, 0.01, -1);
    const wB = pB || new THREE.Vector3( 1, 0.01,  1);
    const em = new EditableMesh();
    const y = 0.01;
    const x0 = Math.min(wA.x, wB.x), x1 = Math.max(wA.x, wB.x);
    const z0 = Math.min(wA.z, wB.z), z1 = Math.max(wA.z, wB.z);
    const i0 = em.addVertex(new THREE.Vector3(x0, y, z0));
    const i1 = em.addVertex(new THREE.Vector3(x1, y, z0));
    const i2 = em.addVertex(new THREE.Vector3(x1, y, z1));
    const i3 = em.addVertex(new THREE.Vector3(x0, y, z1));
    em.addFace([i0, i1, i2, i3], '#a8d4ff', _activeLayerId());
    const so = new SketchObject(em, 'Demo Face');
    so.layerId = _activeLayerId();
    so._pushPullExtent = { x0, x1, z0, z1 };
    so._isOnboardingDemo = true;
    addObject(so); so.rebuild && so.rebuild();
    _demoObjs.push(so); _demoFlatObj = so;
  }

  function _animateDemoExtrude() {
    if (!_demoFlatObj) return;
    const ext = _demoFlatObj._pushPullExtent || { x0: -1, x1: 1, z0: -1, z1: 1 };
    try {
      const obj = _demoFlatObj;
      if (obj.group && obj.group.parent) obj.group.parent.remove(obj.group);
      const i = Model.objects.indexOf(obj); if (i >= 0) Model.objects.splice(i, 1);
      const ti = _demoObjs.indexOf(obj); if (ti >= 0) _demoObjs.splice(ti, 1);
      _demoFlatObj = null;
    } catch (_) {}
    const cx = (ext.x0 + ext.x1) / 2, cz = (ext.z0 + ext.z1) / 2;
    const sx = ext.x1 - ext.x0, sz = ext.z1 - ext.z0;
    let h = 0.05;
    const target = Math.max(sx, sz) * 0.4;   // shorter extrude so it stays visible
    let cur = null;
    const tick = () => {
      if (cur) {
        try { if (cur.group && cur.group.parent) cur.group.parent.remove(cur.group); } catch (_) {}
        const i = Model.objects.indexOf(cur); if (i >= 0) Model.objects.splice(i, 1);
        const ti = _demoObjs.indexOf(cur); if (ti >= 0) _demoObjs.splice(ti, 1);
      }
      cur = _makeBox(cx, h / 2 + 0.01, cz, sx, h, sz, '#a8d4ff', 'Extrude');
      cur._pushPullExtent = ext;
      cur._isOnboardingDemo = true;
      addObject(cur); cur.rebuild && cur.rebuild();
      _demoObjs.push(cur);
      _demoFlatObj = cur;
      h += target / 16;
      if (h <= target) _extrudeTimer = setTimeout(tick, 70);
    };
    tick();
  }

  function _ensureDemoWalls() {
    const w = 0.2, ht = 1.2, len = 3;
    const a = _makeBox(0, ht / 2, -len / 2, len, ht, w, '#e8d7b5', 'Wall A');
    const b = _makeBox(len / 2 - w / 2, ht / 2, 0, w, ht, len, '#e8d7b5', 'Wall B');
    addObject(a); a.rebuild && a.rebuild(); _track(a);
    addObject(b); b.rebuild && b.rebuild(); _track(b);
  }
  /* Build a wall box between world points pA and pB. */
  function _ensureDemoWallBetween(pA, pB) {
    console.log('[onboarding] wallBetween', pA, pB);
    if (!pA || !pB) { console.warn('[onboarding] wall missing points'); return; }
    const w = 0.2, ht = 1.2;
    const cx = (pA.x + pB.x) / 2;
    const cz = (pA.z + pB.z) / 2;
    const dx = pB.x - pA.x, dz = pB.z - pA.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) return;
    // Build an axis-aligned box then rotate to align with the wall direction
    const em = new EditableMesh();
    const hx = len / 2, hy = ht / 2, hz = w / 2;
    const V = [
      new THREE.Vector3(-hx, 0,  -hz), new THREE.Vector3(+hx, 0,  -hz),
      new THREE.Vector3(+hx, 0,  +hz), new THREE.Vector3(-hx, 0,  +hz),
      new THREE.Vector3(-hx, ht, -hz), new THREE.Vector3(+hx, ht, -hz),
      new THREE.Vector3(+hx, ht, +hz), new THREE.Vector3(-hx, ht, +hz),
    ];
    const ang = Math.atan2(dz, dx);
    const rot = new THREE.Matrix4().makeRotationY(-ang);
    const trn = new THREE.Matrix4().makeTranslation(cx, 0, cz);
    const M = new THREE.Matrix4().multiplyMatrices(trn, rot);
    const idx = V.map(v => em.addVertex(v.applyMatrix4(M)));
    const lay = _activeLayerId();
    const c = '#e8d7b5';
    em.addFace([idx[0], idx[1], idx[2], idx[3]], c, lay);
    em.addFace([idx[4], idx[7], idx[6], idx[5]], c, lay);
    em.addFace([idx[0], idx[4], idx[5], idx[1]], c, lay);
    em.addFace([idx[1], idx[5], idx[6], idx[2]], c, lay);
    em.addFace([idx[2], idx[6], idx[7], idx[3]], c, lay);
    em.addFace([idx[3], idx[7], idx[4], idx[0]], c, lay);
    const so = new SketchObject(em, 'Demo Wall');
    so.layerId = lay;
    so._isOnboardingDemo = true;
    addObject(so); so.rebuild && so.rebuild();
    _demoObjs.push(so);
  }

  function _ensureDemoSection() {
    if (_demoSectionPlane || typeof addSectionPlane !== 'function') return;
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    addSectionPlane(plane, { name: '' });
    _demoSectionPlane = Model.sectionPlanes[Model.sectionPlanes.length - 1];
    // Keep the section plane visual (outline + arrows) visible. Just hide
    // the cut FILL (which carries the unwanted diagonal hatch) until we
    // explicitly apply a hatch later.
    try {
      if (typeof sectionFillRoot !== 'undefined' && sectionFillRoot) {
        sectionFillRoot.visible = false;
      }
      // Also hide just the text label sprite so "Demo" doesn't appear
      if (_demoSectionPlane && _demoSectionPlane.visual && _demoSectionPlane.visual.userData) {
        const lbl = _demoSectionPlane.visual.userData.labelSprite;
        if (lbl) lbl.visible = false;
      }
    } catch (_) {}
    if (typeof updateClippingPlanes === 'function') updateClippingPlanes();
  }

  function _applyDemoHatch(hatchId) {
    const layerId = _activeLayerId();
    const L = (Model.layers || []).find(x => x.id === layerId);
    if (L) {
      if (_origLayerHatch === null) _origLayerHatch = L.cutHatch ?? null;
      L.cutHatch = hatchId || 'brick';
    }
    if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
    if (typeof renderLayers === 'function') renderLayers();
    // Now reveal the section fill (was hidden to suppress initial hatch)
    if (typeof sectionFillRoot !== 'undefined' && sectionFillRoot) {
      sectionFillRoot.visible = true;
    }
  }

  /* Apply wall layers to the +X SIDE face of the demo cube. The side face
     spans z=-1..+1, so the section (kept z<=0) intersects them and we can
     see different materials stacked next to the cube in the cut. */
  function _applyDemoWallLayersOnSide() {
    try {
      if (!_demoCubeObj || typeof WallLayer === 'undefined') return;
      if (_demoWallApplied) return;
      _demoWallApplied = true;
      const fi = 3; // +X side face
      const refObj    = _demoCubeObj;
      const refNormal = WallLayer._faceWorldNormal(refObj, fi).clone();
      const refVerts  = WallLayer._faceWorldVerts(refObj, fi);
      // Add layers one at a time with a small delay so users see the
      // assembly grow outward.
      let cum = 0;
      const layers = WallLayer.layers;
      let idx = 0;
      const step = () => {
        if (idx >= layers.length) {
          if (typeof updateClippingPlanes === 'function') updateClippingPlanes();
          if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
          return;
        }
        const L = layers[idx];
        const slab = WallLayer._makeSlab(refVerts, refNormal, L.thickness, L, cum);
        slab._isOnboardingDemo = true;
        addObject(slab);
        // Mirror what WallLayer.apply() does after addObject:
        const layerId = (typeof getOrAddLayer === 'function')
          ? getOrAddLayer(L.name, { color: L.color, cutHatch: L.hatch || null })
          : null;
        if (layerId) slab.layerId = layerId;
        if (slab._pendingLayerDef) delete slab._pendingLayerDef;
        _demoObjs.push(slab);
        cum += L.thickness;
        idx++;
        if (typeof rebuildSectionFills === 'function') rebuildSectionFills();
        setTimeout(step, 450);
      };
      step();
    } catch (e) { console.warn('[onboarding] wall layer apply failed', e); }
  }

  /* ==================== Panel expand / collapse ===================== */
  function collapseAllPanelSections(except) {
    const rp = document.getElementById('rightpanel');
    if (!rp) return;
    const exceptEl = except ? (function () { try { return document.querySelector(except); } catch (_) { return null; } })() : null;
    const exceptSec = exceptEl ? (exceptEl.closest ? exceptEl.closest('.panel-section') : null) : null;
    rp.querySelectorAll('.panel-section').forEach(sec => {
      if (sec === exceptSec) return;
      const body = sec.querySelector('.panel-body');
      if (!body) return;
      if (body.style.display !== 'none' && getComputedStyle(body).display !== 'none') {
        const header = sec.querySelector('.panel-header');
        if (header) try { header.click(); } catch (_) {}
      }
    });
  }

  function expandPanelFor(sel) {
    if (!sel) return;
    let el;
    try { el = document.querySelector(sel); } catch (_) { return; }
    if (!el) return;
    const rp = document.getElementById('rightpanel');
    if (rp && rp.classList.contains('is-collapsed')) {
      const btn = document.getElementById('rightPanelCollapse');
      if (btn) try { btn.click(); } catch (_) {}
      else rp.classList.remove('is-collapsed');
    }
    let sec = el.closest && el.closest('.panel-section');
    if (!sec) sec = el;
    const body = sec.querySelector ? sec.querySelector('.panel-body') : null;
    if (body && (body.style.display === 'none' || getComputedStyle(body).display === 'none')) {
      const header = sec.querySelector('.panel-header');
      if (header) try { header.click(); } catch (_) {}
      else body.style.display = '';
    }
  }

  /* ==================== Overlay UI =================================== */
  let _idx = 0;
  let _overlay = null, _tip = null, _ring = null, _arrow = null;
  let _onResize = null;

  function ensureUI() {
    if (_overlay) return;
    _overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    _overlay.setAttribute('id', '_obSpotlight');
    Object.assign(_overlay.style, {
      position: 'fixed', inset: '0', zIndex: '999997',
      pointerEvents: 'auto', width: '100%', height: '100%',
    });
    _overlay.innerHTML = `
      <defs>
        <mask id="_obMask">
          <rect width="100%" height="100%" fill="white"/>
          <rect id="_obHole" x="0" y="0" width="0" height="0" rx="12" ry="12" fill="black"/>
        </mask>
      </defs>
      <rect id="_obDim" width="100%" height="100%" fill="rgba(0,0,0,0.18)" mask="url(#_obMask)"/>
    `;
    _ring = document.createElement('div');
    Object.assign(_ring.style, {
      position: 'fixed',
      border: '3px solid #ffffff',
      borderRadius: '12px',
      pointerEvents: 'none',
      transition: 'all 0.32s cubic-bezier(.4,1.4,.6,1)',
      zIndex: '999999',
      boxShadow:
        '0 0 0 2px rgba(110,200,255,0.55), '+
        '0 0 24px 4px rgba(110,200,255,0.7), '+
        '0 0 60px 10px rgba(110,200,255,0.35)',
      animation: 'tutorPulse 1.6s ease-in-out infinite',
    });
    if (!document.getElementById('_tutorKF')) {
      const st = document.createElement('style');
      st.id = '_tutorKF';
      st.textContent = `
        @keyframes tutorPulse {
          0%,100% { box-shadow: 0 0 0 2px rgba(110,200,255,0.55), 0 0 24px 4px rgba(110,200,255,0.7), 0 0 60px 10px rgba(110,200,255,0.35); }
          50%     { box-shadow: 0 0 0 4px rgba(110,200,255,0.85), 0 0 36px 8px rgba(110,200,255,0.95), 0 0 80px 14px rgba(110,200,255,0.55); }
        }
        @keyframes tutorPop {
          from { transform: scale(0.85) translateY(8px); opacity: 0; }
          to   { transform: scale(1) translateY(0);     opacity: 1; }
        }
        @keyframes tutorBob {
          0%,100% { transform: translateY(0) rotate(-4deg); }
          50%     { transform: translateY(-4px) rotate(4deg); }
        }
        ._obBubble {
          position: fixed;
          width: 400px; max-width: 400px;
          color: #1a1208;
          padding: 56px 80px 56px;
          font: 300 14px/1.6 "Inter", "Helvetica Neue", -apple-system, "SF Pro Display", "Apple SD Gothic Neo", sans-serif;
          font-weight: 350;
          z-index: 1000000; pointer-events: auto;
          letter-spacing: -0.005em;
          transition: left 0.3s ease, top 0.3s ease;
          text-align: center;
          filter: drop-shadow(0 18px 36px rgba(0,0,0,0.22));
        }
        ._obBubbleBg {
          position: absolute; inset: 0;
          width: 100%; height: 100%;
          z-index: -1; pointer-events: none;
          overflow: visible;
        }
        ._obBubble > *:not(._obBubbleBg):not(._obMascot) {
          position: relative;
        }
        ._obBubble b { font-weight: 600; }
        ._obTail {
          position: fixed; z-index: 1000001;
          pointer-events: none;
          transition: all 0.3s ease;
        }
        ._obMascot {
          position: absolute; top: -14px; right: 22px;
          font-size: 78px; pointer-events: none;
          filter: drop-shadow(0 6px 12px rgba(0,0,0,0.3));
          animation: tutorBob 2.2s ease-in-out infinite;
          transform-origin: 50% 80%;
          z-index: 2;
        }
        ._obCursor {
          position: fixed; width: 22px; height: 30px;
          z-index: 1000002; pointer-events: none;
          transition: left 0.5s cubic-bezier(.4,.4,.6,1), top 0.5s cubic-bezier(.4,.4,.6,1);
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
        }
        ._obCursor svg { width: 100%; height: 100%; }
        ._obKey {
          position: fixed; z-index: 1000002; pointer-events: none;
          padding: 6px 12px; background: #1a1208; color: #fff;
          font: 700 14px/1 "Inter", -apple-system, sans-serif;
          border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          opacity: 0; transition: opacity 0.2s ease;
        }
        ._obKey.show { opacity: 1; }
        ._obClick {
          position: fixed; z-index: 1000001; pointer-events: none;
          width: 24px; height: 24px; border-radius: 50%;
          background: rgba(110,200,255,0.6); border: 2px solid #fff;
          transform: translate(-50%, -50%) scale(0.5);
          opacity: 0;
        }
        ._obClick.fire { animation: tutorClick 0.5s ease-out; }
        @keyframes tutorClick {
          0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
          30%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(2.2); }
        }
      `;
      document.head.appendChild(st);
    }
    _tip = document.createElement('div'); _tip.className = '_obBubble';
    _arrow = document.createElement('div'); _arrow.className = '_obTail';
    document.body.appendChild(_overlay);
    document.body.appendChild(_ring);
    document.body.appendChild(_arrow);
    document.body.appendChild(_tip);
    _onResize = () => render();
    window.addEventListener('resize', _onResize);
    document.addEventListener('keydown', _onKey, true);
  }

  function _onKey(e) {
    if (!_tip) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  function teardown() {
    [_overlay, _ring, _tip, _arrow].forEach(el => { if (el && el.parentNode) el.parentNode.removeChild(el); });
    _overlay = _ring = _tip = _arrow = null;
    _idx = 0;
    if (_onResize) { window.removeEventListener('resize', _onResize); _onResize = null; }
    document.removeEventListener('keydown', _onKey, true);
    _clearAllTimers();
    // Drop any leftover .active class on toolbar tool buttons we lit up
    try {
      ['line','rect','circle'].forEach(t => {
        const b = document.querySelector(`[data-tool="${t}"]`);
        if (b) b.classList.remove('active');
      });
    } catch (_) {}
    _clearDemo();
    // Final sweep: remove any object / scene added since the tour started,
    // even if its _isOnboardingDemo flag was lost along the way.
    try {
      if (_tourStartObjects && typeof Model !== 'undefined' && Array.isArray(Model.objects)) {
        const toRemove = Model.objects.filter(o => o && !_tourStartObjects.has(o));
        for (const o of toRemove) {
          try { if (o.group && o.group.parent) o.group.parent.remove(o.group); } catch (_) {}
          const i = Model.objects.indexOf(o); if (i >= 0) Model.objects.splice(i, 1);
          // Drop from hidden-existing list so _restoreExisting doesn't bring it back
          const hi = _hiddenExisting.findIndex(e => e.obj === o);
          if (hi >= 0) _hiddenExisting.splice(hi, 1);
        }
        _tourStartObjects = null;
        if (typeof renderOutliner === 'function') renderOutliner();
      }
      if (_tourStartScenes && typeof Model !== 'undefined' && Array.isArray(Model.scenes)) {
        const toRemove = Model.scenes.filter(s => s && !_tourStartScenes.has(s.id));
        for (const s of toRemove) {
          try {
            if (typeof deleteScene === 'function') deleteScene(s.id);
            else {
              const i = Model.scenes.indexOf(s); if (i >= 0) Model.scenes.splice(i, 1);
            }
          } catch (_) {}
        }
        _tourStartScenes = null;
        if (typeof renderSceneTabs === 'function') renderSceneTabs();
      }
    } catch (_) {}
    _restoreExisting();
    _hideCursor();
  }

  function findTarget(sel) {
    if (!sel) return null;
    for (const s of sel.split(',').map(x => x.trim())) {
      try {
        const el = document.querySelector(s);
        if (!el) continue;
        if (el.offsetWidth > 4 && el.offsetHeight > 4) return el;
        const sec = el.closest && el.closest('.panel-section');
        if (sec && sec.offsetWidth > 4 && sec.offsetHeight > 4) return sec;
      } catch (_) {}
    }
    return null;
  }

  function placeRing(target) {
    const hole = document.getElementById('_obHole');
    if (!target) {
      _ring.style.display = 'none';
      if (hole) { hole.setAttribute('width', '0'); hole.setAttribute('height', '0'); }
      return null;
    }
    _ring.style.display = 'block';
    const r = target.getBoundingClientRect();
    const pad = 8;
    const x = r.left - pad, y = r.top - pad;
    const w = r.width + pad * 2, h = r.height + pad * 2;
    Object.assign(_ring.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    if (hole) { hole.setAttribute('x', x); hole.setAttribute('y', y); hole.setAttribute('width', w); hole.setAttribute('height', h); }
    return r;
  }

  function _drawTail(side, x, y, tw, th, rect) {
    if (!_arrow) return;
    if (!side || !rect) { _arrow.style.display = 'none'; return; }
    _arrow.style.display = 'block';
    const tx = rect.left + rect.width / 2;
    const ty = rect.top + rect.height / 2;
    let bx, by;
    if (side === 'left')       { bx = x; by = y + th / 2; }
    else if (side === 'right') { bx = x + tw; by = y + th / 2; }
    else if (side === 'top')   { bx = x + tw / 2; by = y; }
    else                        { bx = x + tw / 2; by = y + th; }
    const ang = Math.atan2(ty - by, tx - bx);
    const len = 26;
    const halfW = 14;
    const tipX = bx + Math.cos(ang) * len;
    const tipY = by + Math.sin(ang) * len;
    const px = -Math.sin(ang) * halfW;
    const py =  Math.cos(ang) * halfW;
    const p1x = bx + px, p1y = by + py;
    const p2x = bx - px, p2y = by - py;
    const minX = Math.min(tipX, p1x, p2x) - 4;
    const minY = Math.min(tipY, p1y, p2y) - 4;
    const w = Math.max(tipX, p1x, p2x) - minX + 4;
    const h = Math.max(tipY, p1y, p2y) - minY + 4;
    _arrow.style.left = minX + 'px';
    _arrow.style.top  = minY + 'px';
    _arrow.style.width = w + 'px'; _arrow.style.height = h + 'px';
    const lx = (p1x - minX), ly = (p1y - minY);
    const rx = (p2x - minX), ry = (p2y - minY);
    const ex = (tipX - minX), ey = (tipY - minY);
    _arrow.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polygon points="${lx},${ly} ${rx},${ry} ${ex},${ey}"
        fill="rgba(255,252,247,0.72)" stroke="#1a1208" stroke-width="2.5" stroke-linejoin="round"
        style="filter:drop-shadow(0 1px 0 rgba(0,0,0,0.15));"/>
    </svg>`;
  }

  function placeTip(rect, pos) {
    _tip.style.visibility = 'hidden';
    _tip.style.left = '0px'; _tip.style.top = '0px';
    const tb = _tip.getBoundingClientRect();
    const tw = tb.width || 340, th = tb.height || 200;
    const margin = 30;
    let x, y, arrowSide = null;
    if (!rect || pos === 'center') {
      x = (window.innerWidth - tw) / 2; y = (window.innerHeight - th) / 2;
    } else if (pos === 'top-left') {
      // For viewport steps: place bubble in TOP-LEFT corner so the central
      // demo geometry (cube / shapes) stays visible.
      x = rect.left + 24; y = rect.top + 24; arrowSide = null;
    } else if (pos === 'top-right') {
      x = rect.right - tw - 24; y = rect.top + 24; arrowSide = 'bottom';
    } else if (pos === 'bottom-right') {
      x = rect.right - tw - 24; y = rect.bottom - th - 24; arrowSide = 'top';
    } else if (pos === 'right') {
      x = rect.right + margin; y = rect.top + rect.height / 2 - th / 2; arrowSide = 'left';
    } else if (pos === 'left') {
      x = rect.left - tw - margin; y = rect.top + rect.height / 2 - th / 2; arrowSide = 'right';
    } else if (pos === 'bottom') {
      x = rect.left + rect.width / 2 - tw / 2; y = rect.bottom + margin; arrowSide = 'top';
    } else {
      x = rect.left + rect.width / 2 - tw / 2; y = rect.top - th - margin; arrowSide = 'bottom';
    }
    x = Math.max(60, Math.min(window.innerWidth - tw - 20, x));
    y = Math.max(60, Math.min(window.innerHeight - th - 20, y));
    _tip.style.left = x + 'px'; _tip.style.top = y + 'px';
    _tip.style.visibility = 'visible';
    // Tail integrated into the bubble outline — short, natural comic-style.
    let tail = null;
    if (rect && arrowSide) {
      const tx = rect.left + rect.width / 2 - x;
      const ty = rect.top + rect.height / 2 - y;
      const cxL = tw / 2, cyL = th / 2;
      const dx = tx - cxL, dy = ty - cyL;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // Anchor on the bubble edge (ellipse), then poke ~28px past it
      const rxE = tw / 2 - 6, ryE = th / 2 - 6;
      const tEdge = 1 / Math.sqrt((ux / rxE) ** 2 + (uy / ryE) ** 2);
      const edgeX = cxL + ux * tEdge, edgeY = cyL + uy * tEdge;
      const tipX = edgeX + ux * 18;
      const tipY = edgeY + uy * 18;
      const angle = Math.atan2(uy, ux);
      tail = { angle, tipX, tipY };
    }
    _renderBubbleBg(tw, th, tail);
    if (_arrow) _arrow.style.display = 'none';
  }

  /* Build an organic speech bubble path with the tail integrated into the
     same outline — like a hand-drawn comic bubble. `tail` is { angle, tipX,
     tipY } in local coords; if null, no tail is added. The bubble is a near-
     perfect ellipse with very subtle, smooth wobble so it looks soft rather
     than mathematical. */
  function _bubblePath(w, h, tail) {
    const cx = w / 2, cy = h / 2;
    const rx = w / 2 - 6, ry = h / 2 - 6;
    const N = 64;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      // Two low-frequency smooth modulations → soft asymmetric bulge,
      // no high-frequency noise.
      const wob = 1 + Math.sin(t * 2 + 0.7) * 0.012 + Math.cos(t + 1.4) * 0.008;
      pts.push([cx + Math.cos(t) * rx * wob, cy + Math.sin(t) * ry * wob, /*sharp:*/ false]);
    }
    if (tail) {
      // Identify the perimeter point closest to the tail's anchor angle and
      // splice a triangular spike there. We replace two perimeter points
      // with three: left base, tail tip (sharp), right base. The bases sit
      // tangent to the ellipse so the spike grows out smoothly.
      const ang = tail.angle;
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        const d = Math.abs(((t - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      // Base offset along perimeter (smaller = narrower tail base)
      const baseSpread = 1;
      const iLeft  = (bestI - baseSpread + N) % N;
      const iRight = (bestI + baseSpread) % N;
      // Mark the spike base points as sharp too — this gives a clean kink
      // where the bubble outline transitions into the tail (no inward curl).
      const leftP  = [pts[iLeft][0],  pts[iLeft][1],  'base'];
      const rightP = [pts[iRight][0], pts[iRight][1], 'base'];
      const tip    = [tail.tipX, tail.tipY, 'tip'];
      // Remove the perimeter points strictly between iLeft and iRight
      const keep = [];
      for (let i = 0; i < N; i++) {
        // Walk indices from iLeft → iRight going forward
        let inSpan = false;
        let k = iLeft;
        while (true) {
          if (k === iRight) break;
          if (k === i) { inSpan = true; break; }
          k = (k + 1) % N;
        }
        if (!inSpan) keep.push(pts[i]);
      }
      // Rebuild pts in order starting from iRight to wrap around, so the
      // tail span is between leftP and rightP at the end. Easier: rebuild
      // from scratch by walking original indices and inserting [leftP, tip,
      // rightP] in place of the removed span.
      const out = [];
      let i = 0;
      while (i < N) {
        if (i === iLeft) {
          out.push(leftP);
          out.push(tip);
          out.push(rightP);
          // Skip indices iLeft+1 .. iRight
          let k = (iLeft + 1) % N;
          while (k !== (iRight + 1) % N) {
            i++;
            k = (k + 1) % N;
            if (i >= N + baseSpread * 2) break;
          }
          i++;
          continue;
        }
        out.push(pts[i]);
        i++;
      }
      pts.length = 0; pts.push(...out);
    }
    // Smooth using Catmull-Rom, but make any point flagged `sharp` a corner.
    const M = pts.length;
    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 0; i < M; i++) {
      let p0 = pts[(i - 1 + M) % M];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % M];
      let p3 = pts[(i + 2) % M];
      // When a neighbor is the sharp tail tip, mirror the OTHER endpoint so
      // the smoothed curve doesn't get pulled outward toward the tip (which
      // caused the tail base to bulge inward into the bubble).
      if (p3[2] === 'tip') p3 = [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], false];
      if (p0[2] === 'tip') p0 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], false];
      // Straight segments only at the spike (between tip and its bases) —
      // base→tip and tip→base. The segment APPROACHING a base curves
      // smoothly so the bubble outline blends naturally into the tail.
      const tipSeg = (p1[2] === 'tip' || p2[2] === 'tip');
      if (tipSeg) {
        d += ` L ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
      } else {
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
      }
    }
    d += ' Z';
    return d;
  }

  function _renderBubbleBg(tw, th, tail) {
    if (!_tip) return;
    let bg = _tip.querySelector('._obBubbleBg');
    if (!bg) {
      bg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      bg.setAttribute('class', '_obBubbleBg');
      _tip.insertBefore(bg, _tip.firstChild);
    }
    // Allow the tail to extend outside the bubble box
    const pad = 60;
    bg.setAttribute('viewBox', `${-pad} ${-pad} ${tw + pad * 2} ${th + pad * 2}`);
    bg.style.left = -pad + 'px';
    bg.style.top  = -pad + 'px';
    bg.style.width  = (tw + pad * 2) + 'px';
    bg.style.height = (th + pad * 2) + 'px';
    const d = _bubblePath(tw, th, tail);
    // Hand-drawn feel: SVG turbulence displaces the path slightly so the line
    // wavers like a pen stroke instead of a perfect vector curve. Two stacked
    // strokes (thicker dark + thinner offset) give the bold inky weight.
    const fid = '_obRough' + (Math.random().toString(36).slice(2, 7));
    // Plain path — no turbulence displacement, since the displacement was
    // pulling the tail base inward and creating an unnatural look.
    bg.innerHTML = `
      <path d="${d}"
        fill="rgba(255,252,247,0.78)"
        stroke="#1a1208" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"
        style="paint-order: fill stroke;"/>
    `;
  }

  function render() {
    const step = STEPS[_idx];
    if (!step) return finish();
    _clearAllTimers();
    _hideCursor();
    // After the welcome step, hide all pre-existing objects so demos
    // aren't cluttered by leftover entourage / saved geometry.
    if (_idx > 0) _hideExisting();
    if (step.expand) {
      collapseAllPanelSections(step.expand);
      expandPanelFor(step.expand);
    }
    setTimeout(() => {
      const target = findTarget(step.sel);
      const rect = placeRing(target);
      _tip.innerHTML = `
        <div class="_obMascot">🐢</div>
        <div style="font-weight:700;font-size:17px;margin-bottom:10px;letter-spacing:-0.015em;color:#1a1208;">${step.title}</div>
        <div style="margin-bottom:16px;color:#2a1f15;white-space:pre-line;">${step.body}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="color:#9a8470;font-size:11px;font-weight:600;letter-spacing:0.04em;">${_idx + 1} / ${STEPS.length}</div>
          <div style="display:flex;gap:6px;">
            <button id="_obSkip" title="Skip tour" style="width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:#ffffff;color:#3c3c43;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 1px 3px rgba(0,0,0,0.12);">✕</button>
            ${_idx > 0 ? '<button id="_obPrev" title="Back" style="width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:#ffffff;color:#3c3c43;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 1px 3px rgba(0,0,0,0.12);">←</button>' : ''}
            <button id="_obNext" title="${_idx === STEPS.length - 1 ? 'Finish' : 'Next'}" style="width:34px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:#007aff;color:#fff;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;box-shadow:0 2px 6px rgba(0,122,255,0.40);">→</button>
          </div>
        </div>
      `;
      placeTip(rect, step.pos);
      _tip.querySelector('#_obSkip').onclick = finish;
      const pv = _tip.querySelector('#_obPrev'); if (pv) pv.onclick = prev;
      _tip.querySelector('#_obNext').onclick = next;
      _tip.style.animation = 'none'; void _tip.offsetWidth;
      _tip.style.animation = 'tutorPop 0.35s cubic-bezier(.4,1.7,.5,1)';
      if (typeof step.demo === 'function') {
        try { console.log('[onboarding] step', _idx, 'demo:', step.title); step.demo(); }
        catch (e) { console.error('[onboarding] demo error', e); }
      }
    }, step.expand ? 380 : 0);
  }

  function next() { _idx++; if (_idx >= STEPS.length) finish(); else render(); }
  function prev() { if (_idx > 0) { _idx--; render(); } }
  function finish() { teardown(); try { localStorage.setItem('turtle_onboarded', '1'); } catch (_) {} }

  /* Force-clean any leftovers from a previous (interrupted) tour session.
     Removes Model.objects flagged _isOnboardingDemo AND scans the scene
     graph for any orphan groups that match (in case Model.objects was
     mutated separately). Safe to call multiple times. */
  window._cleanupOnboardingLeftovers = function () {
    let removed = 0;
    // Demo object name patterns produced by this tour (also matches saved
    // state where the _isOnboardingDemo flag was lost in serialization).
    const DEMO_NAME_RE = /^(Demo |Push\/Pull|Tour |Wall A$|Wall B$|Demo H\d)/;
    try {
      if (typeof Model !== 'undefined' && Array.isArray(Model.objects)) {
        const leftovers = Model.objects.filter(o => o && (
          o._isOnboardingDemo || (o.name && DEMO_NAME_RE.test(o.name))
        ));
        for (const o of leftovers) {
          try { if (o.group && o.group.parent) o.group.parent.remove(o.group); } catch (_) {}
          const i = Model.objects.indexOf(o); if (i >= 0) Model.objects.splice(i, 1);
          removed++;
        }
        if (typeof renderOutliner === 'function') renderOutliner();
      }
      if (typeof Model !== 'undefined' && Array.isArray(Model.scenes)) {
        const leftovers = Model.scenes.filter(s => s && (s._isOnboardingDemo || (s.name && /^Tour /.test(s.name))));
        for (const s of leftovers) {
          try {
            if (typeof deleteScene === 'function') deleteScene(s.id);
            else { const i = Model.scenes.indexOf(s); if (i >= 0) Model.scenes.splice(i, 1); }
          } catch (_) {}
          removed++;
        }
        if (typeof renderSceneTabs === 'function') renderSceneTabs();
      }
      // Reset section fill visibility just in case
      if (typeof sectionFillRoot !== 'undefined' && sectionFillRoot) {
        sectionFillRoot.visible = true;
      }
      // Scan the scene for orphan groups (groups not backed by any
      // Model.objects entry) — these are ghost demo objects that got
      // re-added to the scene but lost their Model entry. Remove them.
      try {
        if (typeof scene !== 'undefined' && scene && Array.isArray(Model.objects)) {
          const liveGroups = new Set(Model.objects.map(o => o && o.group).filter(Boolean));
          // worldRoot is where SketchObject groups live; fall back to scene
          const root = (typeof worldRoot !== 'undefined' && worldRoot) ? worldRoot : scene;
          const orphans = [];
          root.traverse((node) => {
            if (node === root) return;
            // A group that has a 'userData.isSketchObjectGroup' marker, OR
            // a Mesh child but isn't in liveGroups → likely orphan.
            if (node.isGroup && !liveGroups.has(node)) {
              // Heuristic: it carries a Mesh (the entourage plane)
              const hasMesh = node.children.some(c => c.isMesh);
              if (hasMesh && node.parent === root) orphans.push(node);
            }
          });
          for (const g of orphans) {
            try { g.parent.remove(g); removed++; } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (e) { console.warn('[onboarding cleanup]', e); }
    console.log('[onboarding] cleaned up', removed, 'leftover items');
    return removed;
  };

  // Auto-run at script load and periodically for first few seconds (the
  // app may load saved state asynchronously).
  window.addEventListener('DOMContentLoaded', () => {
    [800, 2000, 4000].forEach(d => setTimeout(() => {
      try { window._cleanupOnboardingLeftovers(); } catch (_) {}
    }, d));
  });

  window._startOnboardingTour = function () {
    _idx = 0;
    // Snapshot the set of model objects + scenes at tour start so that on
    // teardown we can remove ANY new ones — covers cases where the
    // _isOnboardingDemo flag got lost (e.g. via snapshot round-trips).
    try {
      _tourStartObjects = new Set((typeof Model !== 'undefined' && Model.objects) ? Model.objects : []);
      _tourStartScenes  = new Set((typeof Model !== 'undefined' && Model.scenes)  ? Model.scenes.map(s => s.id) : []);
    } catch (_) {}
    ensureUI();
    render();
  };

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      try {
        if (localStorage.getItem('turtle_onboarded') !== '1') {
          window._startOnboardingTour();
        }
      } catch (_) {}
    }, 1200);
  });
})();
