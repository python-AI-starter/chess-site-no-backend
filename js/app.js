// ============================================================
//  Роутер + каркас (навбар, сессия, баннер бана)
//  Страница рендерится МГНОВЕННО (до сетевых вызовов), сессия
//  и время сервера подтягиваются в фоне. Подсветка активного
//  пункта меню — чистый клиент, синхронно на каждый переход.
// ============================================================
(function () {
  "use strict";

  // ---------- тема (светлая/тёмная) ----------
  // Применение — мгновенно (инлайн-скрипт в <head> до отрисовки),
  // тут только переключатель и сохранение выбора.
  function applyTheme(t) {
    document.documentElement.classList.toggle("dark", t === "dark");
    const b = U.qs("#theme-toggle");
    if (b) b.textContent = t === "dark" ? "☀" : "☾";
  }
  function toggleTheme() {
    const t = document.documentElement.classList.contains("dark") ? "light" : "dark";
    try { localStorage.setItem("ladya-theme", t); } catch (e) {}
    applyTheme(t);
  }

  const App = {
    cleanup: null,
    user: null,
    profile: null,
    _routedOnce: false,

    // мгновенная подсветка активного пункта меню (без сети)
    updateNav() {
      const page = (location.hash || "#/").replace(/^#\//, "").split("/")[0] || "lobby";
      U.qsa("#nav-links a").forEach(a =>
        a.classList.toggle("active", a.dataset.nav === page));
    },

    async refreshNav() {
      this.user = await API.user();
      this.profile = this.user ? await API.profile(this.user.id) : null;
      const box = U.qs("#nav-user");
      const ban = U.qs("#ban-banner");
      if (this.profile) {
        // перерисовывать навбар только при реальных изменениях — без мерцания
        // при возврате во вкладку (supabase шлёт повторные SIGNED_IN/TOKEN_REFRESHED)
        const sig = [this.profile.id, this.profile.username, this.profile.rating,
                     this.profile.is_banned ? 1 : 0].join(":");
        if (box.dataset.sig !== sig) {
          box.dataset.sig = sig;
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
        }
        if (this.profile.is_banned) {
          ban.textContent = `Аккаунт заблокирован навсегда: ${this.profile.ban_reason || "нарушение правил"}. Играть и писать нельзя.`;
          ban.classList.remove("hidden");
        } else ban.classList.add("hidden");
      } else {
        if (box.dataset.sig !== "guest") {
          box.dataset.sig = "guest";
          box.innerHTML = `<a class="nav-login" href="#/login">Войти</a>
            <a class="btn primary nav-signup" href="#/signup">Регистрация</a>`;
        }
        ban.classList.add("hidden");
      }
    },

    // непрочитанные личные сообщения -> бейдж в меню
    async refreshDmBadge() {
      const b = U.qs("#dm-badge");
      if (!b) return;
      if (!this.user) { b.classList.add("hidden"); return; }
      const { count, error } = await API.sb.from("dm_messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", this.user.id).is("read_at", null);
      if (error) return;
      const txt = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
      if (b.textContent !== txt) { b.textContent = txt; b.classList.toggle("hidden", !count); }
    },

    // ---------- ЗАЩИТА ОТ ПЕРЕРИСОВКИ ПРИ ВОЗВРАТЕ ВО ВКЛАДКУ ----------
    // supabase-js при каждом visibilitychange->visible вызывает
    // _recoverAndRefresh() и ПОВТОРНО эмитит SIGNED_IN/TOKEN_REFRESHED.
    // Раньше на SIGNED_IN мы делали App.route() — вся страница
    // перерисовывалась при каждом переключении вкладок. Теперь полное
    // обновление происходит ТОЛЬКО при реальной смене пользователя.
    handleAuthEvent(evt, session) {
      const uid = session && session.user ? session.user.id : null;
      const prev = this._authUid;
      this._authUid = uid;
      const real =
        (evt === "SIGNED_OUT" && prev != null) ||
        ((evt === "SIGNED_IN" || evt === "USER_UPDATED") && uid !== prev && prev !== undefined);
      if (!real) {
        startHeartbeat(); // просто убедиться, что пульс жив
        return;
      }
      API.invalidateBlocked();
      this.refreshNav().then(() => {
        startHeartbeat();
        this.refreshDmBadge();
        this.route(); // реальный вход/выход — страница обязана перерисоваться
      });
    },

    async route() {
      // ссылка из письма несёт сессию в хэше (#access_token=...) — это не
      // маршрут: показываем лобби, пока supabase-js не подхватит сессию
      if (/^#(access_token|error|error_description)=/.test(location.hash)) {
        location.hash = "#/";
        return;
      }
      this.updateNav(); // подсветка — сразу и синхронно
      const app = U.qs("#app");
      if (this.cleanup) { try { this.cleanup(); } catch (e) {} this.cleanup = null; }
      const hash = location.hash || "#/";
      const parts = hash.replace(/^#\//, "").split("/").filter(Boolean);
      const page = parts[0] || "";
      const arg = parts[1] || null;

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
        else if (page === "dm" && !arg) await wrap(Social.messages);
        else if (page === "dm") await wrap(Social.thread, arg);
        else app.innerHTML = `<div class="card center"><h2>404</h2><p><a href="#/">На главную</a></p></div>`;
      } catch (e) {
        console.error(e);
        app.innerHTML = `<div class="card center"><h2>Ошибка</h2><p class="muted">${U.esc(e.message || e)}</p></div>`;
      }
      this.refreshDmBadge();
      window.scrollTo(0, 0);
    }
  };

  window.addEventListener("hashchange", () => App.route());
  window.App = App;
  // ---------- онлайн-пульс: heartbeat раз в 30 с ----------
  let hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (!App.user) return;
    const beat = () => API.rpc("heartbeat").catch(() => {});
    beat();
    hbTimer = setInterval(beat, 30000);
  }

  (async function init() {
    // тема — до первого рендера (инлайн в index.html), здесь только кнопка
    applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const tbtn = U.qs("#theme-toggle");
    if (tbtn) tbtn.addEventListener("click", toggleTheme);

    // переход по ссылке подтверждения почты — автовход без логина
    const viaEmailLink = /access_token=/.test(location.hash);

    // 1) мгновенный рендер страницы — без ожидания сети
    App.route();
    // 2) сессия и серверное время — в фоне
    ServerTime.sync().catch(() => {});
    await App.refreshNav();
    startHeartbeat();
    // если на мгновенный рендер гость смотрел «гостевую» страницу,
    // а сессия нашлась — перерисовать один раз уже с известным входом
    if (App.user && (location.hash === "" || location.hash === "#/")) App.route();
    if (viaEmailLink && App.user) {
      U.toast("Email подтверждён — вы вошли автоматически", "good");
      try { history.replaceState(null, "", location.pathname + location.search + "#/"); } catch (e) {}
    }
    // 3) бейдж непрочитанных ЛС — обновлять по кругу (в фоне — спит)
    App.refreshDmBadge();
    API.poll(15000, () => App.refreshDmBadge());
    // возврат во вкладку — тихо обновить бейдж (без перерисовки страницы)
    API.onVisible(() => App.refreshDmBadge());
    API.onAuth((evt, session) => App.handleAuthEvent(evt, session));
  })();
})();
