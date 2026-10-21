// ============================================================
//  Лобби: быстрый поиск, вызовы по ссылке, мои партии,
//  открытые вызовы (видны и гостям) и ОБЩИЙ ЧАТ на главной.
// ============================================================
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
          <h2>Открытые вызовы</h2>
          <div id="open-list"><span class="spinner"></span></div>
        </div>`}
      <div class="card">
        <h2>Общий чат</h2>
        <div id="global-chat"></div>
      </div>
    `;

    // ---------- общий чат (для всех: гости читают) ----------
    const gcCleanup = Social.globalChat(U.qs("#global-chat"));
    let disposed = false;
    const cleanupFns = [() => { if (!disposed) gcCleanup(); }];

    if (!me) {
      // гости: открытые вызовы только для просмотра
      async function loadOpenGuest() {
        const box = U.qs("#open-list");
        if (!box) return;
        const { data } = await API.sb.from("games")
          .select("id,white,black,rated,initial_ms,increment_ms,created_at,invitee,wp:profiles!games_white_fkey(username,rating),bp:profiles!games_black_fkey(username,rating)")
          .eq("status", "waiting").is("invitee", null)
          .gte("created_at", new Date(Date.now() - 3600 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(20);
        const rows = (data || []).map(g => {
          const host = g.white ? g.wp : g.bp;
          const hostId = g.white || g.black;
          return `<tr>
            <td><a href="#/profile/${hostId}">${U.esc(host ? host.username : "?")}</a>
                <span class="muted">(${host ? host.rating : "?"})</span></td>
            <td><b>${U.fmtTc(g.initial_ms, g.increment_ms)}</b></td>
            <td>${g.rated ? '<span class="badge rated">рейтинг</span>' : '<span class="badge">дружеская</span>'}</td>
            <td><a class="btn small" href="#/login">Войти</a></td>
          </tr>`;
        });
        const html = rows.length
          ? `<table class="lobby-list"><tr><th>Игрок</th><th>Контроль</th><th>Тип</th><th></th></tr>${rows.join("")}</table>`
          : `<div class="empty">Пока нет открытых вызовов</div>`;
        const sig = (data || []).map(g => g.id + g.status).join(",");
        if (box.dataset.sig === sig) return; // ничего не изменилось — не мерцаем
        box.dataset.sig = sig;
        box.innerHTML = html;
      }
      loadOpenGuest();
      const t = API.poll(5000, loadOpenGuest);
      const stopVis = API.onVisible(loadOpenGuest);
      cleanupFns.push(() => { t(); stopVis(); });
      return function cleanup() { cleanupFns.forEach(f => f()); };
    }

    // ---------- мои активные партии ----------
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
      if (box.dataset.sig === sig) return; // без изменений — не мерцаем
      box.dataset.sig = sig;
      box.classList.remove("hidden");
      box.innerHTML = `<h2>Мои партии</h2>` + data.map(g =>
        `<div class="list-item">
          <span class="badge ${g.status}">${g.status === "active" ? "идёт" : "ожидание"}</span>
          <a href="#/game/${g.id}">Партия ${U.fmtTc(g.initial_ms, g.increment_ms)}</a>
        </div>`).join("");
    }
    loadMyGames();

    // ---------- быстрый поиск ----------
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
      // ждём пару: опрос своих активных партий
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

    // ---------- вызов ----------
    U.qs("#ch-create").addEventListener("click", async () => {
      const min = Math.max(1, Number(U.qs("#ch-min").value) || 10);
      const inc = Math.max(0, Number(U.qs("#ch-inc").value) || 0);
      const rated = U.qs("#ch-rated").checked;
      const color = U.qs("#ch-color").value;
      const { data, error } = await API.createChallenge(min * 60000, inc * 1000, rated, color);
      if (error) return U.toast(error.message, "error");
      location.hash = `#/game/${data}`;
    });

    // ---------- открытые вызовы ----------
    async function loadOpen() {
      const box = U.qs("#open-list");
      if (!box) return;
      const { data } = await API.sb.from("games")
        .select("id,white,black,rated,initial_ms,increment_ms,created_at,invitee,wp:profiles!games_white_fkey(username,rating),bp:profiles!games_black_fkey(username,rating)")
        .eq("status", "waiting")
        .gte("created_at", new Date(Date.now() - 3600 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(20);
      const rows = (data || [])
        .filter(g => !g.invitee || g.invitee === me.id)
        .map(g => {
          const isHost = g.white === me.id || g.black === me.id;
          const host = g.white ? g.wp : g.bp;
          const hostId = g.white || g.black;
          const invited = g.invitee && g.invitee === me.id;
          return `<tr>
          <td><a href="#/profile/${hostId}">${U.esc(host ? host.username : "?")}</a>
              <span class="muted">(${host ? host.rating : "?"})</span>
              ${invited ? '<span class="badge active">вас приглашают</span>' : ""}</td>
          <td><b>${U.fmtTc(g.initial_ms, g.increment_ms)}</b></td>
          <td>${g.rated ? '<span class="badge rated">рейтинг</span>' : '<span class="badge">дружеская</span>'}</td>
          <td>${isHost
            ? `<a class="btn small" href="#/game/${g.id}">Открыть</a>`
            : `<button class="btn primary small" data-join="${g.id}">Принять</button>`}</td>
        </tr>`;
        });
      const sig = (data || []).filter(g => !g.invitee || g.invitee === me.id).map(g => g.id).join(",");
      if (box.dataset.sig === sig) return; // без изменений — не мерцаем и не перецепляем
      box.dataset.sig = sig;
      box.innerHTML = rows.length
        ? `<table class="lobby-list"><tr><th>Игрок</th><th>Контроль</th><th>Тип</th><th></th></tr>${rows.join("")}</table>`
        : `<div class="empty">Пока нет открытых вызовов — создайте свой!</div>`;
      U.qsa("[data-join]", box).forEach(b => b.addEventListener("click", async () => {
        const { data: gid, error } = await API.joinGame(b.dataset.join);
        if (error) return U.toast(error.message, "error");
        location.hash = `#/game/${b.dataset.join}`;
      }));
    }
    loadOpen();
    // открытые вызовы живут на realtime (INSERT+UPDATE: создание и присоединение);
    // поллинг тикает ТОЛЬКО пока websocket не поднялся; в скрытой вкладке спит
    let rtDebounce = null, _wasDown = false, rtChan = null;
    const rtRefresh = () => { clearTimeout(rtDebounce); rtDebounce = setTimeout(() => { loadOpen(); loadMyGames(); }, 300); };
    rtChan = API.subscribeInserts("games", null, rtRefresh, (status) => {
      if (status === "SUBSCRIBED" && _wasDown) { loadOpen(); loadMyGames(); } // доза-fetch после reconnect
      _wasDown = status !== "SUBSCRIBED";
    }, ["INSERT", "UPDATE"]);
    const openTimer = API.poll(5000, loadOpen, () => API.chUp(rtChan));
    const myTimer = API.poll(8000, loadMyGames, () => API.chUp(rtChan));
    const stopVisible = API.onVisible(() => { loadOpen(); loadMyGames(); });

    return function cleanup() {
      disposed = true;
      if (seekTimer) clearInterval(seekTimer);
      openTimer();
      myTimer();
      stopVisible();
      clearTimeout(rtDebounce);
      API.unsubscribe(rtChan);
      if (seeking) API.cancelSeek();
      cleanupFns.forEach(f => f());
    };
  };

  window.LobbyPage = { render: LobbyPage_render };
})();
