/* ============================================================================
   ad/i18n.js — Korean / English language switch for the web menu bar.
   ----------------------------------------------------------------------------
   The in-HTML #menubar is authored in English. This module captures each
   item's English label once, then swaps just the leading text node (leaving
   the shortcut <span> untouched) when the language changes. Translations come
   from the shared i18n-menu.json (also used by the desktop native menu in
   main.js). The choice persists in localStorage.

   Desktop (Electron) hides #menubar and uses the native macOS menu, which does
   its own translation in main.js — so this module no-ops there.
   ============================================================================ */
(function () {
  if (window.electronSaveTT) return;            // desktop → native menu handles i18n
  const AD = window.AD || (window.AD = {});
  const LS_KEY = 'td_menu_lang';
  let KO = {};
  const orig = new Map();                        // element → English label (trimmed)
  let _lang = 'en';

  const leadText = (el) => { const n = el && el.firstChild; return (n && n.nodeType === 3) ? n : null; };

  function capture() {
    document.querySelectorAll('#menubar .menu-item, #menubar [data-act], #menubar .submenu').forEach((el) => {
      if (el.matches('[data-act^="lang-"]')) return;   // language picker — handled below
      const t = leadText(el);
      if (!t) return;
      const key = t.nodeValue.trim();
      if (key) orig.set(el, key);
    });
  }

  function setLead(el, text) {
    const t = leadText(el);
    if (!t) return;
    const trailing = /\s$/.test(t.nodeValue) ? ' ' : '';   // keep the gap before a shortcut <span>
    t.nodeValue = text + trailing;
  }

  function apply(lang) {
    if (!orig.size && document.getElementById('menubar')) capture();   // cover clicks before the fetch settles
    _lang = (lang === 'ko') ? 'ko' : 'en';
    orig.forEach((key, el) => setLead(el, _lang === 'ko' ? (KO[key] || key) : key));
    // Language picker rows: show each language in its own script and tick the active one.
    const mark = (act, name) => {
      const el = document.querySelector('#menubar [data-act="' + act + '"]');
      const t = leadText(el);
      if (t) t.nodeValue = (act === 'lang-' + _lang ? '✓ ' : '  ') + name;
    };
    mark('lang-en', 'English');
    mark('lang-ko', '한국어');
    try { document.documentElement.setAttribute('data-menu-lang', _lang); } catch (_) {}
  }

  function get() {
    try { const v = localStorage.getItem(LS_KEY); if (v === 'ko' || v === 'en') return v; } catch (_) {}
    try { if ((navigator.language || '').toLowerCase().indexOf('ko') === 0) return 'ko'; } catch (_) {}
    return 'en';
  }

  function set(lang) {
    lang = (lang === 'ko') ? 'ko' : 'en';
    try { localStorage.setItem(LS_KEY, lang); } catch (_) {}
    apply(lang);
  }

  AD.I18n = { apply, set, get, lang: () => _lang, t: (k) => (_lang === 'ko' ? (KO[k] || k) : k) };

  function init() {
    if (!document.getElementById('menubar')) return;
    if (!orig.size) capture();
    apply(get());
  }

  // Capture + apply as soon as the DOM is ready, INDEPENDENT of the network —
  // so an early language click isn't a dead no-op. The fetch then loads the
  // Korean strings and re-applies once they arrive.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  fetch('i18n-menu.json')
    .then((r) => r.json())
    .then((j) => { KO = (j && j.ko) || {}; })
    .catch(() => { KO = {}; })
    .finally(() => { init(); });
})();
