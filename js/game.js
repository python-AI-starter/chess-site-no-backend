// ============================================================
//  Страница партии: доска, часы (по серверному времени),
//  авто-заявка флага, чат, действия.
// ============================================================
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const REASONS = {
    checkmate: "Мат",
    resign: "Соперник сдался",
    timeout: "Время вышло",
    fraud: "Ложное заявление о флаге — обманщик заблокирован навсегда",
    abandonment: "Соперник покинул партию",
    agreement: "Ничья по соглашению",
    stalemate: "Пат",
    insufficient_material: "Недостаток материала",
    fifty_moves: "Правило 50 ходов",
    repetition: "Троекратное повторение",
    forfeit: "Соперник заблокирован"
  };

  const GamePage_render = async function (container, gameId) {
    let me = null;
    let myProfile = null;
    try { me = await API.user(); myProfile = me ? await API.profile(me.id) : null; } catch (e) {}

    const S = {
      g: null, legal: [], myColor: null, board: null,
      chans: [], pendingMove: false, flagClaimed: false, destroyed: false,
      stm: "w", oppDeadline: null, chatEl: null,
      chatInit: false, chatSub: false, gameSub: false
    };

    container.innerHTML = `<div class="card center"><span class="spinner"></span> Загрузка партии…</div>`;

    // ---------- применение состояния ----------
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

    async function applyState(g, legal, fromRemote) {
      if (S.destroyed) return;
      const wasOver = S.g && S.g.status !== "active" && S.g.status !== "waiting";
      S.g = g;
      S.legal = legal || [];
      S.myColor = !me ? null : (g.white === me.id ? "white" : (g.black === me.id ? "black" : null));
      derive(g);
      drawGame();

      // чат становится доступен, как только я стал участником активной партии
      if (me && S.myColor && !S.chatInit) initChat();

      if (!wasOver && g.status === "finished" || g.status === "aborted") {
        if (!wasOver && fromRemote) U.soundEnd();
      }
    }

    async function refetch() {
      const { data, error } = await API.gameState(gameId);
      if (error) { U.toast(error.message, "error"); return; }
      await applyState(data.game, data.legal_moves, true);
    }

    // ---------- разметка ----------
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
      canMove: () => S.g && S.g.status === "active" && S.myColor && !S.pendingMove &&
                     ((S.stm === "w") === (S.myColor === "white")),
      myColor: () => S.myColor
    });

    U.qs("#flip", root).addEventListener("click", () => {
      S.board.flip();
    });

    // ---------- отрисовка ----------
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
      // подтянуть профили обоих игроков (публичны)
      const ids = [S.g.white, S.g.black].filter(Boolean);
      if (!ids.length) return;
      const { data } = await API.sb.from("profiles").select("id,username,rating,is_banned").in("id", ids);
      S.names = {}; S.ratings = {};
      (data || []).forEach(p => { S.names[p.id] = p.username + (p.is_banned ? " 🚫" : ""); S.ratings[p.id] = p.rating; });
      drawGame();
    }

    function movesList() {
      const mv = (S.g.moves || []);
      const rows = [];
      for (let i = 0; i < mv.length; i += 2) {
        const cur = i + 1 === mv.length;
        rows.push(`<tr class="${cur ? "cur" : ""}"><td class="num">${i / 2 + 1}.</td>
          <td>${U.esc(mv[i].s)}</td><td>${mv[i + 1] ? U.esc(mv[i + 1].s) : ""}</td></tr>`);
      }
      U.qs("#moves", root).innerHTML = rows.length
        ? `<table>${rows.join("")}</table>`
        : `<div class="empty">Партия только началась</div>`;
      const list = U.qs("#moves", root);
      list.scrollTop = list.scrollHeight;
    }

    function checkSquare() {
      const mv = S.g.moves || [];
      if (!mv.length) return null;
      const san = mv[mv.length - 1].s || "";
      if (!/[+#]$/.test(san)) return null;
      // король стороны, чей ход
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
          if (data && data.game) await applyState(data.game, data.legal_moves || [], false);
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
        const myDelta = rd && me ? (g.white === me.id ? rd.white : rd.black) : null;
        c.innerHTML = `
          <div class="result-banner ${cls}">${txt}</div>
          <p class="small muted center">${U.esc(REASONS[g.reason] || "")}
          ${g.rated && myDelta != null && myDelta !== 0 ?
            ` · Рейтинг: <b>${myDelta > 0 ? "+" : ""}${myDelta}</b>` : ""}</p>
          ${me && g.winner && g.winner !== me.id && g.reason === "fraud" ?
            `<p class="small center good">Соперник заблокирован навсегда за попытку обмана.</p>` : ""}`;
        return;
      }
      // active
      const myTurn = S.myColor && ((S.stm === "w") === (S.myColor === "white"));
      c.innerHTML = `<div class="center">
        ${S.pendingMove ? `<span class="spinner"></span> Ход отправляется…` :
          myTurn ? `<b>Ваш ход</b>` :
          S.myColor ? `<span class="muted">Ход соперника</span>` :
          `<span class="muted">Просмотр партии</span>`}
      </div>`;
    }

    function drawActions() {
      const g = S.g;
      const box = U.qs("#actions", root);
      const db = U.qs("#drawbox", root);
      db.innerHTML = "";
      if (g.status !== "active" || !S.myColor) { box.innerHTML = drawRematchHtml(); bindRematch(); return; }

      const oppOffer = g.draw_offer_by && me && g.draw_offer_by !== me.id;
      const myTb = g.takeback_by && me && g.takeback_by === me.id;
      const oppTb = g.takeback_by && me && g.takeback_by !== me.id;
      const hasMoves = (g.moves || []).length >= 1;
      box.innerHTML = `
        <button class="btn" id="act-draw">½ Ничья</button>
        <button class="btn ${(!hasMoves || oppTb || myTb) ? "hidden" : ""}" id="act-takeback">↩ Взять ход</button>
        <button class="btn" id="act-resign">⚑ Сдаться</button>
        <button class="btn danger hidden" id="act-flag">🏳 Флаг!</button>`;
      if (oppOffer) {
        db.innerHTML = `<div class="draw-box"><span>Соперник предлагает ничью</span>
          <button class="btn primary small" id="d-accept">Принять</button>
          <button class="btn ghost small" id="d-decline">Отклонить</button></div>`;
        U.qs("#d-accept", db).addEventListener("click", () => act(() => API.acceptDraw(S.g.id)));
        U.qs("#d-decline", db).addEventListener("click", () => act(() => API.declineDraw(S.g.id)));
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

    // ---------- действия ----------
    async function act(fn, ...args) {
      const { data, error } = await fn(...args);
      if (error) { U.toast(error.message, "error"); await refetch(); return; }
      if (data && data.game) await applyState(data.game, data.legal_moves || [], false);
    }

    async function onMove(from, to, promo) {
      if (S.pendingMove) return;
      S.pendingMove = true;
      drawStatus();
      const uci = from + to + (promo || "");
      const cap = false;
      const { data, error } = await API.makeMove(S.g.id, uci);
      S.pendingMove = false;
      if (error) {
        U.toast(error.message, "error");
        await refetch();
        return;
      }
      if (data && data.game) {
        U.soundMove();
        await applyState(data.game, data.legal_moves || [], false);
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
      if (data && data.status === "fraud") {
        U.toast("Заявка о флаге была ложной: победа засчитана сопернику, вы заблокированы навсегда.", "error");
      }
      if (data && data.game) await applyState(data.game, [], false);
    }

    // ---------- тикер часов ----------
    const ticker = setInterval(() => {
      if (!S.g || S.destroyed) return;
      if (S.g.status !== "active") return;
      // обновить часы
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
      // авто-заявка флага: часы соперника кончились, консервативное время
      // >= дедлайн + запас. Ложным быть не может: клиентские оценки опаздывают.
      if (S.myColor && !S.flagClaimed && !S.pendingMove) {
        const oppChar = S.myColor === "white" ? "b" : "w";
        if (S.stm === oppChar && S.stmDeadline != null &&
            ServerTime.now() >= S.stmDeadline + CFG.AUTO_FLAG_DELAY_MS) {
          doClaimFlag(false);
        }
      }
      // подсветить кнопку флага
      const flagBtn = U.qs("#act-flag", root);
      if (flagBtn) {
        const oppChar = S.myColor === "white" ? "b" : "w";
        flagBtn.classList.toggle("hidden", !(S.stm === oppChar && remaining(oppChar) <= 0));
      }
    }, 100);

    // ---------- чат ----------
    const chatCard = U.qs("#chat-card", root);
    const chatLog = U.qs("#chat-log", root);
    function chatMsg(m) {
      const d = U.el(`<div class="chat-msg"><b>${U.esc(m.p && m.p.username || "?")}:</b> ${U.esc(m.body)}</div>`);
      chatLog.appendChild(d);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    async function initChat() {
      if (S.chatInit || !me || !S.g || !S.myColor) return; // чат только для участников (RLS и так режет)
      S.chatInit = true;
      chatCard.style.display = "";
      subscribeChatChan();
      const { data } = await API.sb.from("game_chat")
        .select("*, p:profiles(username)")
        .eq("game_id", S.g.id).order("created_at");
      (data || []).forEach(chatMsg);
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
      const { error } = await API.sendChat(S.g.id, body);
      if (error) { U.toast(error.message, "error"); inp.value = body; }
    }

    // ---------- realtime ----------
    function subscribe() {
      if (!S.g || S.gameSub) return;
      S.gameSub = true;
      API.unsubscribe(S.chans.pop());
      S.chans.push(API.subscribeGame(S.g.id, (row) => {
        applyState(row, S.g.status === "active" ? S.legal : [], true);
        if (row.status === "active" && (!S.legal || !S.legal.length)) refetch();
      }));
    }
    function subscribeChatChan() {
      if (!me || !S.g || !S.myColor || S.chatSub) return;
      S.chatSub = true;
      S.chans.push(API.subscribeChat(S.g.id, (row) => {
        chatMsg({ ...row, p: { username: (S.names && S.names[row.user_id]) || (row.user_id === me.id ? myProfile.username : "?") } });
        U.soundMove();
      }));
    }

    // ---------- старт ----------
    const { data, error } = await API.gameState(gameId);
    if (error || !data || !data.ok) {
      container.innerHTML = `<div class="card center"><h2>Партия не найдена</h2>
        <p><a href="#/">← Вернуться в лобби</a></p></div>`;
      return () => {};
    }
    await applyState(data.game, data.legal_moves, false);
    ServerTime.sync();
    await loadNames();
    await initChat();
    subscribe();

    return function cleanup() {
      S.destroyed = true;
      clearInterval(ticker);
      S.chans.forEach(API.unsubscribe);
    };
  };

  window.GamePage = { render: GamePage_render };
})();
