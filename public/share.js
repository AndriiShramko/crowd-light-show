// ROUND 9 share block. Builds the JOIN link/code + share intents for the CURRENT room from
// page context (never bakes an ephemeral room into cached HTML). Two payloads: (A) a JOIN url
// for this room, (B) a STATIC "start your own" site url. Honesty: "a synced light show", never
// "perfectly synced" — friends on different networks are not proven frame-aligned.
(function () {
  'use strict';
  var block = document.getElementById('shareBlock');
  if (!block) return;
  var $ = function (id) { return document.getElementById(id); };
  var origin = location.origin;
  var siteUrl = origin + '/?utm=share';
  var enc = encodeURIComponent;

  function context() {
    var S = window.__SESSION__;
    var params = new URLSearchParams(location.search);
    if (S && S.mode === 'public' && S.room) return { joinUrl: origin + '/join?room=' + S.room, code: S.room };
    if (S && S.mode === 'personal') { var el = $('joinurl'); return { joinUrl: (el && el.getAttribute('href')) || (origin + '/join'), code: '' }; }
    var room = params.get('room'), s = params.get('s');
    if (room) return { joinUrl: origin + '/join?room=' + room, code: room };
    if (s) return { joinUrl: origin + '/join?s=' + s, code: s };
    return { joinUrl: origin + '/join', code: '' };
  }

  function refresh() {
    var c = context();
    var join = c.joinUrl;
    var text = 'Join my live light show — our phones light up together to the music: ' + join + '  ·  Want your own? It is free: ' + siteUrl;
    var subject = 'Join my live light show';
    if (c.code) { $('shCode').hidden = false; $('shCodeVal').textContent = c.code; }
    // WhatsApp / Telegram / X carry the JOIN url + invite text; Facebook ignores text so it
    // points at the SITE url (rich OG unfurl); email + copy carry the JOIN url.
    $('shWa').href = 'https://wa.me/?text=' + enc(text);
    $('shTg').href = 'https://t.me/share/url?url=' + enc(join) + '&text=' + enc('Join my live light show — phones light up together 🎆');
    $('shX').href = 'https://twitter.com/intent/tweet?text=' + enc('Join my live light show — phones light up together 🎆') + '&url=' + enc(join);
    $('shFb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + enc(siteUrl);
    $('shMail').href = 'mailto:?subject=' + enc(subject) + '&body=' + enc(text);
    $('shOwn').href = siteUrl;

    var copyBtn = $('shCopy');
    copyBtn.onclick = function () {
      var done = function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(join).then(done, fallback);
      else fallback();
      function fallback() { var t = document.createElement('textarea'); t.value = join; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(t); done(); }
    };
    if (navigator.share) {
      var nb = $('shNative'); nb.hidden = false;
      nb.onclick = function () { navigator.share({ title: subject, text: 'Join my live light show — phones light up together', url: join }).catch(function () {}); };
    }
    block.hidden = false;
  }

  // GA (round 10): which share channel was used. clsGA is a no-op until cookie consent.
  var CH = { shWa: 'whatsapp', shTg: 'telegram', shX: 'x', shFb: 'facebook', shMail: 'email', shCopy: 'copy', shNative: 'native', shOwn: 'own_site' };
  block.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[id]'); if (!t) return;
    var ch = CH[t.id]; if (ch && window.clsGA) window.clsGA('share_clicked', { channel: ch });
  });

  refresh();
  // personal console fills #joinurl asynchronously — refresh once it lands.
  setTimeout(refresh, 2000);
})();
