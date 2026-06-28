// Minimal PL/EN dictionary for the audience client. PL is the default/primary
// (Polish photosensitivity warning is required for a public event in PL).
(function (global) {
  var DICT = {
    pl: {
      title: 'Światło z tłumu', sub: 'Twój telefon stanie się częścią wspólnego pokazu świateł zsynchronizowanego z muzyką.',
      epi_h: '⚠️ Ostrzeżenie: błyski światła',
      epi_b: 'Ten pokaz miga jasnym światłem. Nie dołączaj, jeśli masz padaczkę światłoczułą lub źle reagujesz na migające światło. Możesz wyjść w każdej chwili przyciskiem „Stop”.',
      how: 'Domyślnie świeci ekran telefonu (działa na każdym telefonie). Na Androidzie możesz dodatkowo włączyć prawdziwą latarkę — przeglądarka poprosi wtedy o dostęp do kamery. Nie nagrywamy ani nie wysyłamy żadnego obrazu — kamera służy wyłącznie do włączania diody.',
      batt: 'Pokaz zużywa baterię, telefon może się nagrzać, a ekran pozostaje włączony. Trzymaj telefon ekranem do sceny i nie blokuj go.',
      agree: 'Rozumiem ostrzeżenie o błyskach i zgadzam się dołączyć.',
      join: 'Dołącz — użyj ekranu', join_torch: 'Dołącz + latarka (Android, używa kamery)',
      made: 'Stworzone przez', live_h: 'Jesteś światłem ✨', live_b: 'Trzymaj telefon ekranem do sceny. Nie blokuj ekranu.',
      left_h: 'Wyszedłeś z pokazu', rejoin: 'Dołącz ponownie', stop: 'Stop',
      st_conn: 'łączenie…', st_sync: 'synchronizacja…', st_ready: 'gotowe • tryb ekranu', st_ready_t: 'gotowe • ekran + latarka', st_play: 'gra ▶', st_wait: 'czekam na start…', st_paused: 'pauza', st_resume: 'Dotknij, aby wrócić — nie blokuj ekranu',
    },
    en: {
      title: 'Crowd Light Show', sub: 'Your phone becomes part of one light show synchronized to the music.',
      epi_h: '⚠️ Warning: flashing lights',
      epi_b: 'This show flashes bright light. Do not join if you have photosensitive epilepsy or react badly to flashing light. You can leave any time with the “Stop” button.',
      how: 'By default your phone screen is the light (works on every phone). On Android you can also turn on the real flashlight — the browser will then ask for camera access. We never record or send any image — the camera is only used to switch the LED on and off.',
      batt: 'The show uses battery, your phone may get warm, and the screen stays on. Hold the phone screen toward the stage and don’t lock it.',
      agree: 'I understand the flashing warning and agree to join.',
      join: 'Join — use my screen', join_torch: 'Join + flashlight (Android, uses camera)',
      made: 'Made by', live_h: 'You are a light ✨', live_b: 'Hold the phone screen toward the stage. Don’t lock the screen.',
      left_h: 'You left the show', rejoin: 'Join again', stop: 'Stop',
      st_conn: 'connecting…', st_sync: 'syncing…', st_ready: 'ready • screen mode', st_ready_t: 'ready • screen + torch', st_play: 'playing ▶', st_wait: 'waiting for start…', st_paused: 'paused', st_resume: 'Tap to return — keep the screen on',
    },
  };
  var lang = 'pl';
  function t(k) { return (DICT[lang] && DICT[lang][k]) || (DICT.pl[k]) || k; }
  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-t]').forEach(function (el) {
      var k = el.getAttribute('data-t'); if (DICT[lang][k] != null) el.textContent = DICT[lang][k];
    });
  }
  function set(l) { if (DICT[l]) { lang = l; apply(); } }
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    document.querySelectorAll('[data-lang]').forEach(function (a) {
      a.addEventListener('click', function () { set(a.getAttribute('data-lang')); });
    });
  });
  global.i18n = { t: t, set: set, get lang() { return lang; } };
})(window);
