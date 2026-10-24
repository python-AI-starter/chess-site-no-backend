// Game page: board, server-backed clocks, automatic flag claims,
// chat, and player actions.
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const t = (key, params) => I18n.t(key, params);
  const REASONS = {
    checkmate: "reason.checkmate",
    resign: "reason.resign",
    timeout: "reason.timeout",
    fraud: "reason.fraud",
    abandonment: "reason.abandonment",
    agreement: "reason.agreement",
    stalemate: "reason.stalemate",
    insufficient_material: "reason.insufficient_material",
    fifty_moves: "reason.fifty_moves",
    repetition: "reason.repetition",
    forfeit: "reason.forfeit",
    cheat: "reason.cheat",
    abort: "reason.abort"
  };
  const reasonText = (r) => REASONS[r] ? t(REASONS[r]) : "";
  const tcKey = (c) => ["bullet", "blitz", "rapid", "classic"].includes(c) ? c : null;

  // Local legal-move generation with the vendored chess.js 1.4.0.
  // The server remains the source of truth: it validates submitted moves
  // and decides the result. The move list only feeds the UI
  // (highlights and premoves) and is never fetched from the server.
  // Premoves are validated here too: an illegal staged move is cancelled
  // on the client and never reaches the server.
  function computeLegal(g) {
    if (!g || g.status !== "active" || !window.Chess) return [];
    try {
      const c = new window.Chess(g.fen);
      return c.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ""));
    } catch (e) { return []; }
  }

  const GamePage_render = async function (container, gameId) {
    let me = null;
    let myProfile = null;
    try { me = await API.user(); myProfile = me ? await API.profile(me.id) : null; } catch (e) {}

    const S = {
      g: null, legal: [], myColor: null, board: null,
      chans: [], pendingMove: false, flagClaimed: false, destroyed: false,
      stm: "w", oppDeadline: null, chatEl: null,
      chatInit: false, chatSub: false, gameSub: false,
      replay: null, replayPly: null, keyHandler: null, autoTimer: null,
      premove: null,           // { from, to, promo } staged move (square names)
      flagRetryAt: null,       // retry delay for a flag claim after not_out
      chatSeen: new Set(), lastChatTs: null,
      chatPending: [],         // optimistic messages: [{body, el}]
      rtUp: false,             // game channel websocket up: polling not needed
      stopVisible: null,
      panel: null              // engine analysis panel (finished games)
    };

    container.innerHTML = `<div class="card center"><span class="spinner"></span> ${U.esc(t("game.loading"))}</div>`;

    // state application
    function derive(g) {
      const fen = g.fen || "";
      S.stm = (fen.split(" ")[1] || "w");
      if (g.status === "active" && S.stm) {
        const lastMs = U.parseTs(g.last_move_at);
        const stmMs = S.stm === "w" ? g.white_ms : g.black_ms;
        S.stmDeadline = lastMs + stmMs;
      } else S.stmDeadline = null;
    }

    function remaining(sideChar) {
      const g = S.g;
      if (!g) return 0;
      if (g.status !== "active") {
        return sideChar === "w" ? g.white_ms : g.black_ms;
      }
      if (sideChar === S.stm) return Math.max(0, S.stmDeadline - ServerTime.now());
      return sideChar === "w" ? g.white_ms : g.black_ms;
    }

    async function applyState(g, fromRemote) {
      if (S.destroyed) return;
      const wasOver = S.g && S.g.status !== "active" && S.g.status !== "waiting";
      const oldLen = S.g ? (S.g.moves || []).length : 0;
      S.g = g;
      S.legal = computeLegal(g);
      S.flagRetryAt = null;   // fresh state: drop the old claim delay
      S.myColor = !me ? null : (g.white === me.id ? "white" : (g.black === me.id ? "black" : null));
      derive(g);
      // game over or rollback: the staged premove is meaningless now
      if (g.status !== "active" || !S.myColor) clearPremoveState(false);
      // replay browsing: leave the board alone, refresh the move list only
      if (S.replayPly != null) { movesList(); return; }
      drawGame();

      // play the opponent move sound (own moves sound in onMove)
      const mv = g.moves || [];
      if (fromRemote && mv.length > oldLen && S.myColor) {
        const lastPlyWhite = mv.length % 2 === 1; // odd half-move count: white moved
        const oppMoved = (S.myColor === "white") ? !lastPlyWhite : lastPlyWhite;
        if (oppMoved) {
          const san = mv[mv.length - 1].s || "";
          if (/x/.test(san)) U.soundCapture(); else U.soundMove();
        }
      }

      // premove: the opponent moved, try the staged move
      tryPremove();

      // chat unlocks as soon as I am a participant of the active game
      if (me && S.myColor && !S.chatInit) initChat();

      // the game just finished: enable replay
      if ((g.status === "finished" || g.status === "aborted") && !S.replay) initReplay();

      if (!wasOver && g.status === "finished" || g.status === "aborted") {
        if (!wasOver && fromRemote) U.soundEnd();
      }
    }

    // premoves
    function setPremoveState(p) {
      S.premove = p; // { from, to, promo } | null (square names)
      S.board.setPremove(p);
      drawStatus();
    }
    function clearPremoveState(redraw) {
      if (!S.premove) return;
      S.premove = null;
      S.board.setPremove(null);
      if (redraw !== false) drawStatus();
    }
    function tryPremove() {
      const p = S.premove;
      if (!p || S.destroyed || S.pendingMove || !S.g || S.g.status !== "active") {
        if (S.g && S.g.status !== "active") clearPremoveState(false);
        return;
      }
      const myTurn = S.myColor && ((S.stm === "w") === (S.myColor === "white"));
      if (!myTurn) return;
      // client-side validation: if the staged move is illegal in the
      // position after the opponent's move, the premove is cancelled and
      // nothing is sent to the server
      if (!S.legal.includes(p.from + p.to + (p.promo || ""))) {
        clearPremoveState();   // redraw so the stale note disappears too
        return;
      }
      clearPremoveState(false);           // clear the highlight early
      onMove(p.from, p.to, p.promo, { isPremove: true });
    }
    async function onPremove(from, to, promo) {
      if (!S.myColor || !S.g || S.g.status !== "active") return;
      setPremoveState({ from, to, promo: promo || null });
      // if it is already my turn (ticker race) play immediately
      tryPremove();
    }

    async function refetch() {
      const { data, error } = await API.gameState(gameId);
      if (error) { U.toast(error.message, "error"); return; }
      await applyState(data.game, true);
    }

    // layout
    const root = U.el(`<div class="game-layout">
      <div>
        <div class="player-bar" id="pb-top"></div>
        <div class="an-board-row">
          <div class="an-eval-slot" id="game-eval-slot"></div>
          <div class="board-wrap"><div id="board"></div></div>
        </div>
        <div class="player-bar" id="pb-bottom"></div>
      </div>
      <div>
        <div class="card" id="status-card"></div>
        <div class="card hidden" id="analysis-card">
          <div id="analysis-box"></div>
        </div>
        <div class="card">
          <h3 class="spread row">${U.esc(t("game.moves"))}
            <span class="row" style="gap:6px">
              <button class="btn ghost small hidden" id="analysis-toggle" title="${U.esc(t("analysis.engineCard"))}">⚙ ${U.esc(t("analysis.engineCard"))}</button>
              <button class="btn ghost small" id="flip">${U.esc(t("game.flip"))}</button>
            </span></h3>
          <div class="moves-list" id="moves"></div>
          <div class="export-row">
            <button class="btn ghost small" id="exp-fen" title="${U.esc(t("export.fenTitle"))}">${U.esc(t("export.fenBtn"))}</button>
            <button class="btn ghost small" id="exp-pgn" title="${U.esc(t("export.pgnTitle"))}">${U.esc(t("export.pgnBtn"))}</button>
            <a class="muted small hidden" id="exp-ab-link" href="#/analysis">${U.esc(t("analysis.openBoard"))}</a>
          </div>
          <div class="replay-bar" id="replaybar" style="display:none"></div>
          <div class="game-actions" id="actions"></div>
          <div id="drawbox"></div>
        </div>
        <div class="card" id="chat-card" style="display:none">
          <h3>${U.esc(t("game.chat"))}</h3>
          <div class="chat-box">
            <div class="chat-log" id="chat-log"></div>
            <div class="chat-input">
              <input id="chat-text" maxlength="500" placeholder="${U.esc(t("chat.placeholder"))}">
              <button class="btn primary chat-send" id="chat-send" title="${U.esc(t('common.send'))}">${U.sendIcon()}</button>
            </div>
          </div>
        </div>
      </div>
    </div>`);
    container.innerHTML = "";
    container.appendChild(root);

    // FEN of the position currently shown (live board or replay position)
    function currentFen() {
      const g = S.g;
      if (!g) return "";
      if (S.replay && S.replayPly != null) {
        return S.replayPly === 0 ? S.replay.start_fen : S.replay.fens[S.replayPly - 1];
      }
      return g.fen;
    }

    U.qs("#exp-fen", root).addEventListener("click", () => {
      const fen = currentFen();
      if (fen) Exporter.exportFen(fen);
    });
    U.qs("#exp-pgn", root).addEventListener("click", () => {
      const g = S.g;
      if (!g) return;
      const clean = (id) => ((S.names && S.names[id]) || "").replace(" 🚫", "") || undefined;
      Exporter.exportPgn(g, {
        white: clean(g.white), black: clean(g.black),
        whiteElo: S.ratings ? S.ratings[g.white] : undefined,
        blackElo: S.ratings ? S.ratings[g.black] : undefined
      });
    });
    U.qs("#analysis-toggle", root).addEventListener("click", () => {
      const card = U.qs("#analysis-card", root);
      const opening = card.classList.contains("hidden");
      card.classList.toggle("hidden", !opening);
      U.qs("#analysis-toggle", root).classList.toggle("active", opening);
      if (opening) {
        if (!S.panel) {
          S.panel = new AnalysisPanel(U.qs("#analysis-box", root), {
            getFen: currentFen,
            getBoard: () => S.board,
            getBarSlot: () => U.qs("#game-eval-slot", root),
            // a game finished by the rules of chess (checkmate, stalemate,
            // ...) keeps the panel but never starts Stockfish
            isFinal: () => !!S.g && S.g.status === "finished" &&
                           App.ruleEnds.includes(S.g.reason)
          });
        }
        S.panel.sync();
      } else if (S.panel) {
        S.panel.turnOff();   // free the CPU; the engine stays cached
      }
    });

    S.board = new ChessBoard(U.qs("#board", root), {
      onMove: onMove,
      onPremove: onPremove,
      onPremoveCancel: () => { S.premove = null; drawStatus(); },
      canMove: () => S.g && S.g.status === "active" && S.myColor && !S.pendingMove &&
                     ((S.stm === "w") === (S.myColor === "white")),
      canPremove: () => S.g && S.g.status === "active" && S.myColor && !S.pendingMove &&
                        !((S.stm === "w") === (S.myColor === "white")),
      myColor: () => S.myColor
    });

    U.qs("#flip", root).addEventListener("click", () => {
      S.board.flip();
    });

    // rendering
    function playerBar(elId, color) {
      const g = S.g;
      const pid = color === "white" ? g.white : g.black;
      const box = U.qs(elId, root);
      if (!pid) { box.innerHTML = `<span class="muted">${U.esc(t("game.waitingPlayer"))}</span>`; return; }
      const name = pid === (myProfile && myProfile.id) ? (myProfile.username) : (S.names && S.names[pid]) || "…";
      const rating = pid === (myProfile && myProfile.id) ? myProfile.rating : (S.names && S.names[pid] !== undefined ? S.ratings[pid] : "");
      const turn = g.status === "active" && ((S.stm === "w") === (color === "white"));
      const ms = remaining(color === "white" ? "w" : "b");
      const low = g.status === "active" && ms < 20000;
      const gone = ms <= 0;
      box.innerHTML = `
        <span class="avatar">${U.esc((name || "?")[0].toUpperCase())}</span>
        <span class="who"><a href="#/profile/${pid}">${U.esc(name || t("game.player"))}</a>
          <span class="muted small">${rating ? "(" + rating + ")" : ""}</span></span>
        <span class="clock ${turn ? "active" : ""} ${low ? "low" : ""} ${gone ? "gone" : ""}"
              data-clock="${color}">${U.fmtClock(ms)}</span>`;
    }

    async function loadNames() {
      // fetch both player profiles (public)
      const ids = [S.g.white, S.g.black].filter(Boolean);
      if (!ids.length) return;
      const { data } = await API.sb.from("profiles").select("id,username,rating,is_banned").in("id", ids);
      S.names = {}; S.ratings = {};
      (data || []).forEach(p => { S.names[p.id] = p.username + (p.is_banned ? " 🚫" : ""); S.ratings[p.id] = p.rating; });
      drawGame();
    }

    function movesList() {
      const mv = (S.g.moves || []);
      const curPly = S.replayPly != null ? S.replayPly : mv.length;
      const rows = [];
      for (let i = 0; i < mv.length; i += 2) {
        const plyW = i + 1, plyB = i + 2;
        rows.push(`<tr><td class="num">${i / 2 + 1}.</td>
          <td data-ply="${plyW}" class="${plyW === curPly ? "cur" : ""}">${U.esc(mv[i].s)}</td>
          <td data-ply="${plyB}" class="${plyB === curPly ? "cur" : ""}">${mv[i + 1] ? U.esc(mv[i + 1].s) : ""}</td></tr>`);
      }
      U.qs("#moves", root).innerHTML = rows.length
        ? `<table>${rows.join("")}</table>`
        : `<div class="empty">${U.esc(t("game.movesEmpty"))}</div>`;
      if (S.replay) {
        U.qsa("#moves td[data-ply]", root).forEach(td =>
          td.addEventListener("click", () => seekReplay(Number(td.dataset.ply))));
      }
      const list = U.qs("#moves", root);
      if (S.replayPly == null || S.replayPly >= mv.length) list.scrollTop = list.scrollHeight;
    }

    // replay of a finished game (local, chess.js)
    function lastUci() {
      const mv = S.g.moves || [];
      return mv.length ? mv[mv.length - 1].u : null;
    }
    function buildReplayData(g) {
      // positions after each half-move are computed client-side with chess.js
      const fens = [];
      try {
        const c = new window.Chess(g.start_fen);
        for (const m of (g.moves || [])) {
          c.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4),
                   promotion: m.u.length === 5 ? m.u[4] : undefined });
          fens.push(c.fen());
        }
      } catch (e) { return { ok: false, start_fen: g.start_fen, fens: [], moves: g.moves || [] }; }
      return { ok: true, start_fen: g.start_fen, fens, moves: g.moves || [] };
    }
    function initReplay() {
      if (S.replay || !S.g || (S.g.status !== "finished" && S.g.status !== "aborted")) return;
      const data = buildReplayData(S.g);
      if (!data.ok || S.destroyed) return;
      S.replay = data;
      S.replayPly = (data.fens || []).length;
      drawReplayBar();
      movesList();
    }
    function drawReplayBar() {
      const bar = U.qs("#replaybar", root);
      bar.style.display = "";
      bar.innerHTML = `
        <button class="btn ghost small" data-rp="first" title="${U.esc(t("rp.first"))}">|&#9664;</button>
        <button class="btn ghost small" data-rp="prev" title="${U.esc(t("rp.prev"))}">&#9664;</button>
        <button class="btn ghost small replay-autoplay" data-rp="play" title="${U.esc(t("rp.autoTitle"))}">&#9654; ${U.esc(t("game.auto"))}</button>
        <button class="btn ghost small" data-rp="next" title="${U.esc(t("rp.next"))}">&#9654;</button>
        <button class="btn ghost small" data-rp="last" title="${U.esc(t("rp.last"))}">&#9654;|</button>
        <span class="muted small" id="replay-pos"></span>
        <span class="muted small">${U.esc(t("rp.hint"))}</span>`;
      U.qsa("button[data-rp]", bar).forEach(b => b.addEventListener("click", () => {
        const a = b.dataset.rp;
        if (a === "first") seekReplay(0);
        else if (a === "prev") seekReplay(S.replayPly - 1);
        else if (a === "play") toggleAutoplay();
        else if (a === "next") seekReplay(S.replayPly + 1);
        else if (a === "last") seekReplay((S.replay.fens || []).length);
      }));
      updateReplayPos();
      S.keyHandler = (e) => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
        if (e.key === "ArrowLeft") { seekReplay(S.replayPly - 1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { seekReplay(S.replayPly + 1); e.preventDefault(); }
      };
      document.addEventListener("keydown", S.keyHandler);
    }
    // autoplay, the same as the leaderboard replay: steps forward every
    // 750 ms, restarts from the start position when already at the end,
    // and stops on any manual navigation
    function stopAutoplay() {
      if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = null; }
      const btn = U.qs('[data-rp="play"]', root);
      if (btn) { btn.innerHTML = U.esc(t("game.auto")); btn.title = t("rp.autoTitle"); }
    }
    function toggleAutoplay() {
      if (S.autoTimer) { stopAutoplay(); return; }
      const total = (S.replay.fens || []).length;
      if (S.replayPly >= total) S.replayPly = 0;
      const btn = U.qs('[data-rp="play"]', root);
      if (btn) { btn.innerHTML = U.esc(t("game.pause")); btn.title = t("rp.stopTitle"); }
      seekReplay(S.replayPly, true); // show the start position immediately when ply=0
      S.autoTimer = setInterval(() => {
        if (S.replayPly >= total) { stopAutoplay(); return; }
        seekReplay(S.replayPly + 1, true); // keep the timer running
      }, 750);
    }
    function updateReplayPos() {
      const el = U.qs("#replay-pos", root);
      if (el) el.textContent = `${S.replayPly} / ${(S.replay.fens || []).length}`;
    }
    function seekReplay(ply, keepAuto) {
      if (!S.replay) return;
      if (!keepAuto) stopAutoplay(); // any manual navigation stops the autoplay
      const total = (S.replay.fens || []).length;
      S.replayPly = Math.max(0, Math.min(total, ply));
      if (S.replayPly === total) {
        S.board.setPosition(S.g.fen, { lastMove: lastUci() ? [lastUci().slice(0, 2), lastUci().slice(2, 4)] : null, checkSq: checkSquare() });
      } else {
        const u = S.replayPly > 0 ? ((S.replay.moves || [])[S.replayPly - 1] || {}).u : null;
        const fen = S.replayPly === 0 ? S.replay.start_fen : S.replay.fens[S.replayPly - 1];
        S.board.setPosition(fen, { lastMove: u ? [u.slice(0, 2), u.slice(2, 4)] : null });
      }
      S.board.setInteractive(false);
      updateReplayPos();
      movesList();
      if (S.panel && S.panel.on) S.panel.sync();   // follow the shown position
    }

    function checkSquare() {
      const mv = S.g.moves || [];
      if (!mv.length) return null;
      const san = mv[mv.length - 1].s || "";
      if (!/[+#]$/.test(san)) return null;
      // king of the side to move
      const target = S.stm === "w" ? "K" : "k";
      const rows = S.g.fen.split(" ")[0].split("/");
      for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
          if (ch >= "1" && ch <= "8") f += Number(ch);
          else { if (ch === target) return FILES[f] + (8 - r); f++; }
        }
      }
      return null;
    }
    const FILES = "abcdefgh";

    function drawGame() {
      const g = S.g;
      if (!g) return;
      const orientation = S.myColor === "black" ? "black" : "white";
      if (S.board.orientation !== orientation) S.board.setOrientation(orientation);
      const lastU = (g.moves && g.moves.length) ? g.moves[g.moves.length - 1].u : null;
      S.board.setPosition(g.fen, {
        lastMove: lastU ? [lastU.slice(0, 2), lastU.slice(2, 4)] : null,
        checkSq: checkSquare()
      });
      S.board.setMoves(S.legal);
      S.board.setInteractive(S.g.status === "active" && !!S.myColor);
      playerBar("#pb-top", orientation === "white" ? "black" : "white");
      playerBar("#pb-bottom", orientation);
      movesList();
      drawStatus();
      drawActions();
      // engine analysis and the analysis-board link exist for ended games
      const over = g.status === "finished" || g.status === "aborted";
      U.qs("#analysis-toggle", root).classList.toggle("hidden", !over);
      const abLink = U.qs("#exp-ab-link", root);
      abLink.classList.toggle("hidden", !over);
      if (over) abLink.href = "#/analysis?fen=" + encodeURIComponent(currentFen());
      if (S.panel && S.panel.on) S.panel.sync();
    }

    function drawStatus() {
      const g = S.g;
      const c = U.qs("#status-card", root);
      if (g.status === "waiting") {
        const isHost = me && (g.white === me.id || g.black === me.id);
        const link = `${location.origin}${App.base}game/${g.id}`;
        const kind = g.rated ? t("lobby.rated").toLowerCase() : t("challenge.casual").toLowerCase();
        c.innerHTML = `
          <div class="result-banner waiting">${U.esc(t("game.waitingOpponent"))}</div>
          <p class="small muted">${U.esc(t("game.control",
            { tc: U.fmtTc(g.initial_ms, g.increment_ms), kind }))}</p>
          ${isHost ? `
            <label>${U.esc(t("game.inviteLink"))}</label>
            <div class="row"><input readonly id="inv-link" value="${U.esc(link)}">
            <button class="btn" id="copy-inv">${U.esc(t("game.copy"))}</button></div>
            <div class="game-actions"><button class="btn danger" id="cancel-wait">${U.esc(t("game.cancelChallenge"))}</button></div>` : ""}
          ${!me ? `<p>${U.esc(t("game.loginToJoin"))}</p>`
                : (!S.myColor ? `<div class="game-actions">
                    <button class="btn primary big" id="join-btn">${U.esc(t("game.join"))}</button>
                  </div>` : "")}`;
        const joinBtn = U.qs("#join-btn", c);
        if (joinBtn) joinBtn.addEventListener("click", async () => {
          joinBtn.disabled = true;
          const { data, error } = await API.joinGame(g.id);
          if (error) { joinBtn.disabled = false; return U.toast(error.message, "error"); }
          if (data && data.game) await applyState(data.game, false);
        });
        if (isHost) {
          U.qs("#copy-inv", c).addEventListener("click", () => {
            navigator.clipboard && navigator.clipboard.writeText(link);
            U.toast(t("game.linkCopied"), "good");
          });
          U.qs("#cancel-wait", c).addEventListener("click", async () => {
            if (!(await U.confirmModal(t("game.cancelChallengeQ"), t("game.cancelChallengeText"), t("common.cancel")))) return;
            const { error } = await API.cancelWaiting(g.id);
            if (error) U.toast(error.message, "error"); else App.go("/");
          });
        }
        return;
      }
      if (g.status === "aborted") {
        c.innerHTML = `<div class="result-banner draw">${U.esc(t("game.aborted"))}</div>
          <p class="small muted center">${U.esc(reasonText(g.reason))}</p>`;
        return;
      }
      if (g.status === "finished") {
        let cls = "draw", txt = t("game.draw");
        if (me && g.winner) {
          if (g.winner === me.id) { cls = "win"; txt = t("game.win"); }
          else { cls = "lose"; txt = t("game.lose"); }
        } else if (g.result === "1-0") txt = t("game.whiteWins");
        else if (g.result === "0-1") txt = t("game.blackWins");
        else txt = "½–½";
        const rd = g.rating_delta || null;
        // the pool rating delta takes precedence over the global one
        const myDelta = rd && me ? (g.white === me.id ? rd.white : rd.black) : null;
        const myDeltaClass = rd && me ? (g.white === me.id ? rd.white_class : rd.black_class) : null;
        const shownDelta = myDeltaClass != null ? myDeltaClass : myDelta;
        const poolName = rd && tcKey(rd.class) ? " (" + t("tc." + rd.class) + ")" : "";
        c.innerHTML = `
          <div class="result-banner ${cls}">${U.esc(txt)}</div>
          <p class="small muted center">${U.esc(reasonText(g.reason))}
          ${g.rated && shownDelta != null && shownDelta !== 0 ?
            ` · ${t("game.ratingDelta",
                { pool: poolName, delta: shownDelta > 0 ? "+" + shownDelta : String(shownDelta) })}` : ""}</p>
          ${me && g.winner && g.winner !== me.id && g.reason === "fraud" ?
            `<p class="small center good">${U.esc(t("game.oppBannedFraud"))}</p>` : ""}`;
        return;
      }
      // active game
      const myTurn = S.myColor && ((S.stm === "w") === (S.myColor === "white"));
      const prenote = S.premove
        ? `<div class="draw-box premove-box"><span>${t("game.premoveNote",
            { move: `${U.esc(S.premove.from)}→${U.esc(S.premove.to)}${S.premove.promo ? "=" + S.premove.promo.toUpperCase() : ""}` })}
           <button class="btn ghost small" id="pm-cancel">${U.esc(t("common.cancel"))}</button></div>`
        : "";
      c.innerHTML = `<div class="center">
        ${S.pendingMove ? `<span class="spinner"></span> ${U.esc(t("game.sending"))}` :
          myTurn ? `<b>${U.esc(t("game.yourMove"))}</b>` :
          S.myColor ? `<span class="muted">${U.esc(t("game.oppTurn"))}</span>` :
          `<span class="muted">${U.esc(t("game.spectating"))}</span>`}
      </div>${prenote}`;
      const pmc = U.qs("#pm-cancel", c);
      if (pmc) pmc.addEventListener("click", () => { setPremoveState(null); });
    }

    function drawActions() {
      const g = S.g;
      const box = U.qs("#actions", root);
      const db = U.qs("#drawbox", root);
      db.innerHTML = "";
      if (g.status !== "active" || !S.myColor) { box.innerHTML = drawRematchHtml(); bindRematch(); return; }

      const oppOffer = g.draw_offer_by && me && g.draw_offer_by !== me.id;
      const myOffer = g.draw_offer_by && me && g.draw_offer_by === me.id;
      const myTb = g.takeback_by && me && g.takeback_by === me.id;
      const oppTb = g.takeback_by && me && g.takeback_by !== me.id;
      const hasMoves = (g.moves || []).length >= 1;
      const canAbort = (g.moves || []).length < 2;
      box.innerHTML = `
        <button class="btn" id="act-draw">${U.esc(t("game.actDraw"))}</button>
        <button class="btn ${(!hasMoves || oppTb || myTb) ? "hidden" : ""}" id="act-takeback">${U.esc(t("game.actTakeback"))}</button>
        <button class="btn" id="act-resign">${U.esc(t("game.actResign"))}</button>
        ${canAbort ? `<button class="btn" id="act-abort" title="${U.esc(t("game.actAbortTitle"))}">${U.esc(t("game.actAbort"))}</button>` : ""}
        <button class="btn danger hidden" id="act-flag">${U.esc(t("game.actFlag"))}</button>`;
      if (oppOffer) {
        db.innerHTML = `<div class="draw-box"><span>${U.esc(t("game.oppOffersDraw"))}</span>
          <button class="btn primary small" id="d-accept">${U.esc(t("common.accept"))}</button>
          <button class="btn ghost small" id="d-decline">${U.esc(t("common.decline"))}</button></div>`;
        U.qs("#d-accept", db).addEventListener("click", () => act(() => API.acceptDraw(S.g.id)));
        U.qs("#d-decline", db).addEventListener("click", () => act(() => API.declineDraw(S.g.id)));
      }
      if (myOffer) {
        // my pending draw offer is shown like a premove: it stays on the
        // board until the opponent answers, and I may cancel it anytime
        db.insertAdjacentHTML("beforeend", `<div class="draw-box premove-box">
          <span>${U.esc(t("game.myDrawOffer"))}</span>
          <button class="btn ghost small" id="d-cancel">${U.esc(t("common.cancel"))}</button></div>`);
        U.qs("#d-cancel", db).addEventListener("click", () => act(() => API.declineDraw(S.g.id)));
      }
      if (oppTb) {
        db.insertAdjacentHTML("beforeend", `<div class="draw-box"><span>${U.esc(t("game.oppTakeback"))}</span>
          <button class="btn primary small" id="tb-accept">${U.esc(t("common.accept"))}</button>
          <button class="btn ghost small" id="tb-decline">${U.esc(t("common.decline"))}</button></div>`);
        U.qs("#tb-accept", db).addEventListener("click", () => act(() => API.acceptTakeback(S.g.id)));
        U.qs("#tb-decline", db).addEventListener("click", () => act(() => API.declineTakeback(S.g.id)));
      } else if (myTb) {
        db.insertAdjacentHTML("beforeend", `<div class="draw-box"><span>${U.esc(t("game.myTakeback"))}</span>
          <button class="btn ghost small" id="tb-cancel">${U.esc(t("common.cancel"))}</button></div>`);
        U.qs("#tb-cancel", db).addEventListener("click", () => act(() => API.declineTakeback(S.g.id)));
      }
      U.qs("#act-draw", box).addEventListener("click", () => act(() => API.offerDraw(S.g.id)));
      const tbBtn = U.qs("#act-takeback", box);
      if (tbBtn) tbBtn.addEventListener("click", () => act(() => API.requestTakeback(S.g.id)));
      const abortBtn = U.qs("#act-abort", box);
      if (abortBtn) abortBtn.addEventListener("click", async () => {
        if (!(await U.confirmModal(t("game.abortQ"), t("game.abortText"), t("game.actAbort")))) return;
        act(() => API.abortGame(S.g.id));
      });
      U.qs("#act-resign", box).addEventListener("click", async () => {
        if (await U.confirmModal(t("game.resignQ"), t("game.resignText"), t("game.actResign"))) act(() => API.resign(S.g.id));
      });
      U.qs("#act-flag", box).addEventListener("click", () => doClaimFlag(true));
      bindRematch();
    }

    function drawRematchHtml() {
      const g = S.g;
      if (!me || !g.winner || g.status !== "finished") return "";
      const opp = g.white === me.id ? g.black : g.white;
      return `<button class="btn primary" id="act-rematch">↻ ${U.esc(t("game.rematch", { name: (S.names && S.names[opp]) || t("game.player").toLowerCase() }))}</button>`;
    }
    function bindRematch() {
      const b = U.qs("#act-rematch", root);
      if (!b) return;
      b.addEventListener("click", async () => {
        const g = S.g;
        const { data, error } = await API.createChallenge(g.initial_ms, g.increment_ms, g.rated, "random");
        if (error) return U.toast(error.message, "error");
        App.go(`/game/${data}`);
      });
    }

    // actions
    async function act(fn, ...args) {
      const { data, error } = await fn(...args);
      if (error) { U.toast(error.message, "error"); await refetch(); return; }
      if (data && data.game) await applyState(data.game, false);
    }

    // Optimistic move: rendered immediately (chess.js recomputes the
    // position locally) while the RPC runs in the background. The server
    // is the final judge; on rejection refetch() restores the board.
    function applyLocalMove(uci) {
      const g = S.g;
      if (!g || g.status !== "active" || !window.Chess) return null;
      let c, mv;
      try {
        c = new window.Chess(g.fen);
        mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4),
                      promotion: uci.length === 5 ? uci[4] : undefined });
      } catch (e) { return null; }
      if (!mv) return null;
      const nowMs = ServerTime.now();
      const myWhite = S.myColor === "white";
      const myRemaining = Math.max(0, remaining(myWhite ? "w" : "b"));
      const newMyMs = Math.round(myRemaining) + (g.increment_ms || 0);
      const entry = { u: uci, s: mv.san,
                      w: myWhite ? newMyMs : g.white_ms,
                      b: myWhite ? g.black_ms : newMyMs,
                      t: nowMs };
      S.g = Object.assign({}, g, {
        fen: c.fen(),
        moves: (g.moves || []).concat([entry]),
        white_ms: myWhite ? newMyMs : g.white_ms,
        black_ms: myWhite ? g.black_ms : newMyMs,
        last_move_at: new Date(nowMs).toISOString(),
        draw_offer_by: null, draw_offer_at: null,
        takeback_by: null, takeback_at: null
      });
      S.legal = computeLegal(S.g);
      derive(S.g);
      drawGame();
      if (mv.captured || /x/.test(mv.san)) U.soundCapture(); else U.soundMove();
      return mv;
    }

    async function onMove(from, to, promo, opts) {
      if (S.pendingMove) return;
      const uci = from + to + (promo || "");
      // every outgoing move (normal or premove) must be legal locally:
      // the server never receives an illegal move
      if (!S.legal.includes(uci)) return;
      S.pendingMove = true;
      const local = applyLocalMove(uci);   // instant render
      if (!local) drawStatus();            // nothing rendered locally: show "sending"
      const { data, error } = await API.makeMove(S.g.id, uci);
      S.pendingMove = false;
      if (error || (data && data.ok === false)) {
        const msg = I18n.s((error && error.message) || (data && data.error)) || t("game.moveRejected");
        U.toast(msg, "error");
        await refetch();                   // roll back to the server state
        return;
      }
      if (data && data.game && API.stateKey(data.game) !== API.stateKey(S.g)) {
        await applyState(data.game, false);
      } else if (!local) {
        drawStatus();
      }
    }

    async function doClaimFlag(manual) {
      if (S.flagClaimed || !S.g || S.g.status !== "active") return;
      S.flagClaimed = true;
      const { data, error } = await API.claimFlag(S.g.id);
      if (error) {
        S.flagClaimed = false;
        U.toast(error.message, "error");
        await refetch();
        return;
      }
      if (data && data.status === "not_out") {
        // by server time the opponent clock is not out yet: retry later, no penalties
        S.flagClaimed = false;
        S.flagRetryAt = ServerTime.now() + 2000;
        return;
      }
      if (data && data.game) await applyState(data.game, false);
    }

    // clock ticker
    const ticker = setInterval(() => {
      if (!S.g || S.destroyed) return;
      if (S.g.status !== "active") return;
      // refresh the clocks
      for (const color of ["white", "black"]) {
        const el = U.qs(`[data-clock=${color}]`, root);
        if (!el) continue;
        const ch = color === "white" ? "w" : "b";
        const ms = remaining(ch);
        el.textContent = U.fmtClock(ms);
        el.classList.toggle("low", ms < 20000 && ms > 0);
        el.classList.toggle("gone", ms <= 0);
        const isTurn = (S.stm === ch);
        el.classList.toggle("active", isTurn);
      }
      // automatic flag claim: the opponent clock expired and the
      // conservative estimate passed deadline plus margin. A not_out
      // answer simply retries after a delay.
      if (S.myColor && !S.flagClaimed && !S.pendingMove) {
        const oppChar = S.myColor === "white" ? "b" : "w";
        if (S.stm === oppChar && S.stmDeadline != null &&
            ServerTime.now() >= S.stmDeadline + CFG.AUTO_FLAG_DELAY_MS &&
            (!S.flagRetryAt || ServerTime.now() >= S.flagRetryAt)) {
          doClaimFlag(false);
        }
      }
      // highlight the flag button
      const flagBtn = U.qs("#act-flag", root);
      if (flagBtn) {
        const oppChar = S.myColor === "white" ? "b" : "w";
        flagBtn.classList.toggle("hidden", !(S.stm === oppChar && remaining(oppChar) <= 0));
      }
    }, 100);

    // game chat
    const chatCard = U.qs("#chat-card", root);
    const chatLog = U.qs("#chat-log", root);
    function chatMsg(m) {
      if (S.chatSeen.has(m.id)) return; // realtime and polling may duplicate
      // own message already shown optimistically: treat the match as confirmation
      if (me && m.user_id === me.id) {
        const i = S.chatPending.findIndex(p => p.body === m.body);
        if (i >= 0) {
          S.chatSeen.add(m.id);
          S.chatPending.splice(i, 1);
          return;
        }
      }
      S.chatSeen.add(m.id);
      const nm = (m.p && m.p.username) || (S.names && S.names[m.user_id]) || "?";
      const who = m.user_id
        ? `<a class="user-link" href="#/profile/${m.user_id}">${U.esc(nm)}:</a>`
        : `<b>${U.esc(nm)}:</b>`;
      const d = U.el(`<div class="chat-msg">${who} ${U.esc(m.body)}</div>`);
      const empty = chatLog.querySelector(".empty");
      if (empty) empty.remove();
      chatLog.appendChild(d);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    async function fetchNewChat() {
      if (!S.g || S.destroyed) return;
      const { data } = await API.sb.from("game_chat")
        .select("*, p:profiles(username)")
        .eq("game_id", S.g.id).order("created_at");
      (data || []).forEach((m) => {
        if (S.chatSeen.has(m.id)) return;
        const isNew = S.lastChatTs && U.parseTs(m.created_at) > S.lastChatTs;
        chatMsg(m);
        if (isNew && m.user_id !== (me && me.id)) U.soundMove();
      });
      if (data && data.length) S.lastChatTs = U.parseTs(data[data.length - 1].created_at);
    }
    async function initChat() {
      if (S.chatInit || !me || !S.g || !S.myColor) return; // participants only (RLS also enforces)
      S.chatInit = true;
      chatCard.style.display = "";
      subscribeChatChan();
      const { data } = await API.sb.from("game_chat")
        .select("*, p:profiles(username)")
        .eq("game_id", S.g.id).order("created_at");
      (data || []).forEach(chatMsg);
      if (data && data.length) S.lastChatTs = U.parseTs(data[data.length - 1].created_at);
      U.qs("#chat-send", root).addEventListener("click", sendChat);
      U.qs("#chat-text", root).addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendChat();
      });
    }
    async function sendChat() {
      const inp = U.qs("#chat-text", root);
      const body = inp.value.trim();
      if (!body) return;
      inp.value = "";
      // optimistic: the message appears instantly, the RPC runs in the background
      const nm = (myProfile && myProfile.username) || t("chat.you");
      const tmp = U.el(`<div class="chat-msg"><a class="user-link" href="#/profile/${me.id}">${U.esc(nm)}:</a> ${U.esc(body)}</div>`);
      chatLog.appendChild(tmp);
      chatLog.scrollTop = chatLog.scrollHeight;
      const pend = { body, el: tmp };
      S.chatPending.push(pend);
      const { data, error } = await API.sendChat(S.g.id, body);
      if (error) {
        // failed: remove the optimistic entry and restore the text
        tmp.remove();
        const i = S.chatPending.indexOf(pend);
        if (i >= 0) S.chatPending.splice(i, 1);
        U.toast(error.message, "error");
        inp.value = body;
        return;
      }
      if (data && data.message) S.chatSeen.add(data.message.id); // no duplicates later
      const i = S.chatPending.indexOf(pend);
      if (i >= 0) S.chatPending.splice(i, 1);
    }

    // Realtime plus fallback polling. Polling ticks only while the
    // websocket is down; otherwise it stays off. Returning to the tab
    // does one quiet fetch; the DOM changes only on real updates.
    async function pollOnce() {
      if (S.destroyed || !S.g) return;
      if (S.pendingMove) return; // own move in flight: do not interfere
      try {
        const { data } = await API.gameState(gameId);
        if (!data || !data.ok || S.destroyed) return;
        if (API.stateKey(data.game) !== API.stateKey(S.g)) {
          applyState(data.game, true);
        }
      } catch (e) { /* transient network issue; retry next tick */ }
    }
    const pollTimer = API.poll(2500, pollOnce, () => S.rtUp);
    const chatPollTimer = API.poll(3000, fetchNewChat, () => S.chatUp);
    S.stopVisible = API.onVisible(() => {
      pollOnce();          // quiet fetch on tab return
      fetchNewChat();      // chatSeen dedup prevents extra renders
    });
    // debug mode ?nort=1 disables realtime to test pure polling
    const NO_RT = /(?:^|[?&])nort=1/.test(location.search);

    function subscribe() {
      if (NO_RT || !S.g || S.gameSub) return;
      S.gameSub = true;
      S.chans.push(API.subscribeGame(S.g.id, (row) => {
        if (API.stateKey(row) === API.stateKey(S.g)) return; // duplicate after poll
        // legal moves are computed locally, no refetch needed
        applyState(row, true);
      }, (status) => {
        S.rtUp = (status === "SUBSCRIBED");
        if (S.rtUp && S._rtWasDown) pollOnce(); // refetch after reconnect
        S._rtWasDown = !S.rtUp;
      }));
    }
    function subscribeChatChan() {
      if (NO_RT || !me || !S.g || !S.myColor || S.chatSub) return;
      S.chatSub = true;
      S.chans.push(API.subscribeChat(S.g.id, (row) => {
        chatMsg({ ...row, p: { username: (S.names && S.names[row.user_id]) || (row.user_id === me.id ? myProfile.username : "?") } });
        U.soundMove();
      }, (status) => {
        S.chatUp = (status === "SUBSCRIBED");
        if (S.chatUp && S._chatWasDown) fetchNewChat();
        S._chatWasDown = !S.chatUp;
      }));
    }

    // startup
    const { data, error } = await API.gameState(gameId);
    if (error || !data || !data.ok) {
      container.innerHTML = `<div class="card center"><h2>${U.esc(t("game.notFound"))}</h2>
        <p><a href="#/">${U.esc(t("game.backToLobby"))}</a></p></div>`;
      return () => {};
    }
    await applyState(data.game, false);
    ServerTime.sync();
    await loadNames();
    await initChat();
    subscribe();
    initReplay(); // replay for finished games, local and RPC-free

    return function cleanup() {
      S.destroyed = true;
      stopAutoplay();
      clearInterval(ticker);
      pollTimer();
      chatPollTimer();
      if (S.stopVisible) S.stopVisible();
      if (S.keyHandler) document.removeEventListener("keydown", S.keyHandler);
      if (S.panel) S.panel.destroy();
      S.chans.forEach(API.unsubscribe);
    };
  };

  window.GamePage = { render: GamePage_render };
})();
