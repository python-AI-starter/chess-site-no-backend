// ============================================================
//  Страницы: вход/регистрация, профиль, лидерборд
// ============================================================
(function () {
  "use strict";

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
          Перейдите по ссылке из письма, затем войдите.</p>`);
        location.hash = "#/login";
      }
    }
  };

  // ---------- ПРОФИЛЬ ----------
  const ProfilePage_render = async function (container, userId) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = await API.user();
    const { data: p } = await API.sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">Профиль не найден</div>`; return () => {}; }
    const own = me && me.id === p.id;

    const { data: recent } = await API.sb.from("games")
      .select("id,white,black,result,winner,reason,status,initial_ms,increment_ms,rated,finished_at,created_at,wp:profiles!games_white_fkey(username),bp:profiles!games_black_fkey(username)")
      .or(`white.eq.${p.id},black.eq.${p.id}`)
      .eq("status", "finished")
      .order("finished_at", { ascending: false })
      .limit(15);

    const wld = p.games ? `(${p.wins}–${p.losses}–${p.draws})` : "";
    container.innerHTML = `
      <div class="card">
        <div class="row spread">
          <div class="row">
            <span class="avatar big">${U.esc((p.username || "?")[0].toUpperCase())}</span>
            <div>
              <h2 style="margin:0">${U.esc(p.username)} ${p.is_banned ? '<span class="badge danger">заблокирован</span>' : ""}</h2>
              <span class="muted small">На сайте с ${U.fmtDate(p.created_at)}</span>
            </div>
          </div>
          ${own ? `<button class="btn" id="p-rename">Сменить ник</button>` : ""}
        </div>
        <div class="stat-cards" style="margin-top:16px">
          <div class="stat-card"><b>${p.rating}</b><span>Рейтинг Эло</span></div>
          <div class="stat-card"><b>${p.games}</b><span>Партий ${wld}</span></div>
          <div class="stat-card"><b>${p.games ? Math.round(100 * p.wins / p.games) : 0}%</b><span>Побед</span></div>
        </div>
      </div>
      <div class="card">
        <h2>Последние партии</h2>
        <div id="recent"></div>
      </div>`;

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
    return () => {};
  };

  // ---------- ЛИДЕРБОРД ----------
  const LeaderboardPage_render = async function (container) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data } = await API.sb.from("profiles")
      .select("id,username,rating,games,wins,losses,draws,is_banned")
      .order("rating", { ascending: false })
      .limit(50);
    container.innerHTML = `
      <div class="card">
        <h2>Лидерборд</h2>
        ${(data || []).length ? `<table class="lb-table">
          <tr><th>#</th><th>Игрок</th><th class="rt">Рейтинг</th><th class="rt">Партий</th><th class="rt">Победы</th></tr>
          ${data.filter(p => !p.is_banned).map((p, i) => `
            <tr><td class="muted"><span class="rank-num">${i + 1}</span></td>
            <td><a href="#/profile/${p.id}">${U.esc(p.username)}</a></td>
            <td class="rt"><b>${p.rating}</b></td>
            <td class="rt">${p.games}</td>
            <td class="rt">${p.wins}</td></tr>`).join("")}
        </table>` : `<div class="empty">Пока никто не играл</div>`}
      </div>`;
    return () => {};
  };

  window.Pages = {
    login: LoginPage_render,
    signup: SignupPage_render,
    profile: ProfilePage_render,
    leaderboard: LeaderboardPage_render
  };
})();
