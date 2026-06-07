// js/short-name.js — display-only name shortener for public surfaces.
// shortName("Annabelle Kowalski") -> "Annabelle K."
// Data keeps FULL names everywhere (DB, links, search) — this is applied at
// render time only. Single-word names pass through ("Aurora" -> "Aurora");
// already-short names ("Richard H.") come out unchanged; multi-part last
// names use the final word ("Mary Jo Van Dyke" -> "Mary D.").
(function () {
  window.shortName = function (n) {
    const parts = String(n || '').trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    const last = parts[parts.length - 1];
    return parts[0] + ' ' + last[0].toUpperCase() + '.';
  };
})();
