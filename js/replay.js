// Game replay: step through moves using the FEN list, with control
// buttons, a clickable move list, and keyboard arrows. The whole widget
// renders into the container by default, or into separately provided
// mount points (opts.mount) when the host page builds its own layout.
(function () {
  "use strict";

  class ChessReplay {
    // opts: { replay: {ok,start_fen,fens,moves}, orientation?, keyboard?,
    //         mount?: {board, nav, moves}, onChange?(ply) }
    // onChange fires on every position change
    constructor(container, opts) {
      this.root = container;
      this.opts = opts || {};
      this.data = opts.replay;
      this.total = (this.data.fens || []).length;
      this.ply = this.total;              // start at the final position
      this._timer = null;

      const m = this.opts.mount;
      this.board = new ChessBoard(m && m.board ? m.board : this._mountBoard(), {
        canMove: () => false, myColor: () => null
      });
      if (opts.orientation) this.board.setOrientation(opts.orientation);

      this._buildNav(m && m.nav ? m.nav : this._mountNav());
      this._buildMoves(m && m.moves ? m.moves : this._mountMoves());

      if (opts.keyboard) {
        this._key = (e) => {
          if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
          if (e.key === "ArrowLeft") { this.goto(this.ply - 1); e.preventDefault(); }
          else if (e.key === "ArrowRight") { this.goto(this.ply + 1); e.preventDefault(); }
          else if (e.key === "Home") { this.goto(0); e.preventDefault(); }
          else if (e.key === "End") { this.goto(this.total); e.preventDefault(); }
        };
        document.addEventListener("keydown", this._key);
      }
      this.render();
    }

    // default one-piece layout used when no mount points are provided
    _mountBoard() {
      this.root.innerHTML = `<div class="replay-board"><div class="board-slot"></div></div>`;
      return U.qs(".board-slot", this.root);
    }
    _mountNav() {
      const bar = document.createElement("div");
      bar.className = "replay-bar";
      this.root.appendChild(bar);
      return bar;
    }
    _mountMoves() {
      const box = document.createElement("div");
      box.className = "moves-list rp-moves";
      this.root.appendChild(box);
      return box;
    }

    _buildNav(bar) {
      this._nav = bar;
      bar.innerHTML = `
        <button class="btn ghost small" data-rp="first" title="${U.esc(I18n.t("rp.first"))}">|&#9664;</button>
        <button class="btn ghost small" data-rp="prev" title="${U.esc(I18n.t("rp.prev"))}">&#9664;</button>
        <button class="btn ghost small replay-autoplay" data-rp="play" title="${U.esc(I18n.t("rp.autoTitle"))}">${U.esc(I18n.t("game.auto"))}</button>
        <button class="btn ghost small" data-rp="next" title="${U.esc(I18n.t("rp.next"))}">&#9654;</button>
        <button class="btn ghost small" data-rp="last" title="${U.esc(I18n.t("rp.last"))}">&#9654;|</button>
        <span class="muted small" data-rp="pos"></span>`;
      U.qsa("[data-rp]", bar).forEach(b => {
        if (b.tagName !== "BUTTON") return;
        b.addEventListener("click", () => {
          const a = b.dataset.rp;
          if (a === "first") this.goto(0);
          else if (a === "prev") this.goto(this.ply - 1);
          else if (a === "next") this.goto(this.ply + 1);
          else if (a === "last") this.goto(this.total);
          else if (a === "play") this.togglePlay();
        });
      });
    }

    _buildMoves(box) {
      this._moves = box;
      const mv = this.data.moves || [];
      const rows = [];
      for (let i = 0; i < mv.length; i += 2) {
        rows.push(`<tr>
          <td class="num">${i / 2 + 1}.</td>
          <td><a href="javascript:void(0)" data-ply="${i + 1}">${U.esc(mv[i].s)}</a></td>
          <td>${mv[i + 1] ? `<a href="javascript:void(0)" data-ply="${i + 2}">${U.esc(mv[i + 1].s)}</a>` : ""}</td>
        </tr>`);
      }
      box.innerHTML = `<table>${rows.join("") || `<tr><td class="muted">${U.esc(I18n.t("rp.noMoves"))}</td></tr>`}</table>`;
      U.qsa("a[data-ply]", box).forEach(a =>
        a.addEventListener("click", () => this.goto(Number(a.dataset.ply))));
    }

    fenAt(ply) { return ply <= 0 ? this.data.start_fen : this.data.fens[ply - 1]; }
    uciAt(ply) {
      const mv = this.data.moves || [];
      return ply > 0 && ply <= mv.length ? mv[ply - 1].u : null;
    }

    goto(ply, keepPlay) {
      // keepPlay=true means the autoplay itself is navigating: keep the timer
      if (!keepPlay) this.stopPlay();
      this.ply = Math.max(0, Math.min(this.total, ply));
      this.render();
    }
    togglePlay() {
      if (this._timer) { this.stopPlay(); return; }
      if (this.ply >= this.total) this.ply = 0;
      const btn = U.qs('[data-rp="play"]', this._nav);
      if (btn) { btn.innerHTML = U.esc(I18n.t("game.pause")); btn.title = I18n.t("rp.stopTitle"); }
      this.render(); // show the start position immediately when ply=0
      this._timer = setInterval(() => {
        if (this.ply >= this.total) { this.stopPlay(); return; }
        this.goto(this.ply + 1, true); // keep the timer running
      }, 750);
    }
    stopPlay() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      const btn = this._nav && U.qs('[data-rp="play"]', this._nav);
      if (btn) { btn.innerHTML = U.esc(I18n.t("game.auto")); btn.title = I18n.t("rp.autoTitle"); }
    }

    render() {
      const u = this.uciAt(this.ply);
      this.board.setPosition(this.fenAt(this.ply), {
        lastMove: u ? [u.slice(0, 2), u.slice(2, 4)] : null
      });
      const pos = U.qs('[data-rp="pos"]', this._nav);
      if (pos) pos.textContent = this.total ? `${this.ply} / ${this.total}` : "";
      U.qsa("td", this._moves).forEach(td => td.classList.remove("cur"));
      if (this.ply > 0) {
        const idx = Math.floor((this.ply - 1) / 2) * 3 + (this.ply % 2 === 1 ? 1 : 2);
        const tds = U.qsa("td", this._moves);
        if (tds[idx]) {
          tds[idx].classList.add("cur");
          // keep the current move visible while scrolling the list
          if (tds[idx].scrollIntoView) {
            tds[idx].scrollIntoView({ block: "nearest" });
          }
        }
      }
      if (this.opts.onChange) { try { this.opts.onChange(this.ply); } catch (e) {} }
    }

    destroy() {
      this.stopPlay();
      if (this._key) document.removeEventListener("keydown", this._key);
      this.root.innerHTML = "";
    }
  }

  window.ChessReplay = ChessReplay;
})();
