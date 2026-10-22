// Game replay: step through moves using the FEN list, with control
// buttons, a clickable move list, and keyboard arrows.
(function () {
  "use strict";

  class ChessReplay {
    // opts: { replay: {ok,start_fen,fens,moves}, orientation?, keyboard? }
    constructor(container, opts) {
      this.root = container;
      this.data = opts.replay;
      this.total = (this.data.fens || []).length;
      this.ply = this.total;              // start at the final position
      this._timer = null;

      this.root.innerHTML = `
        <div class="replay-board"><div class="board-slot"></div></div>
        <div class="replay-bar">
          <button class="btn ghost small" data-rp="first" title="${U.esc(I18n.t("rp.first"))}">|&#9664;</button>
          <button class="btn ghost small" data-rp="prev" title="${U.esc(I18n.t("rp.prev"))}">&#9664;</button>
          <button class="btn ghost small replay-autoplay" data-rp="play" title="${U.esc(I18n.t("rp.autoTitle"))}">${U.esc(I18n.t("game.auto"))}</button>
          <button class="btn ghost small" data-rp="next" title="${U.esc(I18n.t("rp.next"))}">&#9654;</button>
          <button class="btn ghost small" data-rp="last" title="${U.esc(I18n.t("rp.last"))}">&#9654;|</button>
          <span class="muted small" data-rp="pos"></span>
        </div>
        <div class="moves-list rp-moves"><table></table></div>`;

      this.board = new ChessBoard(U.qs(".board-slot", this.root), {
        canMove: () => false, myColor: () => null
      });
      if (opts.orientation) this.board.setOrientation(opts.orientation);

      U.qsa("[data-rp]", this.root).forEach(b => {
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

      // clickable move list
      const mv = this.data.moves || [];
      const rows = [];
      for (let i = 0; i < mv.length; i += 2) {
        rows.push(`<tr>
          <td class="num">${i / 2 + 1}.</td>
          <td><a href="javascript:void(0)" data-ply="${i + 1}">${U.esc(mv[i].s)}</a></td>
          <td>${mv[i + 1] ? `<a href="javascript:void(0)" data-ply="${i + 2}">${U.esc(mv[i + 1].s)}</a>` : ""}</td>
        </tr>`);
      }
      const tbl = U.qs(".rp-moves table", this.root);
      tbl.innerHTML = rows.join("") || `<tr><td class="muted">${U.esc(I18n.t("rp.noMoves"))}</td></tr>`;
      U.qsa("a[data-ply]", tbl).forEach(a =>
        a.addEventListener("click", () => this.goto(Number(a.dataset.ply))));

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
      const btn = U.qs('[data-rp="play"]', this.root);
      if (btn) { btn.innerHTML = U.esc(I18n.t("game.pause")); btn.title = I18n.t("rp.stopTitle"); }
      this.render(); // show the start position immediately when ply=0
      this._timer = setInterval(() => {
        if (this.ply >= this.total) { this.stopPlay(); return; }
        this.goto(this.ply + 1, true); // keep the timer running
      }, 750);
    }
    stopPlay() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      const btn = U.qs('[data-rp="play"]', this.root);
      if (btn) { btn.innerHTML = U.esc(I18n.t("game.auto")); btn.title = I18n.t("rp.autoTitle"); }
    }

    render() {
      const u = this.uciAt(this.ply);
      this.board.setPosition(this.fenAt(this.ply), {
        lastMove: u ? [u.slice(0, 2), u.slice(2, 4)] : null
      });
      const pos = U.qs('[data-rp="pos"]', this.root);
      if (pos) pos.textContent = this.total ? `${this.ply} / ${this.total}` : "";
      U.qsa(".rp-moves td", this.root).forEach(td => td.classList.remove("cur"));
      if (this.ply > 0) {
        const idx = Math.floor((this.ply - 1) / 2) * 3 + (this.ply % 2 === 1 ? 1 : 2);
        const tds = U.qsa(".rp-moves td", this.root);
        if (tds[idx]) {
          tds[idx].classList.add("cur");
          // keep the current move visible while scrolling the list
          if (tds[idx].scrollIntoView) {
            tds[idx].scrollIntoView({ block: "nearest" });
          }
        }
      }
    }

    destroy() {
      this.stopPlay();
      if (this._key) document.removeEventListener("keydown", this._key);
      this.root.innerHTML = "";
    }
  }

  window.ChessReplay = ChessReplay;
})();
