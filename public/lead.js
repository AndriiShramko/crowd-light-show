// Shared lead-form handler for the @@CONTACT@@ block (round 8C). Used on every public page.
// Validates (name + email required), POSTs to /api/apply, then shows a thank-you state that
// does NOT echo back the submitted details, and offers to share the live demo with friends.
(function () {
  'use strict';
  var form = document.getElementById('leadForm');
  if (!form) return;
  var msg = document.getElementById('lc-msg');
  var btn = document.getElementById('lc-send');
  var thanks = document.getElementById('lc-thanks');
  function t(k, en) { try { return (window.CLSI18N && window.CLSI18N.t(k)) || en; } catch (e) { return en; } }

  // attribution: which page + tier the lead came from (no PII)
  var qs = new URLSearchParams(location.search);
  var page = (location.pathname || '/').replace(/\/+$/, '') || '/';
  var src = page + (qs.get('demo') ? '?demo=1' : '');
  var srcEl = document.getElementById('lc-source'); if (srcEl) srcEl.value = src;
  var tier = qs.get('tier') || '';

  // share link = the open demo (a synced light show you can share — NOT a host-controlled room)
  var shareUrl = location.origin + '/try';
  var tryEl = document.getElementById('lc-share-try'); if (tryEl) tryEl.setAttribute('href', '/try');
  var copyBtn = document.getElementById('lc-share-copy');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var done = function () { copyBtn.textContent = t('share.copied', 'Link copied ✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(shareUrl).then(done, done);
    else { try { var i = document.createElement('input'); i.value = shareUrl; document.body.appendChild(i); i.select(); document.execCommand('copy'); document.body.removeChild(i); done(); } catch (e) {} }
  });

  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.className = 'lc-msg'; msg.textContent = '';
    var name = form.name.value.trim();
    var email = form.email.value.trim();
    if (!name || !email) { msg.className = 'lc-msg err'; msg.textContent = t('form.err_required', 'Please add your name and email so we can reach you.'); return; }
    if (!emailOk(email)) { msg.className = 'lc-msg err'; msg.textContent = t('form.err_email', 'That email doesn’t look right — please check it.'); form.email.focus(); return; }

    btn.disabled = true; var original = btn.textContent; btn.textContent = t('form.sending', 'Sending…');
    fetch('/api/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name, email: email, contact: email,
        phone: form.phone.value.trim(), company: form.company.value.trim(),
        eventType: form.eventType.value, message: form.message.value.trim(),
        source: (srcEl && srcEl.value) || src, tier: tier, website: form.website.value
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('bad status');
      // NO echo of the submitted PII — swap the form out for a thank-you + share offer.
      form.style.display = 'none';
      if (thanks) thanks.className = 'lc-thanks show';
      else { msg.className = 'lc-msg'; msg.textContent = t('form.thanks_body', 'Thank you — we’ll be in touch.'); }
    }).catch(function () {
      msg.className = 'lc-msg err'; msg.textContent = t('form.err_send', 'Something went wrong sending that. Please try again, or email zmei116@gmail.com.');
      btn.disabled = false; btn.textContent = original;
    });
  });
})();
