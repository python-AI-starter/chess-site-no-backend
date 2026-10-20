// ============================================================
//  Роутер + каркас (навбар, сессия, баннер бана)
// ============================================================
(function () {
  "use strict";

  const App = {
    cleanup: null,
    user: null,
    profile: null,

    async refreshNav() {
      this.user = await API.user();
      this.profile = this.user ? await API.profile(this.user.id) : null;
      const box = U.qs("#nav-user");
      const ban = U.qs("#ban-banner");
      if (this.profile) {
        box.innerHTML = `
          <a class="rchip" href="#/profile/${this.profile.id}">
            <span class="avatar" style="width:26px;height:26px;font-size:13px">
              ${U.esc((this.profile.username || "?")[0].toUpperCase())}</span>
            ${U.esc(this.profile.username)} <b>${this.profile.rating}</b>
          </a>
          <a href="#" id="logout">Выйти</a>`;
        U.qs("#logout").addEventListener("click", async (e) => {
          e.preventDefault();
          await API.signOut();
          App.refreshNav().then(() => { location.hash = "#/"; App.route(); });
        });
        if (this.profile.is_banned) {
          ban.textContent = `Аккаунт заблокирован навсегда: ${this.profile.ban_reason || "нарушение правил"}. Играть и писать нельзя.`;
          ban.classList.remove("hidden");
        } else ban.classList.add("hidden");
      } else {
        box.innerHTML = `<a href="#/login">Войти</a> <a class="btn primary" style="padding:6px 14px" href="#/signup">Регистрация</a>`;
        ban.classList.add("hidden");
      }
      // подсветка активного пункта
      const page = (location.hash || "#/").split("/")[1] || "lobby";
      U.qsa("#nav-links a").forEach(a =>
        a.classList.toggle("active", a.dataset.nav === page));
    },

    async route() {
      const app = U.qs("#app");
      if (this.cleanup) { try { this.cleanup(); } catch (e) {} this.cleanup = null; }
      const hash = location.hash || "#/";
      const parts = hash.replace(/^#\//, "").split("/").filter(Boolean);
      const page = parts[0] || "";
      const arg = parts[1] || null;

      if (this.profile && this.profile.is_banned && page !== "profile" && page !== "") {
        // забаненный может смотреть лобби и профиль, но не играть/писать —
        // сервер всё равно не пустит; здесь просто предупреждение в шапке
      }

      const wrap = async (fn, ...args) => { this.cleanup = await fn(app, ...args); };

      try {
        if (page === "") await wrap(LobbyPage.render);
        else if (page === "game") await wrap(GamePage.render, arg);
        else if (page === "login") await wrap(Pages.login);
        else if (page === "signup") await wrap(Pages.signup);
        else if (page === "profile") await wrap(Pages.profile, arg || (this.profile && this.profile.id));
        else if (page === "leaderboard") await wrap(Pages.leaderboard);
        else if (page === "forum" && !arg) await wrap(Community.forum);
        else if (page === "forum") await wrap(Community.thread, arg);
        else if (page === "clubs" && !arg) await wrap(Community.clubs);
        else if (page === "clubs" || page === "club") await wrap(Community.club, arg); // «club» — алиас старых ссылок
        else if (page === "blog" && !arg) await wrap(Community.blog);
        else if (page === "blog" && arg === "new") await wrap(Community.blogNew);
        else if (page === "blog") await wrap(Community.blogPost, arg);
        else app.innerHTML = `<div class="card center"><h2>404</h2><p><a href="#/">На главную</a></p></div>`;
      } catch (e) {
        console.error(e);
        app.innerHTML = `<div class="card center"><h2>Ошибка</h2><p class="muted">${U.esc(e.message || e)}</p></div>`;
      }
      window.scrollTo(0, 0);
    }
  };

  window.addEventListener("hashchange", () => App.route());
  window.App = App;

  (async function init() {
    await App.refreshNav();
    await ServerTime.sync();
    App.route();
    API.onAuth(() => App.refreshNav());
  })();
})();
