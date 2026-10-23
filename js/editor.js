// Board editor (/editor): set up any position with a piece tray, pick the
// side to move, toggle castling rights and the en passant square, then
// hand the result over to the analysis board or share it as a
// /editor/<fen> link. Interactions follow Lichess: click a tray piece and
// click (or drag it onto) squares to place copies, drag board pieces
// around, right-click deletes, the trash tool deletes by left click, and
// the FEN field applies a pasted or edited position after Enter.
//
// Castling checkboxes exist only while the required pieces stand on their
// original squares: both boxes of a side disappear when its king leaves
// e1/e8, and a single box disappears when its rook leaves h1/a1 (h8/a8).
// The en passant options list every square the side to move can capture on
// geometrically (for a white pawn on e5 with black pawns on d5 and f5 that
// is "none", "d6" and "f6"), with "none" as the default.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);
  const FILES = "abcdefgh";
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const TRAY = ["k", "q", "r", "b", "n", "p"];   // rendered per color
  const sqName = (sq) => FILES[sq & 7] + ((sq >> 3) + 1);
  const sqFromName = (n) => FILES.indexOf(n[0]) + 8 * (Number(n[1]) - 1);

  // EditorPage.render(container, fenArg)
  const EditorPage_render = async function (container, fenArg) {
    const S = {
      squares: new Array(64).fill(null),   // FEN piece char per square, a1=0
      turn: "w",
      castling: { K: true, Q: true, k: true, q: true },
      ep: null,                            // target square name or null
      halfmove: 0,
      fullmove: 1,
      pick: null,                          // tray piece currently carried
      sel: null,                           // selected board square (click-click)
      trash: false,
      flipped: false,
      destroyed: false
    };
    loadFen(START_FEN);
    let badParam = false;
    if (fenArg) {
      let fen = String(fenArg);
      try { fen = decodeURIComponent(fen); } catch (e) {}
      fen = fen.replace(/_/g, " ").replace(/\s+/g, " ").trim();
      if (parseFen(fen)) loadFen(fen);
      else badParam = true;
    }

    container.innerHTML = `<div class="card center"><span class="spinner"></span> ${U.esc(t("common.loading"))}</div>`;
    const root = U.el(`<div class="an-layout">
      <div class="an-board-col">
        <h1>${U.esc(t("editor.title"))}</h1>
        <div class="ed-tray" id="ed-tray-top"></div>
        <div class="board-wrap"><div id="ed-board" class="board"></div></div>
        <div class="ed-tray" id="ed-tray-bottom"></div>
        <p class="muted small">${U.esc(t("editor.hint"))}</p>
        <div class="an-fields">
          <div class="an-field-row">
            <input id="ed-fen" class="an-field" spellcheck="false" autocomplete="off"
              placeholder="${U.esc(t("analysis.fenPh"))}" title="${U.esc(t("analysis.fenFieldTip"))}">
            <button class="btn ghost small an-copy" data-copy="fen" title="${U.esc(t("analysis.copyTip"))}">⧉</button>
          </div>
          <div class="an-field-row">
            <input id="ed-url" class="an-field" readonly title="${U.esc(t("editor.urlTip"))}">
            <button class="btn ghost small an-copy" data-copy="url" title="${U.esc(t("analysis.copyTip"))}">⧉</button>
          </div>
        </div>
      </div>
      <div class="an-side">
        <div class="card">
          <h3>${U.esc(t("editor.position"))}</h3>
          <label>${U.esc(t("editor.turn"))}</label>
          <div class="ed-turn row">
            <button class="btn small" id="ed-turn-w"></button>
            <button class="btn small" id="ed-turn-b"></button>
          </div>
          <label>${U.esc(t("editor.castling"))}</label>
          <div class="ed-checks" id="ed-castling"></div>
          <label>${U.esc(t("editor.enPassant"))}</label>
          <div class="ed-radios" id="ed-ep"></div>
        </div>
        <div class="an-actions">
          <button class="btn small" id="ed-flip" title="${U.esc(t("game.flip"))}">⇅ ${U.esc(t("game.flip"))}</button>
          <button class="btn small" id="ed-start">${U.esc(t("editor.start"))}</button>
          <button class="btn small" id="ed-clear">${U.esc(t("editor.clear"))}</button>
          <button class="btn small" id="ed-trash" title="${U.esc(t("editor.trashTip"))}">🗑 ${U.esc(t("editor.trash"))}</button>
        </div>
        <button class="btn primary block" id="ed-analyze">${U.esc(t("editor.analyze"))}</button>
      </div>
    </div>`);
    container.innerHTML = "";
    container.appendChild(root);
    if (badParam) U.toast(t("analysis.badFen"), "error");

    // board
    const boardEl = U.qs("#ed-board", root);
    const cells = new Array(64);
    function buildBoard() {
      boardEl.innerHTML = "";
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const sq = S.flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col;
          const dark = ((sq >> 3) + (sq & 7)) % 2 === 0;
          const d = document.createElement("div");
          d.className = `sq ${dark ? "dark" : "light"}`;
          d.dataset.sq = sq;
          if (row === 7) {
            const f = document.createElement("span");
            f.className = "coord file";
            f.textContent = FILES[sq & 7];
            d.appendChild(f);
          }
          if (col === 0) {
            const r = document.createElement("span");
            r.className = "coord rank";
            r.textContent = (sq >> 3) + 1;
            d.appendChild(r);
          }
          cells[sq] = d;
          boardEl.appendChild(d);
        }
      }
    }
    function pieceSpan(p, cls) {
      const s = document.createElement("span");
      s.className = `piece ${p === p.toUpperCase() ? "w" : "b"} ${cls || ""}`;
      s.innerHTML = window.pieceSvg ? window.pieceSvg(p) : "";
      return s;
    }
    function drawBoard() {
      for (let sq = 0; sq < 64; sq++) {
        const d = cells[sq];
        for (const c of Array.from(d.children)) {
          if (!c.classList.contains("coord")) c.remove();
        }
        d.classList.toggle("sel", S.sel === sq);
        if (S.squares[sq]) d.appendChild(pieceSpan(S.squares[sq]));
      }
    }
    function redraw() {
      cullRights();
      drawBoard();
      drawTrays();
      drawControls();
      drawFields();
    }

    // piece trays above and below the board
    function drawTrays() {
      const topWhite = S.flipped;   // trays follow the board orientation
      const mk = (color) => {
        const box = document.createElement("div");
        box.className = "ed-tray-row";
        for (const k of TRAY) {
          const p = color === "w" ? k.toUpperCase() : k;
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ed-piece-btn" + (S.pick === p ? " active" : "");
          b.title = t("editor.pickTip");
          b.appendChild(pieceSpan(p));
          b.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            const rect = ev.currentTarget.getBoundingClientRect();
            const again = S.pick === p;
            S.pick = again ? null : p;
            S.sel = null;
            redraw();
            if (!again) startTrayDrag(p, ev, rect);
          });
          box.appendChild(b);
        }
        return box;
      };
      U.qs("#ed-tray-top", root).innerHTML = "";
      U.qs("#ed-tray-top", root).appendChild(mk(topWhite ? "w" : "b"));
      U.qs("#ed-tray-bottom", root).innerHTML = "";
      U.qs("#ed-tray-bottom", root).appendChild(mk(topWhite ? "b" : "w"));
    }

    // drag a tray piece onto the board; a plain click keeps it loaded
    function startTrayDrag(p, ev, rect) {
      const ghost = pieceSpan(p, "ghost");
      ghost.style.width = (rect ? rect.width : 44) + "px";
      ghost.style.height = (rect ? rect.height : 44) + "px";
      document.body.appendChild(ghost);
      const move = (x, y) => { ghost.style.left = x + "px"; ghost.style.top = y + "px"; };
      move(ev.clientX, ev.clientY);
      let done = false;
      const cleanup = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        ghost.remove();
      };
      const onMove = (e) => move(e.clientX, e.clientY);
      const onUp = (e) => {
        if (done) return;
        done = true;
        cleanup();
        const sq = sqFromPoint(e.clientX, e.clientY);
        if (sq == null) return;   // released outside the board: stay loaded
        S.squares[sq] = p;
        afterChange();
      };
      const onCancel = () => { if (!done) { done = true; cleanup(); } };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    }

    // board input: click-click, drag, trash and right-click delete
    function sqFromPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      const cell = el && el.closest ? el.closest(".sq") : null;
      return cell && boardEl.contains(cell) ? Number(cell.dataset.sq) : null;
    }

    boardEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || S.destroyed) return;
      const cell = ev.target.closest ? ev.target.closest(".sq") : null;
      if (!cell) return;
      ev.preventDefault();
      const sq = Number(cell.dataset.sq);
      if (S.trash) { startSweep(sq); return; }
      if (S.pick) { S.squares[sq] = S.pick; afterChange(); return; }
      if (S.squares[sq]) { startPieceDrag(sq, ev); return; }
      if (S.sel != null && S.sel !== sq) {
        S.squares[sq] = S.squares[S.sel];
        S.squares[S.sel] = null;
        S.sel = null;
        afterChange();
      }
    });
    // right-click deletes the piece under the cursor
    boardEl.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const cell = ev.target.closest ? ev.target.closest(".sq") : null;
      if (!cell) return;
      const sq = Number(cell.dataset.sq);
      if (S.squares[sq]) { S.squares[sq] = null; afterChange(); }
    });

    function startSweep(firstSq) {
      const wipe = (x, y) => {
        const sq = sqFromPoint(x, y);
        if (sq != null && S.squares[sq]) { S.squares[sq] = null; afterChange(); }
      };
      let done = false;
      const onMove = (e) => { if (!done) wipe(e.clientX, e.clientY); };
      const onUp = () => {
        done = true;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
      };
      const onCancel = () => { if (!done) onUp(); };
      if (S.squares[firstSq]) { S.squares[firstSq] = null; afterChange(); }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    }

    // drag a board piece around; a click without a drop selects it for
    // click-click placement
    function startPieceDrag(fromSq, ev) {
      const pieceEl = cells[fromSq].querySelector(".piece");
      const p = S.squares[fromSq];
      const ghost = pieceEl ? pieceEl.cloneNode(true) : pieceSpan(p, "ghost");
      ghost.classList.add("ghost");
      const r = pieceEl ? pieceEl.getBoundingClientRect() : null;
      if (r) { ghost.style.width = r.width + "px"; ghost.style.height = r.height + "px"; }
      document.body.appendChild(ghost);
      if (pieceEl) pieceEl.style.opacity = "0.25";
      const move = (x, y) => { ghost.style.left = x + "px"; ghost.style.top = y + "px"; };
      move(ev.clientX, ev.clientY);
      let finished = false;
      const cleanup = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        ghost.remove();
        const cur = cells[fromSq] && cells[fromSq].querySelector(".piece");
        if (cur) cur.style.opacity = "";
      };
      const onMove = (e) => move(e.clientX, e.clientY);
      const onUp = (e) => {
        if (finished) return;
        finished = true;
        cleanup();
        const sq = sqFromPoint(e.clientX, e.clientY);
        if (sq == null || sq === fromSq) { S.sel = S.sel === fromSq ? null : fromSq; redraw(); return; }
        S.squares[fromSq] = null;
        S.squares[sq] = p;
        S.sel = null;
        afterChange();
      };
      const onCancel = () => {
        if (finished) return;
        finished = true;
        cleanup();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    }

    // rules: castling availability and en passant targets
    function castleAvailable(side, kind) {
      const king = side === "w" ? "K" : "k";
      const rook = side === "w" ? "R" : "r";
      const kingSq = side === "w" ? sqFromName("e1") : sqFromName("e8");
      const rookSq = kind === "K"
        ? (side === "w" ? sqFromName("h1") : sqFromName("h8"))
        : (side === "w" ? sqFromName("a1") : sqFromName("a8"));
      return S.squares[kingSq] === king && S.squares[rookSq] === rook;
    }
    function cullRights() {
      for (const c of ["K", "Q", "k", "q"]) {
        if (S.castling[c] && !castleAvailable(c === "K" || c === "Q" ? "w" : "b", c === "K" || c === "k" ? "K" : "Q")) {
          S.castling[c] = false;
        }
      }
      if (S.ep && !epCandidates().includes(S.ep)) S.ep = null;
    }
    // every square the side to move can capture on en passant, derived
    // from pawn placement alone (a white pawn on e5 facing black pawns on
    // d5/f5 yields d6 and f6)
    function epCandidates() {
      const white = S.turn === "w";
      const myPawn = white ? "P" : "p", theirPawn = white ? "p" : "P";
      const myRank = white ? 4 : 3, destRank = white ? 5 : 2;
      const out = new Set();
      for (let f = 0; f < 8; f++) {
        if (S.squares[myRank * 8 + f] !== myPawn) continue;
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const dest = destRank * 8 + ff;
          if (S.squares[myRank * 8 + ff] === theirPawn && !S.squares[dest]) out.add(dest);
        }
      }
      return [...out].sort((a, b) => a - b).map(sqName);
    }

    // side panel: turn, castling, en passant
    function drawControls() {
      const wBtn = U.qs("#ed-turn-w", root), bBtn = U.qs("#ed-turn-b", root);
      wBtn.textContent = `♔ ${U.esc(t("editor.white"))}`;
      bBtn.textContent = `♚ ${U.esc(t("editor.black"))}`;
      wBtn.classList.toggle("active", S.turn === "w");
      bBtn.classList.toggle("active", S.turn === "b");

      const cbox = U.qs("#ed-castling", root);
      const groups = [];
      for (const side of ["w", "b"]) {
        const rights = side === "w" ? ["K", "Q"] : ["k", "q"];
        const boxes = rights.map((c) => {
          if (!castleAvailable(side, c)) return "";
          const id = "ed-cst-" + c;
          return `<label class="ed-check" for="${id}"
            title="${U.esc(t(side === "w" ? "editor.castlingW" : "editor.castlingB"))}">
            <input type="checkbox" id="${id}" data-cst="${c}" ${S.castling[c] ? "checked" : ""}>
            <span>${c === "K" || c === "k" ? "O-O" : "O-O-O"}</span></label>`;
        }).filter(Boolean).join("");
        if (boxes) groups.push(`<div class="ed-check-group"><span class="muted small">${side === "w" ? "♔" : "♚"}</span>${boxes}</div>`);
      }
      cbox.innerHTML = groups.length ? groups.join("") : `<span class="muted small">${U.esc(t("editor.castlingNone"))}</span>`;
      U.qsa("input[data-cst]", cbox).forEach(inp => inp.addEventListener("change", () => {
        S.castling[inp.dataset.cst] = inp.checked;
        afterChange();
      }));

      const epBox = U.qs("#ed-ep", root);
      const cands = epCandidates();
      const opts = [`<label class="ed-check"><input type="radio" name="ed-ep" value="" ${!S.ep ? "checked" : ""}>
        <span>${U.esc(t("editor.epNone"))}</span></label>`]
        .concat(cands.map((sq) => `<label class="ed-check"><input type="radio" name="ed-ep" value="${sq}" ${S.ep === sq ? "checked" : ""}>
          <span>${sq}</span></label>`));
      epBox.innerHTML = opts.join("");
      U.qsa("input[name=ed-ep]", epBox).forEach(inp => inp.addEventListener("change", () => {
        S.ep = inp.value || null;
        afterChange();
      }));

      U.qs("#ed-trash", root).classList.toggle("active", S.trash);
    }

    // FEN and URL fields
    function buildFen() {
      const rows = [];
      for (let r = 7; r >= 0; r--) {
        let row = "", empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = S.squares[r * 8 + f];
          if (!p) empty++;
          else { if (empty) { row += empty; empty = 0; } row += p; }
        }
        if (empty) row += empty;
        rows.push(row);
      }
      const castle = ["K", "Q", "k", "q"].filter(c => S.castling[c]).join("") || "-";
      return `${rows.join("/")} ${S.turn} ${castle} ${S.ep || "-"} ${S.halfmove} ${S.fullmove}`;
    }
    function parseFen(fen) {
      const f = String(fen || "").trim().split(/\s+/);
      if (f.length !== 6) return false;
      const rows = f[0].split("/");
      if (rows.length !== 8) return false;
      for (const row of rows) {
        let sum = 0, prevNum = false;
        for (const ch of row) {
          if (ch >= "1" && ch <= "8") {
            if (prevNum) return false;
            prevNum = true;
            sum += Number(ch);
          } else {
            if (!"pnbrqkPNBRQK".includes(ch)) return false;
            prevNum = false;
            sum++;
          }
        }
        if (sum !== 8) return false;
      }
      if (!/^(w|b)$/.test(f[1])) return false;
      if (/[^KQkq-]/.test(f[2]) || (f[2].includes("-") && f[2].length > 1)) return false;
      if (!/^(-|[a-h][36])$/.test(f[3])) return false;
      if (!/^\d+$/.test(f[4]) || !/^\d+$/.test(f[5]) || Number(f[5]) < 1) return false;
      return true;
    }
    function loadFen(fen) {
      const f = fen.trim().split(/\s+/);
      S.squares = new Array(64).fill(null);
      const rows = f[0].split("/");
      for (let r = 0; r < 8; r++) {
        let file = 0;
        for (const ch of rows[r]) {
          if (ch >= "1" && ch <= "8") file += Number(ch);
          else S.squares[(7 - r) * 8 + file++] = ch;
        }
      }
      S.turn = f[1];
      S.castling = { K: false, Q: false, k: false, q: false };
      if (f[2] !== "-") for (const c of f[2]) S.castling[c] = true;
      S.ep = f[3] === "-" ? null : f[3];
      S.halfmove = Number(f[4]);
      S.fullmove = Number(f[5]);
      S.pick = null;
      S.sel = null;
    }
    const fenInput = U.qs("#ed-fen", root);
    const urlInput = U.qs("#ed-url", root);
    function currentUrl() {
      return `${location.origin}${App.base}editor/${buildFen().replace(/ /g, "_")}`;
    }
    function drawFields() {
      const fen = buildFen();
      if (document.activeElement !== fenInput) fenInput.value = fen;
      urlInput.value = currentUrl();
    }

    // an edited or pasted FEN rebuilds the editor position after Enter
    // (or as soon as the typed text is a complete valid FEN)
    autoApplyField(fenInput, {
      validate: (v) => parseFen(v) ? v : null,
      apply: (v) => { loadFen(v); afterChange(); return true; }
    });

    U.qsa(".an-copy", root).forEach(b => b.addEventListener("click", () => {
      if (b.dataset.copy === "fen") Exporter.copyText(fenInput.value || buildFen());
      else Exporter.copyText(currentUrl());
    }));

    // flip, start position, clear board and analyze buttons
    U.qs("#ed-flip", root).addEventListener("click", () => { S.flipped = !S.flipped; buildBoard(); redraw(); });
    U.qs("#ed-start", root).addEventListener("click", () => { loadFen(START_FEN); afterChange(); });
    U.qs("#ed-clear", root).addEventListener("click", () => {
      loadFen("8/8/8/8/8/8/8/8 w - - 0 1");
      afterChange();
    });
    U.qs("#ed-trash", root).addEventListener("click", () => { S.trash = !S.trash; S.pick = null; S.sel = null; redraw(); });
    U.qs("#ed-turn-w", root).addEventListener("click", () => { S.turn = "w"; afterChange(); });
    U.qs("#ed-turn-b", root).addEventListener("click", () => { S.turn = "b"; afterChange(); });
    U.qs("#ed-analyze", root).addEventListener("click", () => {
      App.go("/analysis?fen=" + encodeURIComponent(buildFen()));
    });

    function afterChange() {
      redraw();
    }

    buildBoard();
    redraw();

    return function cleanup() {
      S.destroyed = true;
    };
  };

  window.EditorPage = { render: EditorPage_render };
})();
