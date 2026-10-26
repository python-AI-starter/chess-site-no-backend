// Shared UI helpers. All user-visible text goes through I18n.t.
(function () {
  "use strict";

  const U = {};

  U.esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  U.el = function (html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  U.qs = (sel, root) => (root || document).querySelector(sel);
  U.qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ISO timestamptz (may carry microseconds) to milliseconds
  U.parseTs = function (ts) {
    if (ts == null) return null;
    if (typeof ts === "number") return ts;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(ts);
    if (!m) return Date.parse(ts) || null;
    const ms = m[3] ? Number(m[3].slice(0, 3).padEnd(3, "0")) : 0;
    const iso = `${m[1]}T${m[2]}.${String(ms).padStart(3, "0")}${m[4] || "Z"}`;
    return Date.parse(iso);
  };

  U.fmtClock = function (ms) {
    if (ms == null || ms < 0) ms = 0;
    const t = Math.ceil(ms / 100) / 10; // tenths
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms % 3600000 / 60000);
    const s = Math.floor(ms % 60000 / 1000);
    if (ms < 20000) {
      const d = Math.floor(ms % 1000 / 100);
      return `${s}.${d}`;
    }
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  U.fmtTc = function (initialMs, incMs) {
    const min = Math.round(initialMs / 60000);
    return `${min}+${Math.round(incMs / 1000)}`;
  };

  U.fmtDate = function (ts) {
    const d = new Date(typeof ts === "number" ? ts : U.parseTs(ts));
    return d.toLocaleString(I18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  // Day with a textual month name, year and time ("23 окт 2026, 11:56"),
  // used on every direct message. A month name instead of a number keeps
  // day/month order unambiguous for all locales.
  const MONTHS_SHORT = {
    ru: ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"],
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  };
  U.fmtDateTime = function (ts) {
    const d = new Date(typeof ts === "number" ? ts : U.parseTs(ts));
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (I18n.lang === "zh")
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    const mo = (MONTHS_SHORT[I18n.lang] || MONTHS_SHORT.en)[d.getMonth()];
    if (I18n.lang === "ru") return `${d.getDate()} ${mo} ${d.getFullYear()}, ${hm}`;
    return `${mo} ${d.getDate()}, ${d.getFullYear()}, ${hm}`;
  };

  // Send arrow for chat submit buttons (the Lichess-style triangle).
  U.sendIcon = function () {
    return '<svg class="send-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  };

  // Stroke icons for the direct-message header buttons.
  U.iconSwords = function () {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 10"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/></svg>';
  };
  U.iconBan = function () {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
  };

  U.toast = function (msg, kind) {
    const box = U.qs("#toasts");
    const t = U.el(`<div class="toast ${kind || ""}">${U.esc(msg)}</div>`);
    box.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4200);
  };

  U.confirmModal = function (title, text, okLabel) {
    return new Promise((resolve) => {
      const root = U.qs("#modal-root");
      root.innerHTML = "";
      const m = U.el(`
        <div class="modal-overlay">
          <div class="modal">
            <h3>${U.esc(title)}</h3>
            <p>${U.esc(text || "")}</p>
            <div class="modal-actions">
              <button class="btn ghost" data-act="no">${U.esc(I18n.t("common.cancel"))}</button>
              <button class="btn danger" data-act="yes">${U.esc(okLabel || I18n.t("common.yes"))}</button>
            </div>
          </div>
        </div>`);
      m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest("[data-act=no]")) { root.innerHTML = ""; resolve(false); }
        if (e.target.closest("[data-act=yes]")) { root.innerHTML = ""; resolve(true); }
      });
      root.appendChild(m);
    });
  };

  // Double confirmation for irreversible moderation actions: ask, then confirm.
  U.confirmDanger = async function (title, text, okLabel) {
    if (!(await U.confirmModal(title, text, okLabel || I18n.t("common.yes")))) return false;
    return U.confirmModal(I18n.t("common.sureTitle"), I18n.t("common.sureText"), I18n.t("common.yesSure"));
  };

  // Player role badge (creator/admin) for profiles and chats
  U.roleBadge = function (role) {
    if (role === "creator") return `<span class="badge role-badge role-creator" title="${U.esc(I18n.t("role.creatorTitle"))}">${I18n.t("role.creator")}</span>`;
    if (role === "admin") return `<span class="badge role-badge role-admin" title="${U.esc(I18n.t("role.adminTitle"))}">${I18n.t("role.admin")}</span>`;
    return "";
  };
  // True when the current user is a moderator (creator/admin)
  U.amMod = function () {
    const r = App.profile && App.profile.role;
    return r === "creator" || r === "admin";
  };

  U.infoModal = function (html) {
    const root = U.qs("#modal-root");
    root.innerHTML = "";
    const m = U.el(`<div class="modal-overlay"><div class="modal">${html}
      <div class="modal-actions"><button class="btn primary" data-act="ok">${U.esc(I18n.t("common.ok"))}</button></div></div></div>`);
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-act=ok]")) root.innerHTML = "";
    });
    root.appendChild(m);
  };

  // Escape text and turn links into anchors: internal game routes
  // (clean or legacy #/ form) and external http(s) links.
  U.linkify = function (text) {
    const s = U.esc(text);
    // internal game routes first, both legacy "#/game/<uuid>" and the
    // clean "game/<uuid>" stored by challenge messages
    let out = s.replace(/(^|\s)((#\/)?game\/[0-9a-f-]{10,})/gi,
      (m, sp, url) => `${sp}<a href="${url.startsWith("#/") ? url : "#/" + url}">${url}</a>`);
    // then external http(s) links
    out = out.replace(/(https?:\/\/[^^\s<>&"']+)/g,
      (m, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return out;
  };

  // Modal form. fields: [{ id, label, type: 'text'|'textarea'|'select',
  //   options: [{v,l}], value, placeholder, maxlength, rows }]
  // Resolves to {id: value, ...} or null when cancelled.
  U.formModal = function (title, fields, okLabel) {
    return new Promise((resolve) => {
      const root = U.qs("#modal-root");
      root.innerHTML = "";
      const body = fields.map(f => {
        const common =
          `id="fm-${U.esc(f.id)}" maxlength="${f.maxlength || 200}"` +
          ` placeholder="${U.esc(f.placeholder || "")}"`;
        if (f.type === "textarea") {
          return `<label for="fm-${U.esc(f.id)}">${U.esc(f.label)}</label>
            <textarea ${common} rows="${f.rows || 4}">${U.esc(f.value || "")}</textarea>`;
        }
        if (f.type === "select") {
          const opts = (f.options || [])
            .map(o => `<option value="${U.esc(o.v)}" ${String(f.value) === String(o.v) ? "selected" : ""}>${U.esc(o.l)}</option>`)
            .join("");
          return `<label for="fm-${U.esc(f.id)}">${U.esc(f.label)}</label>
            <select ${common}>${opts}</select>`;
        }
        return `<label for="fm-${U.esc(f.id)}">${U.esc(f.label)}</label>
          <input ${common} type="${f.type || "text"}" value="${U.esc(f.value || "")}" autocomplete="off">`;
      }).join("");
      const m = U.el(`
        <div class="modal-overlay">
          <form class="modal" id="fm-form">
            <h3>${U.esc(title)}</h3>
            ${body}
            <div class="err" id="fm-err"></div>
            <div class="modal-actions">
              <button type="button" class="btn ghost" data-act="cancel">${U.esc(I18n.t("common.cancel"))}</button>
              <button type="submit" class="btn primary">${U.esc(okLabel || I18n.t("common.save"))}</button>
            </div>
          </form>
        </div>`);
      const close = (val) => {
        document.removeEventListener("keydown", escHandler);
        root.innerHTML = "";
        resolve(val);
      };
      const escHandler = (e) => { if (e.key === "Escape") close(null); };
      document.addEventListener("keydown", escHandler);
      m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest("[data-act=cancel]")) close(null);
      });
      U.qs("#fm-form", m).addEventListener("submit", (e) => {
        e.preventDefault();
        const out = {};
        fields.forEach(f => { out[f.id] = U.qs("#fm-" + f.id, m).value; });
        close(out);
      });
      root.appendChild(m);
      const first = U.qs("#fm-" + fields[0].id, m);
      if (first) first.focus();
    });
  };

  // Simple WebAudio sounds
  let audioCtx = null;
  U.beep = function (freq, dur, type) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || "sine";
      o.frequency.value = freq;
      g.gain.value = 0.06;
      o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.08));
      o.start(t); o.stop(t + (dur || 0.08));
    } catch (e) { /* audio unavailable */ }
  };
  U.soundMove = () => U.beep(440, 0.06, "sine");
  U.soundCapture = () => U.beep(220, 0.09, "square");
  U.soundEnd = () => { U.beep(330, 0.15); setTimeout(() => U.beep(220, 0.25), 140); };

  window.U = U;
})();
