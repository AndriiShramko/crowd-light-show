// Site-wide i18n for the marketing pages (round 8C). NOTE: public/i18n.js is a SEPARATE,
// audience-consent-only dictionary used by the in-show flash page — this is the layer the
// marketing pages (/, /try, /studio, /about, /privacy) + the shared contact block consume.
//
// EN is canonical: the HTML ships English inline, so the page is meaningful with JS off /
// before this runs. Elements carry data-i18n="key" (textContent) or data-i18n-ph="key"
// (placeholder); a missing key falls back to EN, then to the inline text. A floating
// switcher (EN/PL/ES/FR) is injected; choice is detected from ?lang= -> localStorage ->
// navigator.language -> 'en', persisted, and reflected in <html lang> + the URL.
//
// SAFETY/LEGAL: ES + FR legal/consent strings are machine-drafted and marked
// "pending native review"; PL + EN are authoritative. The in-show epilepsy consent gate
// lives in i18n.js (PL default) and is NOT weakened here.
(function () {
  'use strict';
  var LANGS = ['en', 'pl', 'es', 'fr'];
  var NAMES = { en: 'EN', pl: 'PL', es: 'ES', fr: 'FR' };

  // ---- dictionaries (en canonical; pl authoritative; es/fr drafted, legal pending review) ----
  var T = {
    en: {
      'nav.try': 'Try the demo', 'nav.how': 'How it works', 'nav.pricing': 'Pricing', 'nav.about': 'About & safety', 'nav.source': 'Source', 'nav.contact': 'Get in touch',
      'price.kicker': 'Done-for-you', 'price.title': 'Want the show run for you?',
      'price.lead': 'The app is free and open-source — run it yourself any time. These tiers are a managed service: we plan, set up, operate and tune your light show on the night. Final scope is confirmed on a quick call.',
      'price.spark': 'Spark', 'price.spark.cap': 'up to 100 phones', 'price.spark.desc': 'Parties, weddings, small venues — one operator, on good Wi-Fi.',
      'price.surge': 'Surge', 'price.surge.cap': 'up to 1,000 phones', 'price.surge.desc': 'Clubs, mid-size concerts, conferences — soundcheck + on-site operation.',
      'price.stadium': 'Stadium', 'price.stadium.cap': 'up to 10,000 phones', 'price.stadium.desc': 'Large events — subject to infrastructure provisioning for the crowd size.',
      'price.beyond': 'Beyond', 'price.beyond.cap': 'Need more?', 'price.beyond.desc': "Bigger or bespoke? Let's talk it through and scope it to your event.",
      'price.from': 'from', 'price.talk': "Let's talk",
      'price.note': 'Prices are starting points and depend on venue, audience size and network conditions — confirmed on a consult call. No payment here; every tier starts with a conversation.',
      'price.cta': 'Discuss my event',
      'contact.title': 'Interested? Let’s talk about your event',
      'contact.sub': 'Tell us a little about your event and we’ll get you set up — or get you a quote for managed work.',
      'form.name': 'Name', 'form.email': 'Email', 'form.phone': 'Phone', 'form.company': 'Company / organization',
      'form.event': 'Event type', 'form.message': 'About your event', 'form.msg_ph': 'Date, venue, crowd size — anything that helps.',
      'form.optional': 'optional', 'form.send': 'Send request', 'form.sending': 'Sending…',
      'form.err_required': 'Please add your name and email so we can reach you.', 'form.err_email': 'That email doesn’t look right — please check it.',
      'form.err_send': 'Something went wrong sending that. Please try again, or email zmei116@gmail.com.',
      'form.thanks_title': 'Thank you! 🎉', 'form.thanks_body': 'Got it — we’ll get back to you within one business day. Talk soon!',
      'share.title': 'While you’re here — show your friends', 'share.body': 'Open the live demo together: it’s a synced light show you can share. Send this link and watch your phones light up as one.',
      'share.cta_try': 'Open the demo', 'share.cta_copy': 'Copy share link', 'share.copied': 'Link copied ✓',
      'contact.or': 'Or reach Andrii Shramko directly:', 'contact.or_sub': 'Happy to talk through your event, integrations or custom work.',
      'contact.linkedin': 'LinkedIn', 'contact.email': 'Email', 'contact.book': 'Book a call', 'contact.book_sub': 'Pick a time that suits you', 'contact.phone': 'Phone',
      'contact.privacy': 'We use your details only to reply about your event. See our',
      'contact.privacy_link': 'privacy notice',
      'ev.party': 'Party', 'ev.concert': 'Concert / Festival', 'ev.club': 'Club / DJ', 'ev.wedding': 'Wedding', 'ev.corp': 'Corporate / Conference', 'ev.sport': 'Sports / Arena', 'ev.church': 'Church / Worship', 'ev.other': 'Other',
      'foot.free': 'Made by Andrii Shramko. Free & open-source (Apache-2.0).', 'foot.custom': 'Need custom work or integration?', 'foot.getintouch': 'Get in touch.',
      'foot.privacy': 'Privacy', 'foot.imprint': 'Imprint',
    },
    pl: {
      'nav.try': 'Wypróbuj demo', 'nav.how': 'Jak to działa', 'nav.pricing': 'Cennik', 'nav.about': 'O projekcie i bezpieczeństwie', 'nav.source': 'Kod źródłowy', 'nav.contact': 'Kontakt',
      'price.kicker': 'Zrobione za Ciebie', 'price.title': 'Chcesz, żebyśmy poprowadzili pokaz za Ciebie?',
      'price.lead': 'Aplikacja jest darmowa i open-source — możesz uruchomić ją samodzielnie. Te pakiety to usługa zarządzana: planujemy, konfigurujemy, prowadzimy i stroimy Twój pokaz świateł na żywo. Ostateczny zakres ustalamy na krótkiej rozmowie.',
      'price.spark': 'Spark', 'price.spark.cap': 'do 100 telefonów', 'price.spark.desc': 'Imprezy, wesela, małe sale — jeden operator, dobre Wi-Fi.',
      'price.surge': 'Surge', 'price.surge.cap': 'do 1 000 telefonów', 'price.surge.desc': 'Kluby, średnie koncerty, konferencje — soundcheck + obsługa na miejscu.',
      'price.stadium': 'Stadium', 'price.stadium.cap': 'do 10 000 telefonów', 'price.stadium.desc': 'Duże wydarzenia — zależnie od przygotowania infrastruktury pod liczbę widzów.',
      'price.beyond': 'Beyond', 'price.beyond.cap': 'Potrzebujesz więcej?', 'price.beyond.desc': 'Większe lub nietypowe? Porozmawiajmy i dopasujmy zakres do Twojego wydarzenia.',
      'price.from': 'od', 'price.talk': 'Porozmawiajmy',
      'price.note': 'Ceny są wartościami początkowymi i zależą od miejsca, liczby widzów i warunków sieci — potwierdzamy je na rozmowie. Tu nie ma płatności; każdy pakiet zaczyna się od rozmowy.',
      'price.cta': 'Omówmy moje wydarzenie',
      'contact.title': 'Zainteresowany? Porozmawiajmy o Twoim wydarzeniu',
      'contact.sub': 'Napisz kilka słów o swoim wydarzeniu, a my wszystko przygotujemy — albo przygotujemy wycenę usługi.',
      'form.name': 'Imię', 'form.email': 'E-mail', 'form.phone': 'Telefon', 'form.company': 'Firma / organizacja',
      'form.event': 'Typ wydarzenia', 'form.message': 'O Twoim wydarzeniu', 'form.msg_ph': 'Data, miejsce, liczba osób — wszystko, co pomoże.',
      'form.optional': 'opcjonalnie', 'form.send': 'Wyślij zgłoszenie', 'form.sending': 'Wysyłanie…',
      'form.err_required': 'Podaj imię i e-mail, żebyśmy mogli się odezwać.', 'form.err_email': 'Ten e-mail wygląda na błędny — sprawdź go.',
      'form.err_send': 'Coś poszło nie tak przy wysyłaniu. Spróbuj ponownie lub napisz na zmei116@gmail.com.',
      'form.thanks_title': 'Dziękujemy! 🎉', 'form.thanks_body': 'Mamy zgłoszenie — odezwiemy się w ciągu jednego dnia roboczego. Do usłyszenia!',
      'share.title': 'Skoro już tu jesteś — pokaż znajomym', 'share.body': 'Otwórzcie demo na żywo razem: to zsynchronizowany pokaz świateł, którym możesz się podzielić. Wyślij ten link i patrz, jak Wasze telefony świecą jak jeden.',
      'share.cta_try': 'Otwórz demo', 'share.cta_copy': 'Kopiuj link', 'share.copied': 'Skopiowano ✓',
      'contact.or': 'Albo napisz bezpośrednio do Andrii Shramko:', 'contact.or_sub': 'Chętnie omówię Twoje wydarzenie, integracje lub pracę na zamówienie.',
      'contact.linkedin': 'LinkedIn', 'contact.email': 'E-mail', 'contact.book': 'Umów rozmowę', 'contact.book_sub': 'Wybierz dogodny termin', 'contact.phone': 'Telefon',
      'contact.privacy': 'Twoich danych używamy tylko po to, by odpowiedzieć w sprawie wydarzenia. Zobacz',
      'contact.privacy_link': 'informację o prywatności',
      'ev.party': 'Impreza', 'ev.concert': 'Koncert / Festiwal', 'ev.club': 'Klub / DJ', 'ev.wedding': 'Wesele', 'ev.corp': 'Firmowe / Konferencja', 'ev.sport': 'Sport / Arena', 'ev.church': 'Kościół / Nabożeństwo', 'ev.other': 'Inne',
      'foot.free': 'Stworzone przez Andrii Shramko. Darmowe i open-source (Apache-2.0).', 'foot.custom': 'Potrzebujesz pracy na zamówienie lub integracji?', 'foot.getintouch': 'Napisz.',
      'foot.privacy': 'Prywatność', 'foot.imprint': 'Dane firmy',
    },
    es: {
      'nav.try': 'Probar la demo', 'nav.how': 'Cómo funciona', 'nav.pricing': 'Precios', 'nav.about': 'Acerca de y seguridad', 'nav.source': 'Código fuente', 'nav.contact': 'Contacto',
      'price.kicker': 'Hecho por nosotros', 'price.title': '¿Quieres que llevemos el espectáculo por ti?',
      'price.lead': 'La aplicación es gratuita y de código abierto — puedes usarla tú mismo cuando quieras. Estos planes son un servicio gestionado: planificamos, montamos, operamos y ajustamos tu espectáculo de luces la misma noche. El alcance final se confirma en una llamada breve.',
      'price.spark': 'Spark', 'price.spark.cap': 'hasta 100 teléfonos', 'price.spark.desc': 'Fiestas, bodas, locales pequeños — un operador, con buen Wi-Fi.',
      'price.surge': 'Surge', 'price.surge.cap': 'hasta 1.000 teléfonos', 'price.surge.desc': 'Discotecas, conciertos medianos, congresos — prueba de sonido + operación in situ.',
      'price.stadium': 'Stadium', 'price.stadium.cap': 'hasta 10.000 teléfonos', 'price.stadium.desc': 'Grandes eventos — sujeto a la provisión de infraestructura para el tamaño del público.',
      'price.beyond': 'Beyond', 'price.beyond.cap': '¿Necesitas más?', 'price.beyond.desc': '¿Más grande o a medida? Hablémoslo y lo ajustamos a tu evento.',
      'price.from': 'desde', 'price.talk': 'Hablemos',
      'price.note': 'Los precios son orientativos y dependen del lugar, el tamaño del público y las condiciones de red — se confirman en una llamada. Aquí no se paga; cada plan empieza con una conversación.',
      'price.cta': 'Hablar de mi evento',
      'contact.title': '¿Te interesa? Hablemos de tu evento',
      'contact.sub': 'Cuéntanos un poco sobre tu evento y lo dejamos listo — o te preparamos un presupuesto del servicio.',
      'form.name': 'Nombre', 'form.email': 'Correo electrónico', 'form.phone': 'Teléfono', 'form.company': 'Empresa / organización',
      'form.event': 'Tipo de evento', 'form.message': 'Sobre tu evento', 'form.msg_ph': 'Fecha, lugar, número de personas — lo que ayude.',
      'form.optional': 'opcional', 'form.send': 'Enviar solicitud', 'form.sending': 'Enviando…',
      'form.err_required': 'Añade tu nombre y correo para que podamos responderte.', 'form.err_email': 'Ese correo no parece correcto — revísalo.',
      'form.err_send': 'Algo salió mal al enviar. Inténtalo de nuevo o escribe a zmei116@gmail.com.',
      'form.thanks_title': '¡Gracias! 🎉', 'form.thanks_body': 'Recibido — te responderemos en un día laborable. ¡Hablamos pronto!',
      'share.title': 'Ya que estás aquí — enséñaselo a tus amigos', 'share.body': 'Abrid juntos la demo en vivo: es un espectáculo de luces sincronizado que puedes compartir. Envía este enlace y mira cómo vuestros teléfonos se encienden como uno solo.',
      'share.cta_try': 'Abrir la demo', 'share.cta_copy': 'Copiar enlace', 'share.copied': 'Enlace copiado ✓',
      'contact.or': 'O contacta directamente con Andrii Shramko:', 'contact.or_sub': 'Encantado de hablar de tu evento, integraciones o trabajo a medida.',
      'contact.linkedin': 'LinkedIn', 'contact.email': 'Correo', 'contact.book': 'Reservar una llamada', 'contact.book_sub': 'Elige la hora que te venga bien', 'contact.phone': 'Teléfono',
      'contact.privacy': 'Usamos tus datos solo para responderte sobre tu evento. Consulta nuestra',
      'contact.privacy_link': 'política de privacidad',
      'ev.party': 'Fiesta', 'ev.concert': 'Concierto / Festival', 'ev.club': 'Discoteca / DJ', 'ev.wedding': 'Boda', 'ev.corp': 'Corporativo / Congreso', 'ev.sport': 'Deporte / Estadio', 'ev.church': 'Iglesia / Culto', 'ev.other': 'Otro',
      'foot.free': 'Hecho por Andrii Shramko. Gratis y de código abierto (Apache-2.0).', 'foot.custom': '¿Necesitas trabajo a medida o integración?', 'foot.getintouch': 'Contacta.',
      'foot.privacy': 'Privacidad', 'foot.imprint': 'Aviso legal',
    },
    fr: {
      'nav.try': 'Essayer la démo', 'nav.how': 'Comment ça marche', 'nav.pricing': 'Tarifs', 'nav.about': 'À propos et sécurité', 'nav.source': 'Code source', 'nav.contact': 'Contact',
      'price.kicker': 'Clé en main', 'price.title': 'Vous voulez qu’on gère le spectacle pour vous ?',
      'price.lead': 'L’application est gratuite et open-source — vous pouvez l’utiliser vous-même quand vous voulez. Ces formules sont un service géré : nous planifions, installons, pilotons et réglons votre spectacle de lumière le soir même. Le périmètre final est confirmé lors d’un court appel.',
      'price.spark': 'Spark', 'price.spark.cap': 'jusqu’à 100 téléphones', 'price.spark.desc': 'Fêtes, mariages, petites salles — un opérateur, sur un bon Wi-Fi.',
      'price.surge': 'Surge', 'price.surge.cap': 'jusqu’à 1 000 téléphones', 'price.surge.desc': 'Clubs, concerts moyens, conférences — balance + exploitation sur place.',
      'price.stadium': 'Stadium', 'price.stadium.cap': 'jusqu’à 10 000 téléphones', 'price.stadium.desc': 'Grands événements — sous réserve de la mise en place de l’infrastructure pour la taille du public.',
      'price.beyond': 'Beyond', 'price.beyond.cap': 'Besoin de plus ?', 'price.beyond.desc': 'Plus grand ou sur mesure ? Parlons-en et adaptons le périmètre à votre événement.',
      'price.from': 'à partir de', 'price.talk': 'Parlons-en',
      'price.note': 'Les prix sont des points de départ et dépendent du lieu, de la taille du public et des conditions réseau — confirmés lors d’un appel. Aucun paiement ici ; chaque formule commence par un échange.',
      'price.cta': 'Discuter de mon événement',
      'contact.title': 'Intéressé ? Parlons de votre événement',
      'contact.sub': 'Dites-nous quelques mots sur votre événement et on s’occupe de tout — ou on vous prépare un devis du service.',
      'form.name': 'Nom', 'form.email': 'E-mail', 'form.phone': 'Téléphone', 'form.company': 'Entreprise / organisation',
      'form.event': 'Type d’événement', 'form.message': 'À propos de votre événement', 'form.msg_ph': 'Date, lieu, nombre de personnes — tout ce qui aide.',
      'form.optional': 'facultatif', 'form.send': 'Envoyer la demande', 'form.sending': 'Envoi…',
      'form.err_required': 'Ajoutez votre nom et votre e-mail pour qu’on puisse vous répondre.', 'form.err_email': 'Cet e-mail semble incorrect — vérifiez-le.',
      'form.err_send': 'Un problème est survenu à l’envoi. Réessayez ou écrivez à zmei116@gmail.com.',
      'form.thanks_title': 'Merci ! 🎉', 'form.thanks_body': 'Bien reçu — nous reviendrons vers vous sous un jour ouvré. À bientôt !',
      'share.title': 'Tant que vous êtes là — montrez-le à vos amis', 'share.body': 'Ouvrez la démo en direct ensemble : c’est un spectacle de lumière synchronisé que vous pouvez partager. Envoyez ce lien et regardez vos téléphones s’allumer comme un seul.',
      'share.cta_try': 'Ouvrir la démo', 'share.cta_copy': 'Copier le lien', 'share.copied': 'Lien copié ✓',
      'contact.or': 'Ou contactez directement Andrii Shramko :', 'contact.or_sub': 'Ravi d’échanger sur votre événement, des intégrations ou du sur-mesure.',
      'contact.linkedin': 'LinkedIn', 'contact.email': 'E-mail', 'contact.book': 'Réserver un appel', 'contact.book_sub': 'Choisissez un créneau qui vous convient', 'contact.phone': 'Téléphone',
      'contact.privacy': 'Nous utilisons vos coordonnées uniquement pour vous répondre au sujet de votre événement. Voir notre',
      'contact.privacy_link': 'politique de confidentialité',
      'ev.party': 'Fête', 'ev.concert': 'Concert / Festival', 'ev.club': 'Club / DJ', 'ev.wedding': 'Mariage', 'ev.corp': 'Entreprise / Conférence', 'ev.sport': 'Sport / Arène', 'ev.church': 'Église / Culte', 'ev.other': 'Autre',
      'foot.free': 'Réalisé par Andrii Shramko. Gratuit et open-source (Apache-2.0).', 'foot.custom': 'Besoin de sur-mesure ou d’intégration ?', 'foot.getintouch': 'Contactez-nous.',
      'foot.privacy': 'Confidentialité', 'foot.imprint': 'Mentions légales',
    },
  };

  function pick() {
    var qs = new URLSearchParams(location.search).get('lang');
    if (qs && LANGS.indexOf(qs) >= 0) return qs;
    try { var ls = localStorage.getItem('cls_lang'); if (ls && LANGS.indexOf(ls) >= 0) return ls; } catch (e) {}
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return LANGS.indexOf(nav) >= 0 ? nav : 'en';
  }
  var lang = pick();
  function t(key) { return (T[lang] && T[lang][key]) || T.en[key] || ''; }

  function apply() {
    document.documentElement.setAttribute('lang', lang);
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) { var k = nodes[i].getAttribute('data-i18n'); var v = t(k); if (v) nodes[i].textContent = v; }
    var phs = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) { var k2 = phs[j].getAttribute('data-i18n-ph'); var v2 = t(k2); if (v2) phs[j].setAttribute('placeholder', v2); }
    var switcher = document.getElementById('cls-lang');
    if (switcher) { var bs = switcher.querySelectorAll('button'); for (var b = 0; b < bs.length; b++) bs[b].className = (bs[b].getAttribute('data-lang') === lang) ? 'on' : ''; }
  }
  function set(l) {
    if (LANGS.indexOf(l) < 0) return; lang = l;
    try { localStorage.setItem('cls_lang', l); } catch (e) {}
    try { var u = new URL(location.href); u.searchParams.set('lang', l); history.replaceState(null, '', u); } catch (e) {}
    apply();
  }

  function buildSwitcher() {
    if (document.getElementById('cls-lang')) return;
    var s = document.createElement('div'); s.id = 'cls-lang';
    s.setAttribute('role', 'group'); s.setAttribute('aria-label', 'Language');
    for (var i = 0; i < LANGS.length; i++) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = NAMES[LANGS[i]]; b.setAttribute('data-lang', LANGS[i]);
      b.addEventListener('click', (function (l) { return function () { set(l); }; })(LANGS[i]));
      s.appendChild(b);
    }
    var css = '#cls-lang{position:fixed;top:10px;right:10px;z-index:50;display:flex;gap:2px;background:rgba(10,12,20,.72);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:3px;backdrop-filter:blur(6px)}'
      + '#cls-lang button{all:unset;cursor:pointer;font:600 12px/1 system-ui,sans-serif;color:#cfd6e6;padding:6px 9px;border-radius:999px;letter-spacing:.04em}'
      + '#cls-lang button:hover{color:#fff}#cls-lang button.on{background:#5a7bff;color:#fff}'
      + '@media print{#cls-lang{display:none}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    document.body.appendChild(s);
  }

  function init() { try { localStorage.setItem('cls_lang', lang); } catch (e) {} buildSwitcher(); apply(); } // persist the detected lang so it survives navigation
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.CLSI18N = { t: t, set: set, get lang() { return lang; }, langs: LANGS };
})();
