// Game page: board, server-backed clocks, automatic flag claims,
// chat, and player actions.
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const REASONS = {
    checkmate: "Мат",
    resign: "Соперник сдался",
    timeout: "Время вышло",
    fraud: "Ложное заявление о флаге",
    abandonment: "Соперник покинул партию",
    agreement: "Ничья по соглашению",
    stalemate: "Пат",
    insufficient_material: "Недостаток материала",
    fifty_moves: "Правило 50 ходов",
    repetition: "Троекратное повторение",
    forfeit: "Соперник заблокирован",
    cheat: "Соперник систематически отправлял нелегальные ходы",
    abort: "Партия отменена — рейтинг не изменился"
  };

  // Local legal-move generation with the vendored chess.js 1.4.0.
  // The server remains the source of truth: it validates submitted moves
  // and decides the result. The move list only feeds the UI
  // (highlights and premoves) and is never fetched from the server.
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
      replay: null, replayPly: null, keyHandler: null,
      premove: null,           // { from, to, promo } staged move (square names)
      flagRetryAt: null,       // retry delay for a flag claim after not_out
      chatSeen: new Set(), lastChatTs: null,
      chatPending: [],         // optimistic messages: [{body, el}]
      rtUp: false,             // game channel websocket up: polling not needed
      stopVisible: null
    };

    container.innerHTML = `<div class="card center"><span class="spinner"></span> Загрузка партии…</div>`;

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
      // the premove is sent immediately with no local legality check;
      // the server is the final judge and rejects illegal moves, after
      // which the board redraws from the database state.
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
        <div class="board-wrap"><div id="board"></div></div>
        <div class="player-bar" id="pb-bottom"></div>
      </div>
      <div>
        <div class="card" id="status-card"></div>
        <div class="card">
          <h3 class="spread row">Ходы <button class="btn ghost small" id="flip">⇅ Развернуть</button></h3>
          <div class="moves-list" id="moves"></div>
          <div class="replay-bar" id="replaybar" style="display:none"></div>
          <div class="game-actions" id="actions"></div>
          <div id="drawbox"></div>
        </div>
        <div class="card" id="chat-card" style="display:none">
          <h3>Чат партии</h3>
          <div class="chat-box">
            <div class="chat-log" id="chat-log"></div>
            <div class="chat-input">
              <input id="chat-text" maxlength="500" placeholder="Сообщение…">
              <button class="btn primary" id="chat-send">→</button>
            </div>
          </div>
        </div>
      </div>
    </div>`);
    container.innerHTML = "";
    container.appendChild(root);

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
      if (!pid) { box.innerHTML = `<span class="muted">Ожидание игрока…</span>`; return; }
      const name = pid === (myProfile && myProfile.id) ? (myProfile.username) : (S.names && S.names[pid]) || "…";
      const rating = pid === (myProfile && myProfile.id) ? myProfile.rating : (S.names && S.names[pid] !== undefined ? S.ratings[pid] : "");
      const turn = g.status === "active" && ((S.stm === "w") === (color === "white"));
      const ms = remaining(color === "white" ? "w" : "b");
      const low = g.status === "active" && ms < 20000;
      const gone = ms <= 0;
      box.innerHTML = `
        <span class="avatar">${U.esc((name || "?")[0].toUpperCase())}</span>
        <span class="who"><a href="#/profile/${pid}">${U.esc(name || "Игрок")}</a>
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
        : `<div class="empty">Партия только началась</div>`;
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
        <button class="btn ghost small" data-rp="first" title="В начало">|&#9664;</button>
        <button class="btn ghost small" data-rp="prev" title="Назад">&#9664;</button>
        <button class="btn ghost small" data-rp="next" title="Вперёд">&#9654;</button>
        <button class="btn ghost small" data-rp="last" title="В конец">&#9654;|</button>
        <span class="muted small" id="replay-pos"></span>
        <span class="muted small">· стрелки ← → перематывают</span>`;
      U.qsa("button[data-rp]", bar).forEach(b => b.addEventListener("click", () => {
        const a = b.dataset.rp;
        if (a === "first") seekReplay(0);
        else if (a === "prev") seekReplay(S.replayPly - 1);
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
    function updateReplayPos() {
      const el = U.qs("#replay-pos", root);
      if (el) el.textContent = `${S.replayPly} / ${(S.replay.fens || []).length}`;
    }
    function seekReplay(ply) {
      if (!S.replay) return;
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
    }

    function drawStatus() {
      const g = S.g;
      const c = U.qs("#status-card", root);
      if (g.status === "waiting") {
        const isHost = me && (g.white === me.id || g.black === me.id);
        const link = `${location.origin}${location.pathname}#/game/${g.id}`;
        c.innerHTML = `
          <div class="result-banner waiting">Ожидание соперника</div>
          <p class="small muted">Контроль: ${U.fmtTc(g.initial_ms, g.increment_ms)},
            ${g.rated ? "рейтинговая" : "товарищеская"}</p>
          ${isHost ? `
            <label>Ссылка-приглашение</label>
            <div class="row"><input readonly id="inv-link" value="${U.esc(link)}">
            <button class="btn" id="copy-inv">Копировать</button></div>
            <div class="game-actions"><button class="btn danger" id="cancel-wait">Отменить вызов</button></div>` : ""}
          ${!me ? `<p>Войдите, чтобы присоединиться к партии.</p>`
                : (!S.myColor ? `<div class="game-actions">
                    <button class="btn primary big" id="join-btn">♟ Присоединиться к партии</button>
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
            U.toast("Ссылка скопирована", "good");
          });
          U.qs("#cancel-wait", c).addEventListener("click", async () => {
            if (!(await U.confirmModal("Отменить вызов?", "Партия будет удалена.", "Отменить"))) return;
            const { error } = await API.cancelWaiting(g.id);
            if (error) U.toast(error.message, "error"); else location.hash = "#/";
          });
        }
        return;
      }
      if (g.status === "aborted") {
        c.innerHTML = `<div class="result-banner draw">Партия прервана</div>
          <p class="small muted center">${REASONS[g.reason] || ""}</p>`;
        return;
      }
      if (g.status === "finished") {
        let cls = "draw", txt = "Ничья";
        if (me && g.winner) {
          if (g.winner === me.id) { cls = "win"; txt = "Победа!"; }
          else { cls = "lose"; txt = "Поражение"; }
        } else if (g.result === "1-0") txt = "1–0 · победа белых";
        else if (g.result === "0-1") txt = "0–1 · победа чёрных";
        else txt = "½–½";
        const rd = g.rating_delta || null;
        // the pool rating delta takes precedence over the global one
        const myDelta = rd && me ? (g.white === me.id ? rd.white : rd.black) : null;
        const myDeltaClass = rd && me ? (g.white === me.id ? rd.white_class : rd.black_class) : null;
        const shownDelta = myDeltaClass != null ? myDeltaClass : myDelta;
        const poolName = rd && rd.class === "bullet" ? "пуля" : rd && rd.class === "blitz" ? "блиц"
                       : rd && rd.class === "rapid" ? "быстрые"
                       : rd && rd.class === "classic" ? "классика" : "";
        c.innerHTML = `
          <div class="result-banner ${cls}">${txt}</div>
          <p class="small muted center">${U.esc(REASONS[g.reason] || "")}
          ${g.rated && shownDelta != null && shownDelta !== 0 ?
            ` · Рейтинг${poolName ? " (" + poolName + ")" : ""}: <b>${shownDelta > 0 ? "+" : ""}${shownDelta}</b>` : ""}</p>
          ${me && g.winner && g.winner !== me.id && g.reason === "fraud" ?
            `<p class="small center good">Соперник заблокирован навсегда за попытку обмана.</p>` : ""}`;
        return;
      }
      // active game
      const myTurn = S.myColor && ((S.stm === "w") === (S.myColor === "white"));
      const prenote = S.premove
        ? `<div class="draw-box premove-box"><span>Премув: <b>${U.esc(S.premove.from)}→${U.esc(S.premove.to)}${S.premove.promo ? "=" + S.premove.promo.toUpperCase() : ""}</b> — сыграет после хода соперника · отмена — ПКМ по доске</span>
           <button class="btn ghost small" id="pm-cancel">Отменить</button></div>`
        : "";
      c.innerHTML = `<div class="center">
        ${S.pendingMove ? `<span class="spinner"></span> Ход отправляется…` :
          myTurn ? `<b>Ваш ход</b>` :
          S.myColor ? `<span class="muted">Ход соперника — можно зарядить премув</span>` :
          `<span class="muted">Просмотр партии</span>`}
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
        <button class="btn" id="act-draw">½ Ничья</button>
        <button class="btn ${(!hasMoves || oppTb || myTb) ? "hidden" : ""}" id="act-takeback">↩ Взять ход</button>
        <button class="btn" id="act-resign">⚑ Сдаться</button>
        ${canAbort ? `<button class="btn" id="act-abort" title="Отмена без изменения рейтинга">✖ Отменить партию</button>` : ""}
        <button class="btn danger hidden" id="act-flag">🏳 Флаг!</button>`;
      if (oppOffer) {
        db.innerHTML = `<div class="draw-box"><span>Соперник предлагает ничью</span>
          <button class="btn primary small" id="d-accept">Принять</button>
          <button class="btn ghost small" id="d-decline">Отклонить</button></div>`;
        U.qs("#d-accept", db).addEventListener("click", () => act(() => API.acceptDraw(S.g.id)));
        U.qs("#d-decline", db).addEventListener("click", () => act(() => API.declineDraw(S.g.id)));
      }
      if (myOffer) {
        // my pending draw offer is shown like a premove: it stays on the
        // board until the opponent answers, and I may cancel it anytime
        db.insertAdjacentHTML("beforeend", `<div class="draw-box premove-box">
          <span>Ничья предложена — сыграет, когда соперник согласится</span>
          <button class="btn ghost small" id="d-cancel">Отменить</button></div>`);
        U.qs("#d-cancel", db).addEventListener("click", () => act(() => API.declineDraw(S.g.id)));
      }
      if (oppTb) {
        db.insertAdjacentHTML("beforeend", `<div class="draw-box"><span>Соперник просит взять ход назад</span>
          <button class="btn primary small" id="tb-accept">Принять</button>
          <button class="btn ghost small" id="tb-decline">Отклонить</button></div>`);
        U.qs("#tb-accept", db).addEventListener("click", () => act(() => API.acceptTakeback(S.g.id)));
        U.qs("#tb-decline", db).addEventListener("click", () => act(() => API.declineTakeback(S.g.id)));
      } else if (myTb) {
        db.insertAdjacentHTML("beforeend", `<div class="draw-box"><span>Вы просите откат хода — ждём ответа соперника.</span>
          <button class="btn ghost small" id="tb-cancel">Отменить</button></div>`);
        U.qs("#tb-cancel", db).addEventListener("click", () => act(() => API.declineTakeback(S.g.id)));
      }
      U.qs("#act-draw", box).addEventListener("click", () => act(() => API.offerDraw(S.g.id)));
      const tbBtn = U.qs("#act-takeback", box);
      if (tbBtn) tbBtn.addEventListener("click", () => act(() => API.requestTakeback(S.g.id)));
      const abortBtn = U.qs("#act-abort", box);
      if (abortBtn) abortBtn.addEventListener("click", async () => {
        if (!(await U.confirmModal("Отменить партию?",
            "Партия прервётся без изменения рейтинга. Доступно, пока оба игрока не сделали по одному ходу.",
            "Отменить партию"))) return;
        act(() => API.abortGame(S.g.id));
      });
      U.qs("#act-resign", box).addEventListener("click", async () => {
        if (await U.confirmModal("Сдаться?", "Партия будет проиграна.", "Сдаться")) act(() => API.resign(S.g.id));
      });
      U.qs("#act-flag", box).addEventListener("click", () => doClaimFlag(true));
      bindRematch();
    }

    function drawRematchHtml() {
      const g = S.g;
      if (!me || !g.winner || g.status !== "finished") return "";
      const opp = g.white === me.id ? g.black : g.white;
      return `<button class="btn primary" id="act-rematch">↻ Новая партия с ${U.esc((S.names && S.names[opp]) || "соперником")}</button>`;
    }
    function bindRematch() {
      const b = U.qs("#act-rematch", root);
      if (!b) return;
      b.addEventListener("click", async () => {
        const g = S.g;
        const { data, error } = await API.createChallenge(g.initial_ms, g.increment_ms, g.rated, "random");
        if (error) return U.toast(error.message, "error");
        location.hash = `#/game/${data}`;
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
      const isPremove = !!(opts && opts.isPremove);
      // normal move: render instantly when chess.js accepts it; premoves skip checks entirely
      if (!isPremove && !S.legal.includes(uci)) return;
      S.pendingMove = true;
      const local = applyLocalMove(uci);   // instant render
      if (!local) drawStatus();            // nothing rendered locally: show "sending"
      const { data, error } = await API.makeMove(S.g.id, uci);
      S.pendingMove = false;
      if (error || (data && data.ok === false)) {
        const msg = (error && error.message) || (data && data.error) || "Ход отклонён сервером";
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
      const nm = (myProfile && myProfile.username) || "Вы";
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
      container.innerHTML = `<div class="card center"><h2>Партия не найдена</h2>
        <p><a href="#/">← Вернуться в лобби</a></p></div>`;
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
      clearInterval(ticker);
      pollTimer();
      chatPollTimer();
      if (S.stopVisible) S.stopVisible();
      if (S.keyHandler) document.removeEventListener("keydown", S.keyHandler);
      S.chans.forEach(API.unsubscribe);
    };
  };

  window.GamePage = { render: GamePage_render };
})();
