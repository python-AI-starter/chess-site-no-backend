// Chessboard: rendering plus click-click and drag&drop input.
// Squares are indexed a1=0 ... h8=63, matching the PL/pgSQL engine.
// Pieces use the cburnett set (js/pieces.js, inline SVG).
// Premoves: while it is the opponent's turn a move can be staged on any
// square; it is sent automatically once the opponent moves. Cancel by
// clicking the premove, the Cancel button, or right-clicking the board.
// Arrows: right-drag green, Ctrl/Shift right-drag red, Alt right-drag
// blue; left-click clears them all and redrawing the same arrow removes it.
// Touch devices: touch-action:none plus pointercancel handling keep
// drag-and-drop working without page scrolling.
(function () {
  "use strict";

  const FILES = "abcdefgh";

  // arrow colors (Lichess palette)
  const ARROW_COLORS = {
    green: "#15781b",
    red: "#882020",
    blue: "#003088"
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  function fenToSquares(fen) {
    // 64-slot array: index = square, value 'P'|'p'|...|null
    const arr = new Array(64).fill(null);
    const rows = fen.split(" ")[0].split("/");
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= "1" && ch <= "8") f += Number(ch);
        else { arr[(7 - r) * 8 + f] = ch; f++; }
      }
    }
    return arr;
  }

  function sqName(sq) { return FILES[sq & 7] + ((sq >> 3) + 1); }
  function sqFromName(n) { return FILES.indexOf(n[0]) + 8 * (Number(n[1]) - 1); }

  class ChessBoard {
    /**
     * opts: {
     *   onMove(fromName, toName, promoChar|null),
     *   onPremove(fromName, toName, promoChar|null),  move staged before the opponent replies
     *   canMove(): boolean               whether the player may move now
     *   canPremove(): boolean            whether a premove may be staged
     *   myColor(): 'white'|'black'|null  color of the interacting side
     * }
     */
    constructor(container, opts) {
      this.root = container;
      this.opts = opts || {};
      this.orientation = "white";
      this.squares = new Array(64).fill(null);
      this.legalMoves = [];          // UCI strings
      this.selected = null;          // sq index
      this.lastMove = null;          // [fromSq, toSq]
      this.checkSq = null;
      this.interactive = false;
      this.premove = null;           // { from, to, promo } square indexes
      this.arrows = [];              // drawn arrows [{from, to, color}]
      this._rmbDrag = null;          // {from, color} right-button drag in progress
      this._rmbPreview = null;
      this._promo = null;
      this._premoving = false;       // premove selection mode (no legal targets)
      this._build();
      this._bindPointer();
    }

    _build() {
      this.root.classList.add("board");
      this.root.innerHTML = "";
      this.cells = new Array(64);
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const sq = this._sqAt(row, col);
          const dark = ((sq >> 3) + (sq & 7)) % 2 === 0;
          const d = document.createElement("div");
          d.className = `sq ${dark ? "dark" : "light"}`;
          d.dataset.sq = sq;
          // coordinates
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
          this.cells[sq] = d;
          this.root.appendChild(d);
        }
      }
      // SVG layer for arrows; above pieces, never captures clicks
      this._arrowSvg = document.createElementNS(SVG_NS, "svg");
      this._arrowSvg.setAttribute("class", "arrows");
      this._arrowSvg.setAttribute("viewBox", "0 0 8 8");
      this._arrowSvg.setAttribute("preserveAspectRatio", "none");
      this.root.appendChild(this._arrowSvg);
    }

    _sqAt(row, col) {
      // row 0 is the top rank
      if (this.orientation === "white") return (7 - row) * 8 + col;
      return row * 8 + (7 - col);
    }

    _sqRowCol(sq) {
      if (this.orientation === "white") return { row: 7 - (sq >> 3), col: sq & 7 };
      return { row: sq >> 3, col: 7 - (sq & 7) };
    }

    setOrientation(o) {
      if (o !== this.orientation) {
        this.orientation = o;
        this._build();
        this.render();
      }
    }
    flip() { this.setOrientation(this.orientation === "white" ? "black" : "white"); }

    setMoves(list) {
      this.legalMoves = list || [];
      this._clearSelection();
      // keep the premove; it lives until the next game state
      this.render();
    }
    setInteractive(v) { this.interactive = !!v; if (!v) this._clearSelection(); this.render(); }

    setPremove(p) {
      // p: {from:'e2', to:'e4', promo:'q'|null} | null
      this.premove = p ? { from: sqFromName(p.from), to: sqFromName(p.to), promo: p.promo || null } : null;
      this._clearSelection();
      this.render();
    }

    setPosition(fen, marks) {
      this.squares = fenToSquares(fen);
      this.lastMove = marks && marks.lastMove ? marks.lastMove.map(sqFromName) : null;
      this.checkSq = marks && marks.checkSq != null ? sqFromName(marks.checkSq) : null;
      this._clearSelection();
      this.render();
    }

    _clearSelection() {
      this.selected = null;
      this._targets = null;
      this._premoving = false;
      this._hidePromo();
    }

    _targetsFor(fromSq) {
      // { toSq: [uci...] }
      const from = sqName(fromSq);
      const map = {};
      for (const m of this.legalMoves) {
        if (m.startsWith(from) && m.length >= 4) {
          const to = sqFromName(m.slice(2, 4));
          (map[to] = map[to] || []).push(m);
        }
      }
      return map;
    }

    _pieceColorAt(sq) {
      const p = this.squares[sq];
      if (!p) return null;
      return p === p.toUpperCase() ? "white" : "black";
    }

    render() {
      for (let sq = 0; sq < 64; sq++) {
        const d = this.cells[sq];
        // clear everything except coordinates
        for (const c of Array.from(d.children)) {
          if (!c.classList.contains("coord")) c.remove();
        }
        d.classList.toggle("sel", this.selected === sq);
        d.classList.toggle("last-from", !!this.lastMove && this.lastMove[0] === sq);
        d.classList.toggle("last-to", !!this.lastMove && this.lastMove[1] === sq);
        d.classList.toggle("check", this.checkSq === sq);
        d.classList.toggle("premove-from", !!this.premove && this.premove.from === sq);
        d.classList.toggle("premove-to", !!this.premove && this.premove.to === sq);
        const p = this.squares[sq];
        if (p) {
          const s = document.createElement("span");
          const white = p === p.toUpperCase();
          s.className = `piece ${white ? "w" : "b"}`;
          s.innerHTML = window.pieceSvg ? window.pieceSvg(p) : "";
          d.appendChild(s);
        }
        if (this.selected != null && this._targets && this._targets[sq]) {
          const isCap = !!this.squares[sq];
          const m = document.createElement("span");
          m.className = isCap ? "hint cap" : "hint dot";
          d.appendChild(m);
        }
      }
      this._renderArrows();
    }

    // right-button arrows
    _arrowPoints(fromSq, toSq) {
      const A = this._sqRowCol(fromSq), B = this._sqRowCol(toSq);
      const ax = A.col + 0.5, ay = A.row + 0.5, bx = B.col + 0.5, by = B.row + 0.5;
      let dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const px = -dy, py = dx;                       // perpendicular
      const tail = 0.34, headLen = 0.46, w = 0.13, W = 0.30;
      const sx = ax + dx * tail,     sy = ay + dy * tail;       // shaft start
      const bx2 = bx - dx * headLen, by2 = by - dy * headLen;   // arrowhead base
      const tx = bx - dx * 0.10,     ty = by - dy * 0.10;       // tip
      const pts = [
        [sx + px * w,  sy + py * w],
        [bx2 + px * w, by2 + py * w],
        [bx2 + px * W, by2 + py * W],
        [tx, ty],
        [bx2 - px * W, by2 - py * W],
        [bx2 - px * w, by2 - py * w]
      ];
      return pts.map(p => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" ");
    }

    _renderArrows() {
      const svg = this._arrowSvg;
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const draw = (a, preview) => {
        if (a.from === a.to) return;
        const g = document.createElementNS(SVG_NS, "polygon");
        g.setAttribute("points", this._arrowPoints(a.from, a.to));
        g.setAttribute("fill", ARROW_COLORS[a.color] || ARROW_COLORS.green);
        g.setAttribute("fill-opacity", preview ? "0.45" : "0.8");
        svg.appendChild(g);
      };
      for (const a of this.arrows) draw(a, false);
      if (this._rmbPreview && this._rmbPreview.from !== this._rmbPreview.to)
        draw(this._rmbPreview, true);
    }

    _sqFromPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      const cell = el && el.closest ? el.closest(".sq") : null;
      return cell ? Number(cell.dataset.sq) : null;
    }

    _startRmb() {
      const onMove = (e) => {
        if (!this._rmbDrag) return;
        const sq = this._sqFromPoint(e.clientX, e.clientY);
        this._rmbPreview = sq == null ? null : { from: this._rmbDrag.from, to: sq, color: this._rmbDrag.color };
        this._renderArrows();
      };
      const onUp = (e) => {
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointermove", onMove);
        const drag = this._rmbDrag;
        this._rmbDrag = null;
        this._rmbPreview = null;
        if (!drag) { this._renderArrows(); return; }
        const to = this._sqFromPoint(e.clientX, e.clientY);
        if (to == null || to === drag.from) { this._renderArrows(); return; } // bare right-click draws nothing
        const i = this.arrows.findIndex(a => a.from === drag.from && a.to === to && a.color === drag.color);
        if (i >= 0) this.arrows.splice(i, 1);      // same arrow again: remove it
        else this.arrows.push({ from: drag.from, to, color: drag.color });
        this._renderArrows();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    // selection and interaction
    _onDown(sq, ev) {
      if (this._promo) return;
      const myColor = this.opts.myColor ? this.opts.myColor() : null;
      const canMove = this.interactive && this.opts.canMove && this.opts.canMove();

      if (canMove) {
        const targets = this.selected != null ? this._targets : {};
        if (this.selected != null && targets[sq]) {
          this._attemptMove(this.selected, sq, false);
          return;
        }
        const color = this._pieceColorAt(sq);
        if (color && color === myColor && (this.legalMoves || []).length) {
          const t = this._targetsFor(sq);
          if (Object.keys(t).length) {
            this.selected = sq;
            this._targets = t;
            this.render();
            this._startDrag(sq, ev, false);
            return;
          }
        }
        this._clearSelection();
        this.render();
        return;
      }

      // premove: not my turn yet but the game is running
      if (!this.opts.canPremove || !this.opts.canPremove()) return;

      // clicking the staged premove cancels it
      if (this.premove && (sq === this.premove.from || sq === this.premove.to)) {
        this.premove = null;
        this._clearSelection();
        if (this.opts.onPremoveCancel) this.opts.onPremoveCancel();
        this.render();
        return;
      }

      // clicking the selected piece again clears selection
      if (this._premoving && this.selected === sq) {
        this._clearSelection();
        this.render();
        return;
      }

      // clicking an own piece starts premove selection
      const color = this._pieceColorAt(sq);
      if ((!this._premoving || this.selected == null) && color && color === myColor) {
        this.selected = sq;
        this._targets = null;
        this._premoving = true;
        this.render();
        this._startDrag(sq, ev, true);
        return;
      }

      // selection active plus a click on any other square stages a premove.
      // No legality or ownership checks: empty, enemy, or own squares all
      // behave the same, and drag matches click-click. The server is the
      // final judge and rejects illegal premoves.
      if (this._premoving && this.selected != null && sq !== this.selected) {
        this._attemptMove(this.selected, sq, true);
        return;
      }
      this._clearSelection();
      this.render();
    }

    _attemptMove(fromSq, toSq, isPremove) {
      let variants = null;
      if (!isPremove) {
        variants = (this._targets && this._targets[toSq]) || [];
        if (!variants.length) return;
      }
      // promotion: own pawn heading to the last rank
      const p = this.squares[fromSq];
      const isPawn = p === "P" || p === "p";
      const lastRank = isPawn ? toSq >> 3 : -1;
      const promoRank = (p === "P") ? 7 : (p === "p") ? 0 : -1;
      if (isPawn && lastRank === promoRank) {
        this._showPromo(fromSq, toSq, isPremove);
        return;
      }
      this._clearSelection();
      this.render();
      const from = sqName(fromSq), to = sqName(toSq);
      if (isPremove) this.opts.onPremove(from, to, null);
      else this.opts.onMove(from, to, null);
    }

    _showPromo(fromSq, toSq, isPremove) {
      this._hidePromo();
      const root = this.root;
      const wrap = document.createElement("div");
      wrap.className = "promo-wrap";
      const letters = ["q", "r", "b", "n"];
      const white = (this.opts.myColor() === "white");
      for (const l of letters) {
        const b = document.createElement("button");
        b.className = "promo-btn";
        const fenLetter = white ? l.toUpperCase() : l;
        b.innerHTML = `<span class="piece ${white ? "w" : "b"}">${window.pieceSvg ? window.pieceSvg(fenLetter) : ""}</span>`;
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this._hidePromo();
          this._clearSelection();
          this.render();
          if (isPremove) this.opts.onPremove(sqName(fromSq), sqName(toSq), l);
          else this.opts.onMove(sqName(fromSq), sqName(toSq), l);
        });
        wrap.appendChild(b);
      }
      this._promo = wrap;
      root.appendChild(wrap);
      // position beside the promotion square
      const cell = this.cells[toSq].getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const vertical = white
        ? (cell.top - rootRect.top)
        : (rootRect.bottom - cell.bottom - cell.height * 4);
      wrap.style.top = Math.max(0, vertical) + "px";
      wrap.style.left = (cell.left - rootRect.left) + "px";
    }
    _hidePromo() {
      if (this._promo) { this._promo.remove(); this._promo = null; }
    }

    _startDrag(fromSq, ev, isPremove) {
      const pieceEl = this.cells[fromSq].querySelector(".piece");
      if (!pieceEl) return;
      const ghost = pieceEl.cloneNode(true);
      ghost.className = "piece ghost";
      const r = pieceEl.getBoundingClientRect();
      ghost.style.width = r.width + "px";
      ghost.style.height = r.height + "px";
      document.body.appendChild(ghost);
      const move = (x, y) => {
        ghost.style.left = x + "px";
        ghost.style.top = y + "px";
      };
      move(ev.clientX, ev.clientY);
      pieceEl.style.opacity = "0.25";

      let finished = false;
      const cleanup = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        ghost.remove();
      };
      const onMove = (e) => move(e.clientX, e.clientY);
      const onUp = (e) => {
        if (finished) return;
        finished = true;
        cleanup();
        // the piece element may have been rebuilt mid-drag; reset opacity on the current one
        const cur = this.cells[fromSq] && this.cells[fromSq].querySelector(".piece");
        if (cur) cur.style.opacity = "";
        const sq = this._sqFromPoint(e.clientX, e.clientY);
        if (sq == null) { this._clearSelection(); this.render(); return; }
        if (sq === fromSq) return;           // click without drop: stay selected
        if (isPremove) {
          // premove: any square, no legality checks, same as click-click
          this._attemptMove(fromSq, sq, true);
          return;
        }
        if (this._targets && this._targets[sq]) {
          this._attemptMove(fromSq, sq, false);
          return;
        }
        this._clearSelection();
        this.render();
      };
      // touch browsers may abort the gesture: remove the ghost and keep the board consistent
      const onCancel = () => {
        if (finished) return;
        finished = true;
        cleanup();
        const cur = this.cells[fromSq] && this.cells[fromSq].querySelector(".piece");
        if (cur) cur.style.opacity = "";
        this._clearSelection();
        this.render();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    }

    _bindPointer() {
      this.root.addEventListener("pointerdown", (ev) => {
        const cell = ev.target.closest ? ev.target.closest(".sq") : null;
        if (!cell) return;
        if (ev.button === 2) {
          // right button draws arrows (green, Ctrl/Shift red, Alt blue); a bare right-click still cancels a premove
          ev.preventDefault();
          this._rmbDrag = {
            from: Number(cell.dataset.sq),
            color: (ev.ctrlKey || ev.shiftKey) ? "red" : (ev.altKey ? "blue" : "green")
          };
          if (this.premove) {
            this.premove = null;
            this._clearSelection();
            if (this.opts.onPremoveCancel) this.opts.onPremoveCancel();
            this.render();
          }
          this._startRmb();
          return;
        }
        if (ev.button !== 0) return;
        ev.preventDefault();
        // left click anywhere clears all arrows
        if (this.arrows.length) { this.arrows = []; this._renderArrows(); }
        this._onDown(Number(cell.dataset.sq), ev);
      });
      // suppress the context menu: the right button is reserved for arrows and premoves
      this.root.addEventListener("contextmenu", (ev) => ev.preventDefault());
    }

    destroy() {
      this.root.innerHTML = "";
      this.root.classList.remove("board");
    }
  }

  window.ChessBoard = ChessBoard;
})();
