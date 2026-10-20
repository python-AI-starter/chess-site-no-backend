// ============================================================
//  Шахматная доска: отрисовка + click-click и drag&drop.
//  Поле a1=0 ... h8=63 (как в движке на PL/pgSQL).
//  Фигуры — векторный набор cburnett (js/pieces.js, инлайн SVG).
//  Премув: пока ход соперника, можно «зарядить» свой ход — он
//  отправится автоматически, как только придёт ход соперника.
// ============================================================
(function () {
  "use strict";

  const FILES = "abcdefgh";

  function fenToSquares(fen) {
    // 64-элементный массив: индекс = sq, значение 'P'|'p'|...|null
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
     *   onPremove(fromName, toName, promoChar|null),  — ход «в уме», до хода соперника
     *   canMove(): boolean               — можно ли ходить сейчас (мой ход)
     *   canPremove(): boolean            — можно ли ставить премув (партия активна, я участник)
     *   myColor(): 'white'|'black'|null  — цвет взаимодействующей стороны
     * }
     */
    constructor(container, opts) {
      this.root = container;
      this.opts = opts || {};
      this.orientation = "white";
      this.squares = new Array(64).fill(null);
      this.legalMoves = [];          // uci строки
      this.selected = null;          // sq index
      this.lastMove = null;          // [fromSq, toSq]
      this.checkSq = null;
      this.interactive = false;
      this.premove = null;           // { from, to, promo } — sq-индексы
      this._promo = null;
      this._premoving = false;       // выбор премува (вместо легальных целей)
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
          // координаты
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
    }

    _sqAt(row, col) {
      // row 0 — верхняя горизонталь
      if (this.orientation === "white") return (7 - row) * 8 + col;
      return row * 8 + (7 - col);
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
      // премув не трогаем — он живёт до нового состояния партии
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
        // очистить содержимое кроме координат
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
    }

    // ---------- выбор и взаимодействие ----------
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

      // ---------- ПРЕМУВ: ход ещё не мой, но партия идёт ----------
      if (!this.opts.canPremove || !this.opts.canPremove()) return;

      // клик по своему премуву = отмена
      if (this.premove && (sq === this.premove.from || sq === this.premove.to)) {
        this.premove = null;
        this._clearSelection();
        if (this.opts.onPremoveCancel) this.opts.onPremoveCancel();
        this.render();
        return;
      }
      // клик по фигуре моего цвета — выбор для премува (цели любые)
      const color = this._pieceColorAt(sq);
      if (color && color === myColor) {
        this.selected = sq;
        this._targets = null;
        this._premoving = true;
        this.render();
        this._startDrag(sq, ev, true);
        return;
      }
      // клик по другой клетке при выбранной фигуре — премув на неё
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
      // превращение? пешка моего цвета идёт на последнюю горизонталь
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
      // разместить у поля превращения
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

      const onMove = (e) => move(e.clientX, e.clientY);
      const onUp = (e) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        ghost.remove();
        pieceEl.style.opacity = "";
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el && el.closest ? el.closest(".sq") : null;
        if (cell) {
          const sq = Number(cell.dataset.sq);
          if (!isPremove && sq !== fromSq && this._targets && this._targets[sq]) {
            this._attemptMove(fromSq, sq, false);
          } else if (isPremove && sq !== fromSq) {
            this._attemptMove(fromSq, sq, true);
          } else if (sq === fromSq) {
            // остаёмся выбранными (click-click)
          } else {
            this._clearSelection();
            this.render();
          }
        } else {
          this._clearSelection();
          this.render();
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    _bindPointer() {
      this.root.addEventListener("pointerdown", (ev) => {
        const cell = ev.target.closest ? ev.target.closest(".sq") : null;
        if (!cell) return;
        ev.preventDefault();
        this._onDown(Number(cell.dataset.sq), ev);
      });
    }

    destroy() {
      this.root.innerHTML = "";
      this.root.classList.remove("board");
    }
  }

  window.ChessBoard = ChessBoard;
})();
