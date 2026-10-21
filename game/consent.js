/* Cat Conga — cookie consent + Google Analytics 4 (G-ETW2D67D8F), Consent Mode BASIC (2026-10-21,
 * WEB-TECH-BASELINE §T6). Nothing is requested from Google until the player clicks Accept/Akceptuję:
 * gtag.js is loaded only then and `config` sends a GRANTED page_view of this page. A stored "granted"
 * loads it right away on the next visit (one page_view, no manual duplicate). The id is committed here on
 * purpose (public, not a secret); deploy/check-ga.mjs refuses a deploy without it.
 * window.ccGA(event, params): a real no-op without consent; low-cardinality params only, never playerId/room.
 * The banner is a small top card (z 50: above the loader and the error overlay, so it stays answerable) —
 * it never covers the joystick (#joy, bottom-left) or the buttons (#btns,
 * bottom-right) and never blocks entering the world. Withdraw: "Cookie settings" (always visible) -> Reject.
 * Same controller as the light show; legal text: https://lightshow.flyreelstudio.eu/privacy#game */
(function () {
  'use strict';
  var GA_ID = 'G-ETW2D67D8F';
  var KEY = 'cc_consent';                         // 'granted' | 'denied' (first-party localStorage, not a cookie)
  var PL = /^pl\b/i.test(navigator.language || '');
  var L = PL ? {
    text: 'Za Twoją zgodą gra używa Google Analytics 4 (Google Ireland Ltd.), aby zbiorczo liczyć uruchomienia gry, wczytywanie świata i błędy — bez reklam. Do kliknięcia „Akceptuję” nic nie jest ładowane ani wysyłane do Google; potem zapisywane są pliki cookie _ga i _ga_ETW2D67D8F (do 14 miesięcy). Zgodę wycofasz w każdej chwili przez „Ustawienia cookie”.',
    more: 'Prywatność', href: 'https://lightshow.flyreelstudio.eu/privacy?lang=pl#gra',
    accept: 'Akceptuję', reject: 'Odrzucam', settings: 'Ustawienia cookie',
  } : {
    text: 'With your consent this game uses Google Analytics 4 (Google Ireland Ltd.) to count, in aggregate, game starts, world loading and errors — no advertising. Nothing is loaded or sent to Google until you click Accept; it then sets the cookies _ga and _ga_ETW2D67D8F (kept up to 14 months). Withdraw anytime via “Cookie settings”.',
    more: 'Privacy', href: 'https://lightshow.flyreelstudio.eu/privacy?lang=en#game',
    accept: 'Accept', reject: 'Reject', settings: 'Cookie settings',
  };
  var loaded = false, once = {};
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function load() {
    if (loaded) return;
    loaded = true;
    window['ga-disable-' + GA_ID] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('set', { allow_google_signals: false, allow_ad_personalization_signals: false });
    gtag('config', GA_ID, { cookie_domain: location.hostname, site_lang: PL ? 'pl' : 'en' });   // the GRANTED page_view
    var s = document.createElement('script'); s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    (document.head || document.documentElement).appendChild(s);
  }
  function event(name, params) {
    if (!loaded || stored() !== 'granted') return;
    var p = {}; for (var k in (params || {})) p[k] = params[k];
    if (!p.site_lang) p.site_lang = PL ? 'pl' : 'en';
    try { gtag('event', name, p); } catch (e) {}
  }
  window.ccGA = event;

  function clearGaCookies() {
    var names = { '_ga': 1 }; names['_ga_' + GA_ID.slice(2)] = 1;
    document.cookie.split(';').forEach(function (c) { var n = c.split('=')[0].trim(); if (/^_ga/.test(n)) names[n] = 1; });
    var parts = location.hostname.split('.'), domains = [''];
    for (var i = 0; i < parts.length - 1; i++) { var d = parts.slice(i).join('.'); domains.push(d, '.' + d); }
    Object.keys(names).forEach(function (n) {
      domains.forEach(function (d) { document.cookie = n + '=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : ''); });
    });
  }
  function grant() {
    var was = stored();
    store('granted');
    if (!loaded) { load(); return; }
    if (was === 'granted' && !window['ga-disable-' + GA_ID]) return;
    window['ga-disable-' + GA_ID] = false;                     // re-consent after a withdraw in the same tab
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('config', GA_ID, { cookie_domain: location.hostname, site_lang: PL ? 'pl' : 'en' });
  }
  function deny() {                                            // first Reject = nothing ever loaded; after Accept = withdraw
    store('denied');
    if (loaded && window.gtag) { try { gtag('consent', 'update', { analytics_storage: 'denied' }); } catch (e) {} }
    window['ga-disable-' + GA_ID] = true;
    clearGaCookies();
  }

  var css = '#ccBanner{position:fixed;left:50%;transform:translateX(-50%);top:calc(74px + env(safe-area-inset-top));z-index:50;'
    + 'width:min(560px,calc(100vw - 24px));box-sizing:border-box;background:rgba(10,12,18,.96);color:#e8e6df;border:1px solid rgba(255,255,255,.16);'
    + 'border-radius:14px;padding:12px 14px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.5);'
    + '-webkit-user-select:text;user-select:text}'
    + '#ccBanner p{margin:0 0 10px}#ccBanner a{color:#ffc93c}'
    + '#ccBanner .cc-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}'
    /* Accept and Reject: EQUAL visual weight — same fill, border, weight, size (T6) */
    + '#ccBanner button{font:inherit;font-weight:700;cursor:pointer;min-width:118px;padding:9px 18px;border-radius:10px;'
    + 'background:#262b3a;color:#fff;border:1px solid #9aa3b8;width:auto;height:auto}'
    + '#ccBanner button:focus-visible,#ccSettings:focus-visible{outline:2px solid #ffc93c;outline-offset:2px}'
    + '#ccSettings{position:fixed;z-index:45;top:calc(8px + env(safe-area-inset-top));left:calc(8px + env(safe-area-inset-left));'
    + 'background:rgba(10,12,18,.55);color:#cfd3de;border:1px solid rgba(255,255,255,.1);border-radius:999px;'
    + 'padding:4px 10px;font:11px/1.3 system-ui,-apple-system,sans-serif;cursor:pointer;width:auto;height:auto}';
  function removeBanner() { var b = document.getElementById('ccBanner'); if (b) b.remove(); }
  function settingsLink() {
    if (document.getElementById('ccSettings')) return;
    var a = document.createElement('button'); a.type = 'button'; a.id = 'ccSettings'; a.textContent = L.settings;
    a.addEventListener('click', function () { banner(true); });
    document.body.appendChild(a);
  }
  function banner(force) {
    settingsLink();
    var st = stored();
    if (!force && (st === 'granted' || st === 'denied')) return;
    if (document.getElementById('ccBanner')) return;
    var bar = document.createElement('div'); bar.id = 'ccBanner'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Cookies');
    var p = document.createElement('p'); p.textContent = L.text + ' ';
    var a = document.createElement('a'); a.href = L.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = L.more; p.appendChild(a);
    var row = document.createElement('div'); row.className = 'cc-row';
    var acc = document.createElement('button'); acc.type = 'button'; acc.id = 'ccAccept'; acc.textContent = L.accept;
    var rej = document.createElement('button'); rej.type = 'button'; rej.id = 'ccReject'; rej.textContent = L.reject;
    acc.onclick = function () { grant(); removeBanner(); };
    rej.onclick = function () { deny(); removeBanner(); };
    row.appendChild(acc); row.appendChild(rej); bar.appendChild(p); bar.appendChild(row);
    document.body.appendChild(bar);
  }

  // exceptions of the game's own scripts (not extensions), once per message per load
  function own(f) { return !f || f.indexOf(location.origin) === 0; }
  window.addEventListener('error', function (e) {
    if (!e || !own(e.filename)) return;
    var d = String(e.message || 'error') + (e.filename ? ' @' + e.filename.replace(location.origin, '') + ':' + (e.lineno || 0) : '');
    if (once[d]) return; once[d] = 1;
    event('exception', { description: d.slice(0, 100), fatal: false });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason; var d = 'unhandledrejection: ' + String((r && (r.message || r.name)) || r || '');
    if (once[d]) return; once[d] = 1;
    event('exception', { description: d.slice(0, 100), fatal: false });
  });

  window.ccConsent = { accept: function () { grant(); removeBanner(); }, reject: function () { deny(); removeBanner(); }, withdraw: deny, status: stored, open: function () { banner(true); } };
  if (stored() === 'granted') load();
  function ready() { var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); banner(false); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
