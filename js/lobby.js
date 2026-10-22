// Lobby: quick pairing, link challenges, own games, open challenges
// (visible to guests too), and the global chat.
(function () {
  "use strict";

  const PRESETS = [
    { label: "Пуля", name: "1+0", ms: 60000, inc: 0 },
    { label: "Пуля", name: "2+1", ms: 120000, inc: 1000 },
    { label: "Блиц", name: "3+0", ms: 180000, inc: 0 },
    { label: "Блиц", name: "3+2", ms: 180000, inc: 2000 },
    { label: "Блиц", name: "5+0", ms: 300000, inc: 0 },
    { label: "Быстрые", name: "10+0", ms: 600000, inc: 0 },
    { label: "Быстрые", name: "15+10", ms: 900000, inc: 10000 },
    { label: "Классика", name: "30+0", ms: 1800000, inc: 0 },
    { label: "Классика", name: "30+20", ms: 1800000, inc: 20000 }
  ];

  const LobbyPage_render = async function (container) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = await API.user();

    container.innerHTML = `
      <h1>Играть</h1>
      ${!me ? `
        <div class="card center">
          <h2>Добро пожаловать в «Ладью» &#9820;</h2>
          <p class="muted">Свободные онлайн-шахматы: валидация ходов прямо в PostgreSQL,
          рейтинг Эло, общий чат, личные сообщения, форум, клубы и блог.</p>
          <div class="row" style="justify-content:center">
            <a class="btn primary big" href="#/signup">Регистрация</a>
            <a class="btn big" href="#/login">Вход</a>
          </div>
        </div>
        <div class="card">
          <h2>Открытые вызовы</h2>
          <p class="muted small">Игроки, которые ищут соперника через «Быструю игру». Войдите, чтобы принять вызов.</p>
          <div id="open-list"><span class="spinner"></span></div>
        </div>` : `
        <div class="card hidden" id="my-games"></div>
        <div class="grid2">
          <div class="card">
            <h2>Быстрая игра</h2>
            <p class="muted small">Соперник подберётся автоматически. Цвет — случайный.</p>
            <div class="tc-grid" id="tc-grid">
              ${PRESETS.map(p => `
                <button class="tc-btn" data-ms="${p.ms}" data-inc="${p.inc}">
                  <b>${p.name}</b><span>${p.label}</span>
                </button>`).join("")}
            </div>
            <div class="row" style="margin-top:12px">
              <input id="custom-min" type="number" min="1" max="120" value="5" style="width:80px"> мин
              <input id="custom-inc" type="number" min="0" max="60" value="0" style="width:80px"> сек
              <button class="btn" id="custom-go">Подобрать</button>
            </div>
            <div id="seek-status" class="center" style="margin-top:14px"></div>
          </div>
          <div class="card">
            <h2>Вызов по ссылке</h2>
            <p class="muted small">Создайте партию и отправьте ссылку другу — он присоединится сюда.</p>
            <label>Ваш цвет</label>
            <select id="ch-color">
              <option value="random">Случайный</option>
              <option value="white">Белые</option>
              <option value="black">Чёрные</option>
            </select>
            <label>Контроль времени</label>
            <div class="row">
              <input id="ch-min" type="number" min="1" max="120" value="10" style="width:80px"> мин
              <input id="ch-inc" type="number" min="0" max="60" value="0" style="width:80px"> сек
            </div>
            <label><input type="checkbox" id="ch-rated" checked style="width:auto"> Рейтинговая</label>
            <button class="btn primary block" id="ch-create" style="margin-top:12px">Создать вызов</button>
          </div>
        </div>
        <div class="card">
          <h2 class="spread row">Открытые вызовы
            <button class="btn ghost small" id="open-refresh" title="Обновить список">⟳ Обновить</button></h2>
          <p class="muted small">Все, кто ищет соперника через «Быструю игру»: нажмите «Принять», чтобы начать партию с этим контролем.
          Вызовы по ссылке в списке не публикуются.</p>
          <div id="open-list"><span class="spinner"></span></div>
        </div>`}
      <div class="card">
        <h2>Общий чат</h2>
        <div id="global-chat"></div>
      </div>
    `;

    // global chat; guests read only
    const gcCleanup = Social.globalChat(U.qs("#global-chat"));
    let disposed = false;
    const cleanupFns = [() => { if (!disposed) gcCleanup(); }];

    // Open challenges = quick-pairing seeks. They are exactly the players
    // who searched an opponent through "Быстрая игра": accepting a seek
    // joins the same pool and pairs with its owner at once. Link
    // challenges stay private (joinable only through their link) and
    // direct challenges reach the invitee as a DM, so neither shows here.
    let openDebounce = null;
    const scheduleOpen = () => { clearTimeout(openDebounce); openDebounce = setTimeout(loadOpen, 250); };
    async function loadOpen() {
      const box = U.qs("#open-list");
      if (!box) return;
      const { data, error } = await API.sb.from("seeks")
        .select("id,user_id,initial_ms,increment_ms,created_at,p:profiles!seeks_user_id_fkey(id,username,rating)")
        .order("created_at", { ascending: true })
        .limit(20);
      if (error) {
        box.dataset.err = "1";
        box.innerHTML = `<div class="empty">Не удалось загрузить вызовы · <a href="#/">Обновить</a></div>`;
        return;
      }
      const rows = (data || []).map(s => {
        const own = me && s.user_id === me.id;
        return `<tr>
          <td><a href="#/profile/${s.user_id}">${U.esc(s.p ? s.p.username : "?")}</a>
              <span class="muted">(${s.p ? s.p.rating : "?"})</span>
              ${own ? '<span class="badge finished">это ваш вызов</span>' : ""}</td>
          <td><b>${U.fmtTc(s.initial_ms, s.increment_ms)}</b></td>
          <td><span class="badge rated">рейтинг</span></td>
          <td>${own
            ? `<button class="btn small" data-unseek="${s.id}">Отмена</button>`
            : me
              ? `<button class="btn primary small" data-accept="${s.initial_ms}:${s.increment_ms}">Принять</button>`
              : `<a class="btn small" href="#/login">Войти</a>`}</td>
        </tr>`;
      });
      const html = rows.length
        ? `<table class="lobby-list"><tr><th>Игрок</th><th>Контроль</th><th>Тип</th><th></th></tr>${rows.join("")}</table>`
        : `<div class="empty">Пока нет открытых вызовов — нажмите «Быстрая игра»!</div>`;
      const sig = (data || []).map(s => `${s.user_id}:${s.initial_ms}:${s.increment_ms}`).join(",");
      if (box.dataset.sig === sig && box.dataset.err !== "1") return; // unchanged: skip redraw
      box.dataset.sig = sig;
      box.dataset.err = "0";
      box.innerHTML = html;
      U.qsa("[data-unseek]", box).forEach(b => b.addEventListener("click", async () => {
        b.disabled = true;
        await API.cancelSeek();
        loadOpen();
      }));
      U.qsa("[data-accept]", box).forEach(b => b.addEventListener("click", () => {
        const [ms, inc] = b.dataset.accept.split(":").map(Number);
        startSeek(ms, inc);
      }));
    }

    if (!me) {
      // guests see open challenges read-only (seeks are publicly
      // readable; joining requires signing in), with polling and a
      // manual refresh
      loadOpen();
      const t = API.poll(4000, loadOpen); // always ticks for guests
      const stopVis = API.onVisible(loadOpen);
      const openRefreshBtn = U.qs("#open-refresh");
      if (openRefreshBtn) openRefreshBtn.addEventListener("click", loadOpen);
      cleanupFns.push(() => { t(); stopVis(); clearTimeout(openDebounce); });
      return function cleanup() { cleanupFns.forEach(f => f()); };
    }

    // own active games
    async function loadMyGames() {
      const box = U.qs("#my-games");
      if (!box) return;
      const { data } = await API.sb.from("games")
        .select("id,white,black,status,initial_ms,increment_ms")
        .or(`white.eq.${me.id},black.eq.${me.id}`)
        .in("status", ["active", "waiting"])
        .order("created_at", { ascending: false })
        .limit(8);
      if (!data || !data.length) { box.classList.add("hidden"); return; }
      const sig = data.map(g => g.id + g.status).join(",");
      if (box.dataset.sig === sig) return; // unchanged: skip redraw
      box.dataset.sig = sig;
      box.classList.remove("hidden");
      box.innerHTML = `<h2>Мои партии</h2>` + data.map(g =>
        `<div class="list-item">
          <span class="badge ${g.status}">${g.status === "active" ? "идёт" : "ожидание"}</span>
          <a href="#/game/${g.id}">Партия ${U.fmtTc(g.initial_ms, g.increment_ms)}</a>
        </div>`).join("");
    }
    loadMyGames();

    // quick pairing
    let seeking = false;
    let seekTimer = null;
    async function startSeek(ms, inc) {
      if (seeking) return;
      seeking = true;
      const st = U.qs("#seek-status");
      st.innerHTML = `<span class="spinner"></span> Ищем соперника (${U.fmtTc(ms, inc)})…
        <button class="btn ghost small" id="seek-cancel">Отмена</button>`;
      U.qs("#seek-cancel", st).addEventListener("click", cancelSeek);

      const { data, error } = await API.quickPair(ms, inc);
      if (error) { seeking = false; st.innerHTML = ""; U.toast(error.message, "error"); return; }
      if (data) { location.hash = `#/game/${data}`; return; }
      // wait for the pair by polling own active games
      seekTimer = setInterval(async () => {
        const { data: games } = await API.sb.from("games")
          .select("id").or(`white.eq.${me.id},black.eq.${me.id}`)
          .eq("status", "active").limit(1);
        if (games && games.length) { stopSeek(); location.hash = `#/game/${games[0].id}`; }
      }, 2500);
    }
    async function cancelSeek() {
      stopSeek();
      await API.cancelSeek();
    }
    function stopSeek() {
      seeking = false;
      if (seekTimer) clearInterval(seekTimer);
      const st = U.qs("#seek-status");
      if (st) st.innerHTML = "";
    }

    U.qsa("#tc-grid .tc-btn").forEach(b =>
      b.addEventListener("click", () => startSeek(Number(b.dataset.ms), Number(b.dataset.inc))));
    U.qs("#custom-go").addEventListener("click", () => {
      const min = Math.max(1, Number(U.qs("#custom-min").value) || 5);
      const inc = Math.max(0, Number(U.qs("#custom-inc").value) || 0);
      startSeek(min * 60000, inc * 1000);
    });

    // challenge creation
    U.qs("#ch-create").addEventListener("click", async () => {
      const min = Math.max(1, Number(U.qs("#ch-min").value) || 10);
      const inc = Math.max(0, Number(U.qs("#ch-inc").value) || 0);
      const rated = U.qs("#ch-rated").checked;
      const color = U.qs("#ch-color").value;
      const { data, error } = await API.createChallenge(min * 60000, inc * 1000, rated, color);
      if (error) return U.toast(error.message, "error");
      location.hash = `#/game/${data}`;
    });

    // open challenges: refresh via seeks realtime plus polling, so the
    // list always reflects the quick-pairing queue
    const openRefreshBtn = U.qs("#open-refresh");
    if (openRefreshBtn) openRefreshBtn.addEventListener("click", loadOpen);
    loadOpen();
    let rtDebounce = null, _wasDown = false, rtChan = null;
    const rtRefresh = () => { clearTimeout(rtDebounce); rtDebounce = setTimeout(loadMyGames, 250); };
    rtChan = API.subscribeInserts("games", null, rtRefresh, (status) => {
      if (status === "SUBSCRIBED" && _wasDown) { loadOpen(); loadMyGames(); } // refetch after reconnect
      _wasDown = status !== "SUBSCRIBED";
    }, ["INSERT", "UPDATE"]);
    // seeks changes (new, updated, removed) redraw the open list at once
    let _seekDown = false;
    const seekChan = API.subscribeInserts("seeks", null, scheduleOpen, (status) => {
      if (status === "SUBSCRIBED" && _seekDown) loadOpen();
      _seekDown = status !== "SUBSCRIBED";
    }, ["INSERT", "UPDATE", "DELETE"]);
    // polling always runs so challenges stay visible
    const openTimer = API.poll(4000, loadOpen);
    const myTimer = API.poll(6000, loadMyGames);
    const stopVisible = API.onVisible(() => { loadOpen(); loadMyGames(); });

    return function cleanup() {
      disposed = true;
      if (seekTimer) clearInterval(seekTimer);
      openTimer();
      myTimer();
      stopVisible();
      clearTimeout(rtDebounce);
      clearTimeout(openDebounce);
      API.unsubscribe(rtChan);
      API.unsubscribe(seekChan);
      if (seeking) API.cancelSeek();
      cleanupFns.forEach(f => f());
    };
  };

  window.LobbyPage = { render: LobbyPage_render };
})();
