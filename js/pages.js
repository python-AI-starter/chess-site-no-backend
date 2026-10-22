// ============================================================
//  Страницы: вход/регистрация, профиль, лидерборд
//  Рейтинг: онлайн-пульс, вызов игрока, последние партии
//  с перемоткой ходов (реплей).
// ============================================================
(function () {
  "use strict";

  // онлайн: heartbeat раз в 30 с + запас
  function isOnline(p) {
    if (!p || !p.last_seen_at) return false;
    return (ServerTime.now() - U.parseTs(p.last_seen_at)) < 75000;
  }

  const dotHtml = (p) =>
    `<span class="online-dot ${isOnline(p) ? "" : "off"}" title="${isOnline(p) ? "онлайн" : "офлайн"}"></span>`;

  // ---------- ВХОД ----------
  const LoginPage_render = function (container) {
    container.innerHTML = `
      <div class="card" style="max-width:420px;margin:30px auto">
        <h2>Вход</h2>
        <label>Email</label><input id="l-email" type="email" autocomplete="email">
        <label>Пароль</label><input id="l-pass" type="password" autocomplete="current-password">
        <div class="err" id="l-err"></div>
        <button class="btn primary block" id="l-go">Войти</button>
        <p class="small" style="margin-top:14px">Нет аккаунта? <a href="#/signup">Регистрация</a>
          · <a href="#" id="l-reset">Забыли пароль?</a></p>
      </div>`;
    U.qs("#l-go").addEventListener("click", doLogin);
    U.qs("#l-pass").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
    U.qs("#l-reset").addEventListener("click", async (e) => {
      e.preventDefault();
      const email = U.qs("#l-email").value.trim();
      if (!email) return U.toast("Введите email сверху", "error");
      const { error } = await API.resetPassword(email);
      U.toast(error ? error.message : "Письмо для восстановления отправлено", error ? "error" : "good");
    });
    async function doLogin() {
      const email = U.qs("#l-email").value.trim();
      const pass = U.qs("#l-pass").value;
      const { error } = await API.signIn(email, pass);
      if (error) { U.qs("#l-err").textContent = error.message; return; }
      U.toast("Вход выполнен", "good");
      location.hash = "#/";
      App.refreshNav();
    }
  };

  // ---------- РЕГИСТРАЦИЯ ----------
  const SignupPage_render = function (container) {
    container.innerHTML = `
      <div class="card" style="max-width:420px;margin:30px auto">
        <h2>Регистрация</h2>
        <label>Ник (латиница, 2–20)</label><input id="s-user" maxlength="20">
        <label>Email</label><input id="s-email" type="email">
        <label>Пароль (мин. 6)</label><input id="s-pass" type="password">
        <div class="err" id="s-err"></div>
        <button class="btn primary block" id="s-go">Создать аккаунт</button>
        <p class="small" style="margin-top:14px">Уже есть аккаунт? <a href="#/login">Вход</a></p>
      </div>`;
    U.qs("#s-go").addEventListener("click", doSignup);
    async function doSignup() {
      const username = U.qs("#s-user").value.trim();
      const email = U.qs("#s-email").value.trim();
      const pass = U.qs("#s-pass").value;
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
        U.qs("#s-err").textContent = "Ник: 2-20 символов, латиница, цифры, _ и -"; return;
      }
      const { data, error } = await API.signUp(email, pass, username);
      if (error) { U.qs("#s-err").textContent = error.message; return; }
      if (data.session) {
        U.toast("Аккаунт создан", "good");
        location.hash = "#/";
        App.refreshNav();
      } else {
        U.infoModal(`<h3>Подтвердите email</h3>
          <p>Мы отправили письмо на <b>${U.esc(email)}</b>.
          Перейдите по ссылке из письма — <b>вы войдёте на сайт автоматически</b>,
          вводить логин и пароль не нужно.</p>
          <p class="muted small">Если сайт открыт по другому адресу, ссылка приведёт
          на <b>http://localhost:3000</b> — запускайте сайт на этом порту
          (например, <code>python -m http.server 3000</code>).</p>`);
        location.hash = "#/login";
      }
    }
  };

  // ---------- ВЫЗОВ ИГРОКА (общая модалка) ----------
  const TC_OPTIONS = [
    [60000, 0, "1+0 · Пуля"], [120000, 1000, "2+1 · Пуля"],
    [180000, 0, "3+0 · Блиц"], [180000, 2000, "3+2 · Блиц"], [300000, 0, "5+0 · Блиц"],
    [600000, 0, "10+0 · Быстрые"], [900000, 10000, "15+10 · Быстрые"],
    [1800000, 0, "30+0 · Классика"], [1800000, 20000, "30+20 · Классика"]
  ];

  async function challengeModal(target) {
    const res = await U.formModal(`Вызов: ${target.username}`, [
      { id: "tc", label: "Контроль времени", type: "select",
        value: "600000|0",
        options: TC_OPTIONS.map(o => ({ v: `${o[0]}|${o[1]}`, l: o[2] })) },
      { id: "color", label: "Ваш цвет", type: "select", value: "random",
        options: [{ v: "random", l: "Случайный" }, { v: "white", l: "Белые" }, { v: "black", l: "Чёрные" }] },
      { id: "rated", label: "Тип партии", type: "select", value: "1",
        options: [{ v: "1", l: "Рейтинговая" }, { v: "0", l: "Товарищеская" }] }
    ], "Вызвать");
    if (!res) return;
    const [ms, inc] = res.tc.split("|").map(Number);
    const rated = res.rated === "1";
    const { data: gid, error } = await API.createChallenge(ms, inc, rated, res.color, target.id);
    if (error) return U.toast(error.message, "error");
    // приглашение в личку (не критично, если не уйдёт)
    API.sendDm(target.id,
      `⚔ Вызываю вас на партию ${U.fmtTc(ms, inc)} (${rated ? "рейтинговая" : "товарищеская"}). ` +
      `Принять: #/game/${gid}`)
      .then(({ error: e2 }) => { if (e2) console.warn(e2.message); });
    U.toast("Вызов отправлен — игрок получит личное сообщение", "good");
    location.hash = `#/game/${gid}`;
  }

  // ---------- ПРОФИЛЬ ----------
  const ProfilePage_render = async function (container, userId) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = await API.user();
    const { data: p } = await API.sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">Профиль не найден</div>`; return () => {}; }
    const own = me && me.id === p.id;
    // заблокирован ли этот игрок мною (для UI; сервер всё равно проверит)
    let iBlocked = false;
    if (me && !own) {
      const { data: blk } = await API.sb.from("blocked_users")
        .select("blocked_id").eq("blocked_id", p.id).maybeSingle();
      iBlocked = !!blk;
    }

    const { data: recent } = await API.sb.from("games")
      .select("id,white,black,result,winner,reason,status,initial_ms,increment_ms,rated,finished_at,created_at,wp:profiles!games_white_fkey(username),bp:profiles!games_black_fkey(username)")
      .or(`white.eq.${p.id},black.eq.${p.id}`)
      .eq("status", "finished")
      .order("finished_at", { ascending: false })
      .limit(15);

    const wld = p.games ? `(${p.wins}–${p.losses}–${p.draws})` : "";
    const myProfile = App.profile || (me ? await API.profile(me.id) : null);
    const iAmMod = myProfile && (myProfile.role === "creator" || myProfile.role === "admin");
    // модерация чужого профиля: создателя трогать нельзя, админа — только создателю
    const canModerate = iAmMod && !own && p.role !== "creator" &&
                        !(p.role === "admin" && myProfile.role !== "creator");
    container.innerHTML = `
      <div class="card">
        <div class="row spread">
          <div class="row">
            <span class="avatar big">${U.esc((p.username || "?")[0].toUpperCase())}</span>
            <div>
              <h2 style="margin:0">${U.esc(p.username)} ${U.roleBadge(p.role)} ${dotHtml(p)} ${p.is_banned ? '<span class="badge danger">заблокирован</span>' : ""}</h2>
              <span class="muted small">На сайте с ${U.fmtDate(p.created_at)}</span>
            </div>
          </div>
          <div class="row">
            ${!own && me && !iBlocked ? `<button class="btn" id="p-dm">✉ Написать</button>
                            <button class="btn primary" id="p-challenge">⚔ Вызвать</button>` : ""}
            ${!own && me ? `<button class="btn ghost" id="p-block" title="Заблокированный не сможет писать и вызывать">${iBlocked ? "✓ Разблокировать" : "🚫 Заблокировать"}</button>` : ""}
            ${own ? `<button class="btn" id="p-rename">Сменить ник</button>` : ""}
          </div>
        </div>
        <div class="stat-cards" style="margin-top:16px">
          <div class="stat-card"><b>${p.rating}</b><span>Общий Эло</span></div>
          <div class="stat-card"><b>${p.rating_bullet ?? 1000}</b><span>Пуля</span></div>
          <div class="stat-card"><b>${p.rating_blitz ?? 1000}</b><span>Блиц</span></div>
          <div class="stat-card"><b>${p.rating_rapid ?? 1000}</b><span>Быстрые</span></div>
          <div class="stat-card"><b>${p.rating_classic ?? 1000}</b><span>Классика</span></div>
          <div class="stat-card"><b>${p.games}</b><span>Партий ${wld}</span></div>
          <div class="stat-card"><b>${p.games ? Math.round(100 * p.wins / p.games) : 0}%</b><span>Побед</span></div>
        </div>
      </div>
      ${canModerate ? `
      <div class="card mod-panel">
        <h3>🛡 Модерация${p.role === "admin" ? " (админ)" : ""}</h3>
        <div class="row wrap">
          <button class="btn" id="mod-mute">🔇 Мут (15 мин по умолч.)</button>
          <button class="btn ghost" id="mod-unmute" title="Снять действующий мут">✓ Снять мут</button>
          <button class="btn" id="mod-role">Статус: сейчас «${p.role === "admin" ? "админ" : "игрок"}»</button>
          ${p.is_banned
            ? `<button class="btn" id="mod-ban">✓ Разбанить</button>`
            : `<button class="btn danger" id="mod-ban">🚫 Забанить</button>`}
          <button class="btn danger" id="mod-delacc">🗑 Удалить аккаунт</button>
        </div>
        <p class="muted small">Мут запрещает публичные сообщения (чаты/форум/блог), партии и ЛС не трогает. Удаление аккаунта и бан — с двойным подтверждением.</p>
      </div>` : ""}
      <div class="card">
        <h2>Последние партии</h2>
        <div id="recent"></div>
      </div>
      ${own ? `<div class="card"><h3>Заблокированные игроки</h3>
        <p class="muted small">Они не могут вам писать и вызывать. Список виден только вам.</p>
        <div id="blocked-list"><span class="spinner"></span></div></div>` : ""}`;

    if (!own && me) {
      const dmBtn = U.qs("#p-dm");
      if (dmBtn) dmBtn.addEventListener("click", () => { location.hash = `#/dm/${p.id}`; });
      const chBtn = U.qs("#p-challenge");
      if (chBtn) chBtn.addEventListener("click", () => challengeModal(p));
      U.qs("#p-block").addEventListener("click", async () => {
        const btn = U.qs("#p-block");
        btn.disabled = true;
        const { error } = iBlocked ? await API.unblockUser(p.id) : await API.blockUser(p.id);
        if (error) { btn.disabled = false; return U.toast(error.message, "error"); }
        API.invalidateBlocked();
        U.toast(iBlocked ? "Игрок разблокирован" : "Игрок заблокирован — сообщения и вызовы от него больше не придут", "good");
        App.route();
      });
    }
    if (own) {
      U.qs("#p-rename").addEventListener("click", async () => {
        const res = await U.formModal("Сменить ник", [
          { id: "name", label: "Новый ник (2–20, латиница, цифры, _ и -)",
            value: p.username, maxlength: 20, placeholder: "Ваш ник" }
        ], "Сохранить");
        if (!res) return;
        const name = res.name.trim();
        if (!name || name === p.username) return;
        const { error } = await API.setUsername(name);
        if (error) U.toast(error.message, "error");
        else { U.toast("Ник обновлён", "good"); App.route(); }
      });
    }

    // ---------- модерация профиля (только creator/admin; роли проверяет БД) ----------
    if (canModerate) {
      const modMute = U.qs("#mod-mute");
      if (modMute) modMute.addEventListener("click", async () => {
        const res = await U.formModal("Мут игрока " + p.username, [
          { id: "mins", label: "Минут (1–10080)", value: "15", type: "text" },
          { id: "reason", label: "Причина (необязательно)", maxlength: 200, placeholder: "спам" }
        ], "Замутить");
        if (!res) return;
        const mins = Math.round(Number(res.mins));
        if (!(mins >= 1 && mins <= 10080)) return U.toast("Минуты: от 1 до 10080", "error");
        const { error } = await API.adminMute(p.id, mins, res.reason.trim());
        if (error) U.toast(error.message, "error");
        else U.toast(`${p.username} замучен на ${mins} мин (чаты/форум/блог)`, "good");
      });
      const modUnmute = U.qs("#mod-unmute");
      if (modUnmute) modUnmute.addEventListener("click", async () => {
        const { error } = await API.adminUnmute(p.id);
        if (error) U.toast(error.message, "error");
        else U.toast("Мут снят (если был)", "good");
      });
      const modBan = U.qs("#mod-ban");
      if (modBan) modBan.addEventListener("click", async () => {
        if (p.is_banned) {
          if (!(await U.confirmModal("Разбанить игрока?", p.username, "Разбанить"))) return;
          const { error } = await API.adminUnban(p.id);
          if (error) U.toast(error.message, "error");
          else { U.toast("Разбанен", "good"); App.route(); }
        } else {
          const res = await U.formModal("Бан игрока " + p.username, [
            { id: "reason", label: "Причина (необязательно)", maxlength: 200, placeholder: "нарушение правил" }
          ], "Забанить");
          if (!res) return;
          if (!(await U.confirmDanger("Забанить " + p.username + "?",
              "Игрок потеряет возможность играть и писать. Его активные партии завершатся техническим поражением.",
              "Забанить"))) return;
          const { error } = await API.adminBan(p.id, res.reason.trim());
          if (error) U.toast(error.message, "error");
          else { U.toast("Игрок забанен", "good"); App.route(); }
        }
      });
      const modRole = U.qs("#mod-role");
      if (modRole) modRole.addEventListener("click", async () => {
        const res = await U.formModal("Статус игрока " + p.username, [
          { id: "role", label: "Новый статус", type: "select", value: p.role,
            options: [
              { v: "user", l: "Игрок (user)" },
              { v: "admin", l: "Админ (модерация)" },
              { v: "creator", l: "Создатель (полные права)" }
            ] }
        ], "Назначить");
        if (!res || res.role === p.role) return;
        const { error } = await API.adminSetRole(p.id, res.role);
        if (error) U.toast(error.message, "error");
        else { U.toast("Статус обновлён", "good"); App.route(); }
      });
      const modDel = U.qs("#mod-delacc");
      if (modDel) modDel.addEventListener("click", async () => {
        if (!(await U.confirmDanger("Удалить аккаунт " + p.username + "?",
            "Будут удалены профиль, все его партии, сообщения, клубы и блог. Отменить невозможно.",
            "Удалить аккаунт"))) return;
        const { error } = await API.adminDeleteAccount(p.id);
        if (error) U.toast(error.message, "error");
        else { U.toast("Аккаунт удалён", "good"); location.hash = "#/"; }
      });
    }

    const rec = U.qs("#recent");
    if (!recent || !recent.length) {
      rec.innerHTML = `<div class="empty">Партий пока нет</div>`;
    } else {
      rec.innerHTML = recent.map(g => {
        const iAmWhite = g.white === p.id;
        const opp = iAmWhite ? g.bp : g.wp;
        let res = "<span class='muted'>—</span>";
        if (g.winner) res = g.winner === p.id
          ? "<b style='color:var(--good)'>1</b>"
          : "<b style='color:var(--bad)'>0</b>";
        else res = "<b>½</b>";
        return `<div class="list-item">
          <span style="width:20px">${res}</span>
          <span><b>${U.fmtTc(g.initial_ms, g.increment_ms)}</b> ${g.rated ? '<span class="badge rated">рейтинг</span>' : ""}</span>
          <span>против <a href="#/profile/${iAmWhite ? g.black : g.white}">${U.esc(opp ? opp.username : "?")}</a></span>
          <span class="muted small">${U.fmtDate(g.finished_at)}</span>
          <a href="#/game/${g.id}">открыть</a>
        </div>`;
      }).join("");
    }
    // карточка заблокированных (только свой профиль)
    if (own) {
      const bl = U.qs("#blocked-list");
      const { data: blockedRows } = await API.sb.from("blocked_users")
        .select("blocked_id, created_at, bp:profiles!blocked_users_blocked_id_fkey(id,username,rating)")
        .order("created_at", { ascending: false });
      bl.innerHTML = (blockedRows || []).length ? (blockedRows || []).map(b => `
        <div class="list-item">
          <span class="avatar">${U.esc((b.bp && b.bp.username || "?")[0].toUpperCase())}</span>
          <div style="flex:1">
            <a href="#/profile/${b.blocked_id}"><b>${U.esc(b.bp ? b.bp.username : "?")}</b></a>
            <div class="muted small">с ${U.fmtDate(b.created_at)}</div>
          </div>
          <button class="btn ghost small" data-unblock="${b.blocked_id}">Разблокировать</button>
        </div>`).join("") : `<div class="empty">Список пуст</div>`;
      U.qsa("[data-unblock]", bl).forEach(btn => btn.addEventListener("click", async () => {
        const { error } = await API.unblockUser(btn.dataset.unblock);
        if (error) return U.toast(error.message, "error");
        API.invalidateBlocked();
        U.toast("Разблокирован", "good");
        App.route();
      }));
    }
    return () => {};
  };

  // ---------- ЛИДЕРБОРД (пулы: пуля / блиц / быстрые / классика) ----------
  let openReplay = null; // единственный раскрытый реплей
  const POOLS = [
    { key: "bullet",  label: "Пуля",     col: "rating_bullet",  games: "games_bullet" },
    { key: "blitz",   label: "Блиц",     col: "rating_blitz",   games: "games_blitz" },
    { key: "rapid",   label: "Быстрые",  col: "rating_rapid",   games: "games_rapid" },
    { key: "classic", label: "Классика", col: "rating_classic", games: "games_classic" }
  ];

  function currentPool() {
    const k = localStorage.getItem("ladya-pool");
    return POOLS.find(p => p.key === k) || POOLS[0];
  }

  async function expandReplay(slot, gameId) {
    slot.innerHTML = `<div class="center" style="padding:10px"><span class="spinner"></span> Загрузка…</div>`;
    // ходы и стартовая позиция берутся напрямую из таблицы — позиции после
    // каждого полухода считает chess.js на клиенте (RPC get_replay не нужен)
    const { data, error } = await API.sb.from("games")
      .select("start_fen,moves").eq("id", gameId).maybeSingle();
    if (error || !data) {
      slot.innerHTML = `<div class="empty">Не удалось загрузить партию</div>`;
      return;
    }
    const fens = [];
    try {
      const c = new window.Chess(data.start_fen);
      for (const m of (data.moves || [])) {
        c.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4),
                 promotion: m.u.length === 5 ? m.u[4] : undefined });
        fens.push(c.fen());
      }
    } catch (e) {
      slot.innerHTML = `<div class="empty">Не удалось восстановить партию</div>`;
      return;
    }
    slot.innerHTML = "";
    const wrap = document.createElement("div");
    slot.appendChild(wrap);
    openReplay = new ChessReplay(wrap, {
      replay: { ok: true, start_fen: data.start_fen, fens, moves: data.moves || [] },
      orientation: "white", keyboard: true
    });
  }

  const LeaderboardPage_render = async function (container) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = App.user || await API.user();
    const pool = currentPool();
    const [{ data }, { data: recent }] = await Promise.all([
      API.sb.from("profiles")
        .select(`id,username,rating,games,wins,losses,draws,is_banned,last_seen_at,${pool.col},${pool.games}`)
        .order(pool.col, { ascending: false }).limit(50),
      API.sb.from("games")
        .select("id,white,black,result,winner,initial_ms,increment_ms,rated,finished_at,wp:profiles!games_white_fkey(username),bp:profiles!games_black_fkey(username)")
        .eq("status", "finished")
        .order("finished_at", { ascending: false }).limit(12)
    ]);

    const tabs = `<div class="pool-tabs">` + POOLS.map(p =>
      `<button class="pool-tab ${p.key === pool.key ? "active" : ""}" data-pool="${p.key}">${p.label}</button>`
    ).join("") + `</div>`;

    const rows = (data || []).filter(p => !p.is_banned).map((p, i) => `
      <tr>
        <td class="muted"><span class="rank-num">${i + 1}</span></td>
        <td><span class="lb-player">${dotHtml(p)}
          <a href="#/profile/${p.id}">${U.esc(p.username)}</a></span></td>
        <td class="rt"><b>${p[pool.col]}</b></td>
        <td class="rt">${p[pool.games]}</td>
        <td class="rt">${me && me.id !== p.id
          ? `<button class="btn small" data-chal="${p.id}">⚔ Вызов</button>` : ""}</td>
      </tr>`).join("");

    container.innerHTML = `
      <div class="card">
        <h2>Лидерборд</h2>
        ${tabs}
        ${rows ? `<table class="lb-table">
          <tr><th>#</th><th>Игрок</th><th class="rt">Рейтинг · ${pool.label}</th><th class="rt">Партий</th><th></th></tr>
          ${rows}
        </table>` : `<div class="empty">Пока никто не играл</div>`}
      </div>
      <div class="card">
        <h2>Последние партии</h2>
        <p class="muted small">Откройте партию и перематывайте ходы кнопками или стрелками ← →.</p>
        <div id="lb-games">${renderRecent(recent || [])}</div>
      </div>`;

    // переключение пулов — перерисовка таблицы
    U.qsa(".pool-tab", container).forEach(b =>
      b.addEventListener("click", () => {
        localStorage.setItem("ladya-pool", b.dataset.pool);
        Pages.leaderboard(container).catch(console.error);
      }));

    // кнопки вызова
    const byId = {};
    (data || []).forEach(p => { byId[p.id] = p; });
    U.qsa("[data-chal]", container).forEach(b =>
      b.addEventListener("click", () => {
        const p = byId[b.dataset.chal];
        if (p) challengeModal(p);
      }));

    // раскрытие реплеев
    U.qsa("[data-watch]", container).forEach(b =>
      b.addEventListener("click", () => {
        const slot = U.qs(`#rp-${b.dataset.watch}`, container);
        if (!slot) return;
        if (!slot.classList.contains("hidden")) {
          slot.classList.add("hidden");
          b.textContent = "Смотреть ▸";
          if (openReplay) { openReplay.destroy(); openReplay = null; }
          return;
        }
        U.qsa(".rp-slot", container).forEach(s => s.classList.add("hidden"));
        U.qsa("[data-watch]", container).forEach(x => x.textContent = "Смотреть ▸");
        if (openReplay) { openReplay.destroy(); openReplay = null; }
        slot.classList.remove("hidden");
        b.textContent = "Свернуть ▴";
        expandReplay(slot, b.dataset.watch);
      }));

    return () => {
      if (openReplay) { openReplay.destroy(); openReplay = null; }
    };
  }

  function renderRecent(games) {
    if (!games.length) return `<div class="empty">Партий пока нет</div>`;
    return games.map(g => `
      <div class="lb-game">
        <div class="list-item">
          <span class="badge ${g.result === "1-0" ? "rated" : g.result === "0-1" ? "danger" : "finished"}">
            ${g.result === "1-0" ? "1–0" : g.result === "0-1" ? "0–1" : "½–½"}</span>
          <span style="flex:1;min-width:0">
            <a href="#/profile/${g.white}">${U.esc(g.wp ? g.wp.username : "?")}</a>
            <span class="muted"> — </span>
            <a href="#/profile/${g.black}">${U.esc(g.bp ? g.bp.username : "?")}</a>
            <span class="muted small">· ${U.fmtTc(g.initial_ms, g.increment_ms)}${g.rated ? " · рейтинг" : ""} · ${U.fmtDate(g.finished_at)}</span>
          </span>
          <a class="btn small" href="#/game/${g.id}">Партия</a>
          <button class="btn small" data-watch="${g.id}">Смотреть ▸</button>
        </div>
        <div class="rp-slot hidden" id="rp-${g.id}"></div>
      </div>`).join("");
  }

  window.Pages = {
    login: LoginPage_render,
    signup: SignupPage_render,
    profile: ProfilePage_render,
    leaderboard: LeaderboardPage_render,
    isOnline
  };
})();
