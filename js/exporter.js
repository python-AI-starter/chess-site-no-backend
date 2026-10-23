// FEN and PGN export helpers. PGN is assembled with the vendored chess.js
// from the game's start FEN and the stored UCI move list, so no extra
// database calls or RPCs are needed. The export modal shows the text with
// copy and download actions.
(function () {
  "use strict";

  const Exporter = {};

  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  // PGN result string from a game row
  function resultOf(g) {
    if (g.status === "finished" && g.result) return g.result; // "1-0" | "0-1" | "1/2-1/2"
    return "*";
  }

  function timeControlOf(g) {
    // PGN TimeControl tag: seconds per period + increment in seconds;
    // games without clocks (analysis boards) use the unlimited marker
    if (g.initial_ms == null) return "-";
    const secs = Math.round((g.initial_ms || 0) / 1000);
    const inc = Math.round((g.increment_ms || 0) / 1000);
    return `${secs}+${inc}`;
  }

  function timeClassOf(g) {
    if (g.initial_ms == null) return "-";
    const total = (g.initial_ms || 0) + 40 * (g.increment_ms || 0);
    if (total < 180000) return "Bullet";
    if (total < 480000) return "Blitz";
    if (total < 1500000) return "Rapid";
    return "Classical";
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function pgnDate(iso) {
    const d = new Date(iso || Date.now());
    if (isNaN(d)) return "???.??";
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }

  /**
   * Build the PGN text for a game.
   * opts: {
   *   startFen, moves: [{u,s}], white, black,
   *   whiteElo?, blackElo?, result?, status?, initial_ms, increment_ms,
   *   rated?, created_at?, finished_at?, site?
   * }
   */
  Exporter.buildPgn = function (opts) {
    const startFen = opts.startFen || opts.start_fen || START_FEN;
    let chess;
    try { chess = new window.Chess(startFen); } catch (e) { return null; }
    const fenHeader = startFen !== START_FEN;
    chess.header(
      "Event", opts.event || (opts.rated ? "Rated game" : "Casual game"),
      "Site", opts.site || location.origin + location.pathname,
      "Date", pgnDate(opts.finished_at || opts.created_at),
      "Round", "-",
      "White", opts.white || "White",
      "Black", opts.black || "Black",
      "Result", opts.result != null ? opts.result : resultOf(opts),
      "TimeControl", timeControlOf(opts),
      "Variant", "Standard",
      "WhiteElo", opts.whiteElo != null ? String(opts.whiteElo) : "?",
      "BlackElo", opts.blackElo != null ? String(opts.blackElo) : "?",
      "TimeClass", timeClassOf(opts)
    );
    if (fenHeader) {
      chess.header("SetUp", "1");
      chess.header("FEN", startFen);
    }
    let ok = true;
    for (const m of (opts.moves || [])) {
      try {
        chess.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4),
                     promotion: m.u.length === 5 ? m.u[4] : undefined });
      } catch (e) { ok = false; break; }
    }
    if (!ok) return null;
    return chess.pgn({ newline: "\n", maxWidth: 80 });
  };

  Exporter.resultOf = resultOf;

  // Parse PGN text into {startFen, moves:[{u,s,fenAfter}]} for the inline
  // PGN fields; returns null when the text is not a readable game
  Exporter.parsePgn = function (text) {
    if (!text || !String(text).trim()) return null;
    const c = new window.Chess();
    try { c.loadPgn(String(text), { strict: false }); } catch (e) { return null; }
    const hist = c.history({ verbose: true });
    if (!hist.length) return null;
    return {
      startFen: hist[0].before,
      moves: hist.map(m => ({
        u: m.from + m.to + (m.promotion || ""),
        s: m.san,
        fenAfter: m.after
      }))
    };
  };

  // Copy text to the clipboard with a toast fallback
  Exporter.copyText = async function (text) {
    let done = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) { /* fall through */ }
    if (!done) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { done = document.execCommand("copy"); } catch (e) {}
      ta.remove();
    }
    U.toast(done ? I18n.t("export.copied") : I18n.t("export.copyFailed"), done ? "good" : "error");
    return done;
  };

  function download(name, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Modal with a read-only text area plus copy and download buttons.
  // title: modal title, text: payload, filename: download name
  Exporter.showModal = function (title, text, filename) {
    const root = U.qs("#modal-root");
    root.innerHTML = "";
    const m = U.el(`
      <div class="modal-overlay">
        <div class="modal export-modal">
          <h3>${U.esc(title)}</h3>
          <textarea class="export-text" readonly spellcheck="false"></textarea>
          <div class="modal-actions">
            <button type="button" class="btn ghost" data-act="copy">${U.esc(I18n.t("export.copyBtn"))}</button>
            <button type="button" class="btn" data-act="dl">${U.esc(I18n.t("export.download"))}</button>
            <button type="button" class="btn primary" data-act="close">${U.esc(I18n.t("common.ok"))}</button>
          </div>
        </div>
      </div>`);
    const ta = U.qs(".export-text", m);
    ta.value = text;
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-act=close]")) root.innerHTML = "";
      if (e.target.closest("[data-act=copy]")) Exporter.copyText(text);
      if (e.target.closest("[data-act=dl]")) download(filename, text);
    });
    root.appendChild(m);
    ta.focus();
    ta.select();
  };

  // One-click helpers used by buttons across the site.
  // meta: {white, black, whiteElo, blackElo, result, rated, ...game fields}
  Exporter.exportFen = function (fen) {
    Exporter.showModal(I18n.t("export.fenTitle"), fen, "position.fen");
  };
  Exporter.exportPgn = function (game, meta) {
    const pgn = Exporter.buildPgn(Object.assign({}, game, meta || {}));
    if (pgn == null) return U.toast(I18n.t("export.pgnError"), "error");
    const names = `${(meta && meta.white) || "white"}-vs-${(meta && meta.black) || "black"}`.replace(/\s+/g, "_");
    Exporter.showModal(I18n.t("export.pgnTitle"), pgn, `${names}.pgn`);
  };

  window.Exporter = Exporter;
})();
