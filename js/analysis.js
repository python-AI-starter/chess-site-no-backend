// Engine analysis: a reusable panel (vertical eval bar with a midpoint
// mark, MultiPV lines, best-move arrows, gear-menu settings) plus the
// standalone analysis board page. The panel drives the shared Stockfish
// worker (js/engine.js) over UCI and follows whatever position its host
// page is currently showing. All engine work happens in the browser;
// nothing touches the database.
//
// The layout follows Lichess: the engine box sits at the very top of the
// side column, the move list in the middle, the interface buttons at the
// bottom; the FEN and PGN fields live directly under the board and apply
// pasted or edited content automatically, with no separate load button.
// The eval bar is vertical with a midpoint mark; the best move is drawn
// as a light-blue arrow and MultiPV runners-up as fading gray arrows.
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const t = (key, params) => I18n.t(key, params);

  // engine settings (v2 adds threads = 0 meaning "auto"); the legacy key
  // is migrated once so nobody stays stuck on the old forced single thread
  const SETTINGS_KEY = "ladya-sf-settings-v2";
  const LEGACY_SETTINGS_KEY = "ladya-sf-settings";
  const ON_KEY = "ladya-sf-on";
  const DEFAULTS = { movetime: 0, multipv: 1, threads: 0, hash: 32 };

  function loadSettings() {
    try {
      let s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!s) {
        s = JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY) || "{}");
        if (s.threads != null && s.threads <= 1) delete s.threads; // back to auto
      }
      const out = Object.assign({}, DEFAULTS);
      if ([0, 1000, 2000, 5000, 10000, 30000, 60000].includes(s.movetime)) out.movetime = s.movetime;
      if (s.multipv >= 1 && s.multipv <= 5) out.multipv = s.multipv;
      if (s.threads === 0 || (s.threads >= 1 && s.threads <= 32)) out.threads = s.threads;
      if ([16, 32, 64, 128, 256, 512, 1024].includes(s.hash)) out.hash = s.hash;
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function wasOn() {
    try { return localStorage.getItem(ON_KEY) === "1"; } catch (e) { return false; }
  }
  function setWasOn(v) {
    try { localStorage.setItem(ON_KEY, v ? "1" : "0"); } catch (e) {}
  }

  // score and eval helpers
  function fmtCp(cp) {
    const v = cp / 100;
    return (v > 0 ? "+" : v < 0 ? "" : "") + v.toFixed(2);
  }
  function fmtScoreWhite(score) {
    // score: {cp} | {mate} already converted to the white point of view
    if (!score) return "—";
    if (score.mate != null) return score.mate > 0 ? "M" + score.mate : "-" + Math.abs(score.mate) + "M";
    return fmtCp(score.cp || 0);
  }
  // Lichess winning-chances curve: cp -> white share of the bar
  function whiteBarPct(score) {
    if (!score) return 50;
    if (score.mate != null) return score.mate > 0 ? 100 : 0;
    const cp = score.cp || 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }
  function fmtNps(nps) {
    if (!nps || nps <= 0) return "";
    if (nps >= 1000000) return (nps / 1000000).toFixed(1) + "M";
    if (nps >= 1000) return Math.round(nps / 1000) + "K";
    return String(nps);
  }
  // compact score for the narrow eval bar: no sign, one decimal, short mate
  function fmtBarScore(score) {
    if (!score) return "";
    if (score.mate != null) return score.mate > 0 ? "M" + score.mate : "-M" + Math.abs(score.mate);
    return Math.abs(score.cp / 100).toFixed(1);
  }
  function fmtBytes(n) { return (n / 1048576).toFixed(1); }

  // a position where the side NOT to move is already in check never occurs
  // in a real game; it can only come from a hand-typed FEN, and searching
  // it can wedge the engine, so such FENs are refused before "go"
  function searchableFen(fen) {
    try {
      const c = new window.Chess(fen);
      const parts = c.fen().split(" ");
      parts[1] = parts[1] === "w" ? "b" : "w";
      return !new window.Chess(parts.join(" ")).inCheck();
    } catch (e) { return false; }
  }

  // parse one UCI "info" line into a compact object (or null)
  function parseInfo(line) {
    if (!/^info\s/.test(line) || /\bcurrmove\b/.test(line)) return null;
    const tk = line.split(/\s+/);
    const out = {};
    for (let i = 1; i < tk.length - 1; i++) {
      if (tk[i] === "score") {
        const kind = tk[i + 1], val = Number(tk[i + 2]);
        if (kind === "cp") out.score = { cp: val };
        else if (kind === "mate") out.score = { mate: val };
        i += 2;
      } else if (["depth", "seldepth", "multipv", "nodes", "nps", "time", "hashfull"].includes(tk[i])) {
        out[tk[i]] = Number(tk[i + 1]);
        i++;
      } else if (tk[i] === "pv") {
        out.pv = tk.slice(i + 1);
        break;
      }
    }
    return out.pv || out.depth ? out : null;
  }

  // convert a PV of UCI moves into numbered SAN text
  function pvToSan(fen, ucis) {
    if (!window.Chess || !fen) return (ucis || []).join(" ");
    const parts = [];
    try {
      const c = new window.Chess(fen);
      let moveNo = parseInt((fen.split(" ")[5] || "1"), 10) || 1;
      let whiteToMove = (fen.split(" ")[1] || "w") === "w";
      for (const u of ucis || []) {
        let mv = null;
        try {
          mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length === 5 ? u[4] : undefined });
        } catch (e) { break; }
        if (!mv) break;
        if (whiteToMove) parts.push(moveNo + ". " + mv.san);
        else if (!parts.length) parts.push(moveNo + "... " + mv.san);
        else parts.push(mv.san);
        if (!whiteToMove) moveNo++;
        whiteToMove = !whiteToMove;
      }
    } catch (e) { /* fall through to raw uci */ }
    return parts.length ? parts.join(" ") : (ucis || []).join(" ");
  }

  function sqIdx(name) { return "abcdefgh".indexOf(name[0]) + 8 * (Number(name[1]) - 1); }

  // Inline auto-applying field: validates on every edit (debounced) and
  // applies the value when valid; an invalid value turns the border red,
  // a successful apply flashes it green. Enter applies immediately.
  function autoApplyField(input, opts) {
    let timer = null;
    const mark = (cls) => {
      input.classList.remove("bad", "flash-ok");
      if (cls) {
        input.classList.add(cls);
        if (cls === "flash-ok") setTimeout(() => input.classList.remove("flash-ok"), 900);
      }
    };
    const run = () => {
      const val = input.value.trim();
      if (!val) { mark(null); return; }
      const parsed = opts.validate(val);
      if (parsed == null) { mark("bad"); return; }
      if (opts.apply(parsed)) mark("flash-ok"); else mark("bad");
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, opts.delay || 600);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); run(); }
    });
    return { run, mark };
  }

  // AnalysisPanel: engine head + lines; the eval bar is rendered into a
  // slot beside the board. opts:
  //   getFen()     -> current FEN to analyze
  //   getBoard()   -> ChessBoard instance for arrows (optional)
  //   getBarSlot() -> element for the vertical eval bar (optional)
  //   isFinal()    -> true when the watched game ended by the rules of
  //                   chess (checkmate, stalemate, ...): the panel then
  //                   shows "game over" and the engine never starts
  class AnalysisPanel {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      this.settings = loadSettings();
      this.on = false;
      this.unsubs = [];
      this.lines = {};        // multipv index -> {score, depth, pv, nps, nodes}
      this.maxDepth = 0;
      this.illegal = false;   // current position is not searchable
      this.fen = null;
      this.lastRender = 0;
      this._renderTimer = null;
      this._build();
      this.unsubs.push(EngineHost.onStatus((st) => {
        if (st === "error" && this.on) {
          U.toast(t("analysis.engineError"), "error");
          this.turnOff();
        }
        this._drawStatus();
      }));
      this.unsubs.push(EngineHost.onProgress((ph, got, total) => this._drawProgress(ph, got, total)));
      this._unsubLines = EngineHost.onLine((line) => this._onUci(line));
      this._drawStatus();
      this._renderLines(true);
      // restore the last engine state
      if (wasOn()) this.turnOn();
    }

    _build() {
      this.el.classList.add("engine-panel");
      this.el.innerHTML = `
        <div class="engine-head">
          <button class="btn small ep-toggle" data-ep="toggle"></button>
          <span class="muted small ep-stat"></span>
          <button class="btn ghost small ep-gear" data-ep="gear" title="${U.esc(t("analysis.settings"))}">⚙</button>
        </div>
        <div class="engine-lines"></div>`;
      U.qs('[data-ep="toggle"]', this.el).addEventListener("click", () => this.toggle());
      U.qs('[data-ep="gear"]', this.el).addEventListener("click", () => this.openSettings());
      // vertical eval bar with a midpoint mark, Lichess style: rendered
      // next to the board, white share grows from the bottom
      this._barSlot = this.opts.getBarSlot ? this.opts.getBarSlot() : null;
      if (this._barSlot) {
        this._barSlot.innerHTML = `<div class="eval-bar-v hidden" title="${U.esc(t("analysis.evalBar"))}">
          <div class="ebv-white"></div><div class="ebv-mid"></div><span class="ebv-num"></span></div>`;
      }
    }

    toggle() { this.on ? this.turnOff() : this.turnOn(); }

    // the watched game ended by the rules of chess: there is nothing to
    // search, so the Stockfish worker is not created and no download starts
    _final() { return !!(this.opts.isFinal && this.opts.isFinal()); }

    async turnOn() {
      setWasOn(true);
      this.on = true;
      this.illegal = false;
      this._renderLines(true);
      this._drawStatus();
      if (this._final()) { this._stopForFinal(); return; }
      try {
        await EngineHost.ensure();
        if (!this.on) return;
        await this._applyEngineSettings();
        this._search();
      } catch (e) {
        this.on = false;
        this._drawStatus();
        U.toast(e.message || String(e), "error");
      }
    }

    // clear everything the engine would have produced and keep the panel
    // showing the "game over" note
    _stopForFinal() {
      EngineHost.stopSearch();
      this.lines = {};
      this.maxDepth = 0;
      this._clearArrows();
      this._renderLines(true);
    }

    turnOff() {
      setWasOn(false);
      this.on = false;
      this.illegal = false;
      EngineHost.stopSearch();
      this.lines = {};
      this.maxDepth = 0;
      this._clearArrows();
      this._renderLines(true);
      this._drawStatus();
    }

    // the watched position changed: clear stale data and re-search
    sync() {
      if (!this.on) { this._clearArrows(); return; }
      this.lines = {};
      this.maxDepth = 0;
      this.illegal = false;
      this._renderLines(true);
      this._search();
    }

    _resolveThreads() {
      return this.settings.threads > 0 ? this.settings.threads : EngineHost.autoThreads();
    }

    // push the dialog options into the engine and wait for confirmation:
    // a search sent back-to-back with a Threads change can deadlock it
    async _applyEngineSettings() {
      const s = this.settings;
      const cmds = [`name MultiPV value ${s.multipv}`];
      if (EngineHost.isMultiThreaded()) cmds.push(`name Threads value ${this._resolveThreads()}`);
      cmds.push(`name Hash value ${s.hash}`);
      await EngineHost.configure(cmds);
    }

    _search() {
      if (this._final()) { this._stopForFinal(); return; }
      const fen = this.opts.getFen ? this.opts.getFen() : null;
      if (!fen) return;
      this.illegal = !searchableFen(fen);
      if (this.illegal) {
        // a hand-typed FEN can describe a position that never occurs in a
        // game (the side not to move is already in check); searching it can
        // wedge the engine, so show a hint instead and stop any search that
        // is still running for the previous position
        EngineHost.stopSearch();
        this.lines = {};
        this.maxDepth = 0;
        this._clearArrows();
        this._renderLines(true);
        return;
      }
      this.fen = fen;
      this._clearArrows();
      EngineHost.search(fen, this.settings.movetime);
    }

    _onUci(line) {
      if (!this.on || this.illegal || this._final()) return;   // an illegal position is never searched
      if (/^bestmove/.test(line)) { this._renderSoon(true); return; }
      const info = parseInfo(line);
      if (!info) return;
      const idx = info.multipv || 1;
      if (idx > this.settings.multipv) return;
      const prev = this.lines[idx] || {};
      // UCI scores are relative to the side to move; show the white view
      let score = info.score || prev.score;
      if (score && this.fen) {
        const stm = (this.fen.split(" ")[1] || "w");
        if (stm === "b") {
          score = score.mate != null ? { mate: -score.mate } : { cp: -(score.cp || 0) };
        }
      }
      this.lines[idx] = {
        score: score || prev.score,
        depth: info.depth != null ? info.depth : prev.depth,
        pv: info.pv || prev.pv,
        nps: info.nps || prev.nps,
        nodes: info.nodes || prev.nodes
      };
      if (info.depth) this.maxDepth = Math.max(this.maxDepth, info.depth);
      this._renderSoon();
    }

    _renderSoon(force) {
      const now = Date.now();
      if (force || now - this.lastRender > 300) {
        this.lastRender = now;
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        this._renderLines();
      } else if (!this._renderTimer) {
        this._renderTimer = setTimeout(() => {
          this._renderTimer = null;
          this._renderLines();
        }, 300 - (now - this.lastRender));
      }
    }

    _clearArrows() {
      const b = this.opts.getBoard && this.opts.getBoard();
      if (b && b.arrows && b.arrows.length) { b.arrows = []; b.render(); }
    }

    // best move as a light-blue arrow, MultiPV runners-up as gray arrows
    // that fade with each worse line (up to five in total)
    _drawArrows() {
      const b = this.opts.getBoard && this.opts.getBoard();
      if (!b) return;
      if (!this.on) { if (b.arrows.length) { b.arrows = []; b.render(); } return; }
      const idxs = Object.keys(this.lines).map(Number)
        .sort((a, x) => a - x).slice(0, Math.max(1, this.settings.multipv));
      const arrows = [];
      idxs.forEach((idx) => {
        const pv = this.lines[idx].pv;
        if (pv && pv[0] && pv[0].length >= 4) {
          arrows.push({
            from: sqIdx(pv[0].slice(0, 2)),
            to: sqIdx(pv[0].slice(2, 4)),
            color: "engine" + Math.min(Math.max(idx, 1), 5)
          });
        }
      });
      b.arrows = arrows;
      b.render();
    }

    // vertical eval bar: white share from the bottom, midpoint mark, the
    // score number pinned to the fill boundary (kept readable at the ends)
    _drawBar() {
      if (!this._barSlot) return;
      this._barSlot.classList.toggle("hidden", !this.on);
      const bar = U.qs(".eval-bar-v", this._barSlot);
      if (!bar) return;
      bar.classList.toggle("hidden", !this.on);
      const fill = U.qs(".ebv-white", bar);
      const num = U.qs(".ebv-num", bar);
      if (!fill || !num) return;
      const score = this.lines[1] ? this.lines[1].score : null;
      const pct = whiteBarPct(score);
      fill.style.height = pct.toFixed(1) + "%";
      if (!this.on || !score) { num.textContent = ""; return; }
      num.textContent = fmtBarScore(score);
      if (pct < 18) {
        num.style.top = "auto"; num.style.bottom = "4px";
        num.style.transform = "translate(-50%, 0)";
        num.style.color = "#111"; num.style.textShadow = "none";
      } else if (pct > 82) {
        num.style.top = "4px"; num.style.bottom = "auto";
        num.style.transform = "translate(-50%, 0)";
        num.style.color = "#fff"; num.style.textShadow = "0 1px 2px rgba(0,0,0,.8)";
      } else {
        num.style.top = "auto"; num.style.bottom = pct.toFixed(1) + "%";
        num.style.transform = "translate(-50%, 50%)";
        num.style.color = "#fff"; num.style.textShadow = "0 1px 2px rgba(0,0,0,.8)";
      }
    }

    _renderLines(reset) {
      if (!this.el) return;
      const box = U.qs(".engine-lines", this.el);
      if (!box) return;
      this._drawArrows();
      this._drawBar();
      const top = this.lines[1];
      const score = top ? top.score : null;
      const stat = U.qs(".ep-stat", this.el);
      if (stat) {
        if (!this.on) stat.textContent = "";
        else {
          const nps = top && top.nps ? " · " + fmtNps(top.nps) + " " + t("analysis.nps") : "";
          stat.textContent = this.maxDepth ? t("analysis.depth", { depth: this.maxDepth }) + nps : "";
        }
      }
      const idxs = Object.keys(this.lines).map(Number).sort((a, b2) => a - b2);
      if (!idxs.length) {
        const msg = !this.on ? t("analysis.engineOff")
          : this.illegal ? t("analysis.illegalPos")
          : this._final() ? t("analysis.gameOver")
          : t("analysis.thinking");
        box.innerHTML = reset || !this.on || this.illegal || this._final()
          ? `<div class="empty muted small">${U.esc(msg)}</div>`
          : box.innerHTML;
        return;
      }
      const rows = idxs.map(idx => {
        const l = this.lines[idx];
        const cls = score && score.cp != null
          ? (score.cp > 15 ? "good" : score.cp < -15 ? "bad" : "")
          : (score && score.mate != null ? (score.mate > 0 ? "good" : "bad") : "");
        return `<div class="engine-line">
          <span class="el-score ${cls}">${U.esc(fmtScoreWhite(l.score))}</span>
          <span class="el-pv" title="${U.esc(pvToSan(this.fen, l.pv))}">${U.esc(pvToSan(this.fen, l.pv))}</span>
        </div>`;
      }).join("");
      box.innerHTML = rows;
    }

    _drawStatus() {
      const btn = U.qs('[data-ep="toggle"]', this.el);
      if (btn) btn.textContent = this.on ? U.esc(t("analysis.engineOn")) : U.esc(t("analysis.engineOffBtn"));
      if (this.on && EngineHost.status() === "loading" && !this._progressShown) {
        const stat = U.qs(".ep-stat", this.el);
        if (stat) stat.textContent = U.esc(t("analysis.loadingEngine"));
      }
      this._drawBar();
    }

    _drawProgress(phase, got, total) {
      if (!this.on || EngineHost.status() !== "loading") return;
      this._progressShown = true;
      clearTimeout(this._progressHide);
      this._progressHide = setTimeout(() => { this._progressShown = false; }, 1500);
      const stat = U.qs(".ep-stat", this.el);
      if (!stat) return;
      if (phase === "wasm" && total) {
        stat.textContent = U.esc(t("analysis.downloading", { got: fmtBytes(got), total: fmtBytes(total) }));
      } else {
        stat.textContent = U.esc(t("analysis.loadingEngine"));
      }
    }

    // Lichess-style gear menu: search time per move, MultiPV, threads, hash
    openSettings() {
      const root = U.qs("#modal-root");
      root.innerHTML = "";
      const s = this.settings;
      const mt = EngineHost.isMultiThreaded();
      const maxThreads = mt ? Math.min(Math.max(navigator.hardwareConcurrency || 1, 1), 32) : 1;
      const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${U.esc(l)}</option>`;
      const threadOpts = [];
      if (mt) {
        threadOpts.push(opt(0, t("analysis.autoThreads") + " (" + EngineHost.autoThreads() + ")", s.threads));
        for (let i = 1; i <= maxThreads; i++) threadOpts.push(opt(i, String(i), s.threads));
      } else {
        threadOpts.push(opt(1, "1", 1));
      }
      const hashOpts = [16, 32, 64, 128, 256, 512, 1024].filter(v => v <= (CFG.ENGINE_HASH_MAX_MB || 1024))
        .map(v => opt(v, v + " MB", s.hash));
      const mtOpts = [
        opt(0, t("analysis.infinite"), s.movetime),
        opt(1000, "1 " + t("common.sec"), s.movetime),
        opt(2000, "2 " + t("common.sec"), s.movetime),
        opt(5000, "5 " + t("common.sec"), s.movetime),
        opt(10000, "10 " + t("common.sec"), s.movetime),
        opt(30000, "30 " + t("common.sec"), s.movetime),
        opt(60000, "60 " + t("common.sec"), s.movetime)
      ].join("");
      const pvOpts = [1, 2, 3, 4, 5].map(v => opt(v, String(v), s.multipv)).join("");
      const m = U.el(`
        <div class="modal-overlay">
          <div class="modal engine-settings">
            <h3>⚙ ${U.esc(t("analysis.settings"))}</h3>
            <label for="sf-movetime">${U.esc(t("analysis.movetime"))}</label>
            <select id="sf-movetime">${mtOpts}</select>
            <p class="muted small">${U.esc(t("analysis.movetimeHint"))}</p>
            <label for="sf-multipv">${U.esc(t("analysis.multipv"))}</label>
            <select id="sf-multipv">${pvOpts}</select>
            <p class="muted small">${U.esc(t("analysis.multipvHint"))}</p>
            <label for="sf-threads">${U.esc(t("analysis.threads"))}</label>
            <select id="sf-threads" ${mt ? "" : "disabled"}>${threadOpts.join("")}</select>
            <p class="muted small">${U.esc(mt ? t("analysis.threadsHint") : t("analysis.threadsUnavailable"))}</p>
            <label for="sf-hash">${U.esc(t("analysis.hash"))}</label>
            <select id="sf-hash">${hashOpts}</select>
            <p class="muted small">${U.esc(t("analysis.hashHint"))}</p>
            <div class="modal-actions">
              <button type="button" class="btn ghost" data-act="cancel">${U.esc(t("common.cancel"))}</button>
              <button type="button" class="btn primary" data-act="ok">${U.esc(t("common.save"))}</button>
            </div>
          </div>
        </div>`);
      m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest("[data-act=cancel]")) root.innerHTML = "";
        if (e.target.closest("[data-act=ok]")) {
          const prev = Object.assign({}, s);
          s.movetime = Number(U.qs("#sf-movetime", m).value) || 0;
          s.multipv = Number(U.qs("#sf-multipv", m).value) || 1;
          s.threads = mt ? Number(U.qs("#sf-threads", m).value) || 0 : 0;
          s.hash = Number(U.qs("#sf-hash", m).value) || 32;
          root.innerHTML = "";
          saveSettings(s);
          if (this.on && !this._final() &&
              (prev.movetime !== s.movetime || prev.multipv !== s.multipv ||
               prev.threads !== s.threads || prev.hash !== s.hash)) {
            this._applyEngineSettings().then(() => this._search()).catch(() => {});   // restart the search so the settings take effect
          }
        }
      });
      root.appendChild(m);
    }

    destroy() {
      this.on = false;
      if (this._unsubLines) this._unsubLines();
      this.unsubs.forEach(u => { try { u(); } catch (e) {} });
      if (this._renderTimer) clearTimeout(this._renderTimer);
      EngineHost.stopSearch();
      if (this._barSlot) this._barSlot.innerHTML = "";
      this.el.classList.remove("engine-panel");
      this.el.innerHTML = "";
    }
  }

  // Analysis board page (#/analysis): Lichess-style layout, engine on
  // top, moves in the middle, buttons at the bottom, FEN/PGN fields under
  // the board that apply their content automatically.
  const AnalysisBoardPage_render = async function (container, fenParam) {
    const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const S = {
      startFen: START_FEN,
      hist: [],      // [{u,s,fenAfter}]
      viewPly: 0,    // half-moves shown (0 = start position)
      destroyed: false
    };
    container.innerHTML = `<div class="card center"><span class="spinner"></span> ${U.esc(t("common.loading"))}</div>`;

    // optional FEN from the URL query (#/analysis?fen=...)
    if (fenParam) {
      try {
        const c = new window.Chess(fenParam);
        S.startFen = c.fen();
      } catch (e) { U.toast(t("analysis.badFen"), "error"); }
    }

    const root = U.el(`<div class="an-layout">
      <div class="an-board-col">
        <div class="an-board-row">
          <div class="an-eval-slot" id="ab-eval"></div>
          <div class="board-wrap"><div id="ab-board"></div></div>
        </div>
        <div class="replay-bar" id="ab-replaybar"></div>
        <div class="an-fields">
          <div class="an-field-row">
            <input id="ab-fen" class="an-field" spellcheck="false" autocomplete="off"
              placeholder="${U.esc(t("analysis.fenPh"))}" title="${U.esc(t("analysis.fenFieldTip"))}">
            <button class="btn ghost small an-copy" data-copy="fen" title="${U.esc(t("analysis.copyTip"))}">⧉</button>
          </div>
          <div class="an-field-row">
            <textarea id="ab-pgn" class="an-field" rows="3" spellcheck="false"
              placeholder="${U.esc(t("analysis.pgnPh"))}" title="${U.esc(t("analysis.pgnFieldTip"))}"></textarea>
            <button class="btn ghost small an-copy" data-copy="pgn" title="${U.esc(t("analysis.copyTip"))}">⧉</button>
          </div>
        </div>
      </div>
      <div class="an-side">
        <div class="card an-engine-card"><div id="ab-engine"></div></div>
        <div class="card an-moves-card"><div class="moves-list an-moves" id="ab-moves"></div></div>
        <div class="an-actions">
          <button class="btn small" id="ab-flip">⇅ ${U.esc(t("game.flip"))}</button>
          <button class="btn small" id="ab-undo" title="${U.esc(t("analysis.undoTitle"))}">↩ ${U.esc(t("analysis.undo"))}</button>
          <button class="btn small" id="ab-reset">${U.esc(t("analysis.reset"))}</button>
        </div>
      </div>
    </div>`);
    container.innerHTML = "";
    container.appendChild(root);

    function chessAt(ply) {
      // rebuild the position after `ply` half-moves (cheap enough locally)
      const c = new window.Chess(S.startFen);
      for (let i = 0; i < ply; i++) {
        const m = S.hist[i];
        c.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4), promotion: m.u.length === 5 ? m.u[4] : undefined });
      }
      return c;
    }
    function fenAt(ply) { return ply <= 0 ? S.startFen : S.hist[ply - 1].fenAfter; }
    function stmAt(ply) {
      const parts = fenAt(ply).split(" ");
      return parts[1] || "w";
    }

    function legalAt(ply) {
      try { return chessAt(ply).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || "")); }
      catch (e) { return []; }
    }

    const board = new ChessBoard(U.qs("#ab-board", root), {
      onMove: (from, to, promo) => playMove(from, to, promo),
      canMove: () => true,
      canPremove: () => false,
      myColor: () => (stmAt(S.viewPly) === "w" ? "white" : "black")
    });

    const fenInput = U.qs("#ab-fen", root);
    const pgnInput = U.qs("#ab-pgn", root);

    function currentPgn() {
      if (!S.hist.length) return "";
      return Exporter.buildPgn({
        startFen: S.startFen,
        moves: S.hist,
        status: "active",
        initial_ms: null,
        increment_ms: 0,
        event: "Analysis board",
        rated: false,
        created_at: new Date().toISOString()
      }) || "";
    }

    // keep the inline fields in step with the position, but never fight
    // the user while they are typing in a field
    function refreshFields(force) {
      if (force || document.activeElement !== fenInput) fenInput.value = fenAt(S.viewPly);
      if (force || document.activeElement !== pgnInput) pgnInput.value = currentPgn();
    }

    function redrawAll() {
      drawBoard();
      drawReplayBar();
      panel.sync();
    }

    function drawBoard() {
      const u = S.viewPly > 0 ? S.hist[S.viewPly - 1].u : null;
      board.setPosition(fenAt(S.viewPly), { lastMove: u ? [u.slice(0, 2), u.slice(2, 4)] : null });
      board.setMoves(legalAt(S.viewPly));
      board.setInteractive(true);
      drawMoves();
      refreshFields(false);
    }

    function loadPosition(fen) {
      S.startFen = fen;
      S.hist = [];
      S.viewPly = 0;
      redrawAll();
      refreshFields(true);
    }

    function loadParsedPgn(p) {
      S.startFen = p.startFen;
      S.hist = p.moves;
      S.viewPly = p.moves.length;
      redrawAll();
      refreshFields(true);
    }

    function playMove(from, to, promo) {
      const c = chessAt(S.viewPly);
      let mv;
      try {
        mv = c.move({ from, to, promotion: promo || undefined });
      } catch (e) { mv = null; }
      if (!mv) return;
      // a move played from a navigated position truncates the rest of the line
      S.hist = S.hist.slice(0, S.viewPly);
      S.hist.push({ u: from + to + (promo || ""), s: mv.san, fenAfter: c.fen() });
      S.viewPly = S.hist.length;
      U.soundMove();
      drawBoard();
      drawReplayBar();
      panel.sync();
    }

    function drawMoves() {
      const rows = [];
      for (let i = 0; i < S.hist.length; i += 2) {
        const plyW = i + 1, plyB = i + 2;
        rows.push(`<tr><td class="num">${i / 2 + 1}.</td>
          <td data-ply="${plyW}" class="${plyW === S.viewPly ? "cur" : ""}">${U.esc(S.hist[i].s)}</td>
          <td data-ply="${plyB}" class="${plyB === S.viewPly ? "cur" : ""}">${S.hist[i + 1] ? U.esc(S.hist[i + 1].s) : ""}</td></tr>`);
      }
      U.qs("#ab-moves", root).innerHTML = rows.length ? `<table>${rows.join("")}</table>`
        : `<div class="empty">${U.esc(t("analysis.noMoves"))}</div>`;
      U.qsa("#ab-moves td[data-ply]", root).forEach(td =>
        td.addEventListener("click", () => goto(Number(td.dataset.ply))));
      const list = U.qs("#ab-moves", root);
      list.scrollTop = list.scrollHeight;
    }

    function drawReplayBar() {
      const bar = U.qs("#ab-replaybar", root);
      bar.innerHTML = `
        <button class="btn ghost small" data-nav="first" title="${U.esc(t("rp.first"))}">|&#9664;</button>
        <button class="btn ghost small" data-nav="prev" title="${U.esc(t("rp.prev"))}">&#9664;</button>
        <button class="btn ghost small" data-nav="next" title="${U.esc(t("rp.next"))}">&#9654;</button>
        <button class="btn ghost small" data-nav="last" title="${U.esc(t("rp.last"))}">&#9654;|</button>
        <span class="muted small" id="ab-pos">${S.viewPly} / ${S.hist.length}</span>`;
      U.qsa("button[data-nav]", bar).forEach(b => b.addEventListener("click", () => {
        const a = b.dataset.nav;
        if (a === "first") goto(0);
        else if (a === "prev") goto(S.viewPly - 1);
        else if (a === "next") goto(S.viewPly + 1);
        else if (a === "last") goto(S.hist.length);
      }));
      U.qs("#ab-pos", bar).textContent = `${S.viewPly} / ${S.hist.length}`;
    }

    function goto(ply) {
      S.viewPly = Math.max(0, Math.min(S.hist.length, ply));
      drawBoard();
      drawReplayBar();
      panel.sync();
    }

    // FEN field: pasted or edited FEN applies itself; an invalid one is
    // marked with a red border and left untouched
    autoApplyField(fenInput, {
      validate: (v) => {
        try { const c = new window.Chess(v); return c.fen() ? c : null; }
        catch (e) { return null; }
      },
      apply: (c) => { loadPosition(c.fen()); return true; }
    });

    // PGN field: pasted or edited PGN replaces the line on the board
    autoApplyField(pgnInput, {
      delay: 700,
      validate: (v) => Exporter.parsePgn(v),
      apply: (p) => { loadParsedPgn(p); return true; }
    });

    U.qsa(".an-copy", root).forEach(b => b.addEventListener("click", () => {
      if (b.dataset.copy === "fen") Exporter.copyText(fenInput.value || fenAt(S.viewPly));
      else Exporter.copyText(pgnInput.value || currentPgn());
    }));

    S.keyHandler = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (e.key === "ArrowLeft") { goto(S.viewPly - 1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { goto(S.viewPly + 1); e.preventDefault(); }
      else if (e.key === "Home") { goto(0); e.preventDefault(); }
      else if (e.key === "End") { goto(S.hist.length); e.preventDefault(); }
    };
    document.addEventListener("keydown", S.keyHandler);

    U.qs("#ab-flip", root).addEventListener("click", () => board.flip());
    U.qs("#ab-undo", root).addEventListener("click", () => {
      if (!S.hist.length) return;
      S.hist.pop();
      S.viewPly = Math.min(S.viewPly, S.hist.length);
      drawBoard();
      drawReplayBar();
      panel.sync();
      refreshFields(true);
    });
    U.qs("#ab-reset", root).addEventListener("click", () => {
      loadPosition(START_FEN);
    });

    const panel = new AnalysisPanel(U.qs("#ab-engine", root), {
      getFen: () => fenAt(S.viewPly),
      getBoard: () => board,
      getBarSlot: () => U.qs("#ab-eval", root)
    });

    // a FEN or PGN handed over from another page (e.g. a replay field)
    try {
      const handedPgn = sessionStorage.getItem("ladya-analysis-pgn");
      if (handedPgn) {
        sessionStorage.removeItem("ladya-analysis-pgn");
        const p = Exporter.parsePgn(handedPgn);
        if (p) { loadParsedPgn(p); U.toast(t("analysis.pgnImported"), "good"); }
        else U.toast(t("analysis.badPgn"), "error");
      } else {
        const handedFen = sessionStorage.getItem("ladya-analysis-fen");
        if (handedFen) {
          sessionStorage.removeItem("ladya-analysis-fen");
          loadPosition(new window.Chess(handedFen).fen());
        }
      }
    } catch (e) {}

    drawBoard();
    drawReplayBar();
    refreshFields(true);

    return function cleanup() {
      S.destroyed = true;
      document.removeEventListener("keydown", S.keyHandler);
      panel.destroy();
    };
  };

  window.AnalysisPanel = AnalysisPanel;
  window.AnalysisBoardPage = { render: AnalysisBoardPage_render };
  window.autoApplyField = autoApplyField;   // shared by the replay fields
})();
