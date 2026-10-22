// Router and shell: navbar, session, ban banner. Pages render instantly
// before any network call; session and server time arrive in the
// background. Active menu highlighting is synchronous per navigation.
(function () {
  "use strict";

  // Theme: applied instantly by the inline head script, so here is only
  // the toggle and persistence.
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

    // instant active-menu highlight without network
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
        // redraw the navbar only on real changes to avoid auth-event flicker
        const sig = [this.profile.id, this.profile.username, this.profile.rating,
                     this.profile.is_banned ? 1 : 0, this.profile.role || "user"].join(":");
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

    // unread DM count shown as a navbar badge
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

    // supabase-js re-emits SIGNED_IN/TOKEN_REFRESHED on every tab focus;
    // a full rerender happens only when the user identity really changes.
    handleAuthEvent(evt, session) {
      const uid = session && session.user ? session.user.id : null;
      const prev = this._authUid;
      this._authUid = uid;
      const real =
        (evt === "SIGNED_OUT" && prev != null) ||
        ((evt === "SIGNED_IN" || evt === "USER_UPDATED") && uid !== prev && prev !== undefined);
      if (!real) {
        startHeartbeat(); // keep the heartbeat alive
        return;
      }
      API.invalidateBlocked();
      this.refreshNav().then(() => {
        startHeartbeat();
        this.refreshDmBadge();
        this.route(); // a real sign-in/out requires a rerender
      });
    },

    async route() {
      // email links carry the session in the hash; show the lobby while supabase-js picks it up
      if (/^#(access_token|error|error_description)=/.test(location.hash)) {
        location.hash = "#/";
        return;
      }
      this.updateNav(); // highlight immediately and synchronously
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
        else if (page === "clubs" || page === "club") await wrap(Community.club, arg); // "club" stays as a legacy alias
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
  // Online heartbeat every 30 s
  let hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (!App.user) return;
    const beat = () => API.rpc("heartbeat").catch(() => {});
    beat();
    hbTimer = setInterval(beat, 30000);
  }

  (async function init() {
    // theme is applied before first render; only the button lives here
    applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const tbtn = U.qs("#theme-toggle");
    if (tbtn) tbtn.addEventListener("click", toggleTheme);

    // arriving via a confirmation email link signs in without the login form
    const viaEmailLink = /access_token=/.test(location.hash);

    // instant page render without waiting for the network
    App.route();
    // session and server time load in the background
    ServerTime.sync().catch(() => {});
    await App.refreshNav();
    startHeartbeat();
    // if the instant render was a guest view but a session exists, rerender once
    if (App.user && (location.hash === "" || location.hash === "#/")) App.route();
    if (viaEmailLink && App.user) {
      U.toast("Email подтверждён — вы вошли автоматически", "good");
      try { history.replaceState(null, "", location.pathname + location.search + "#/"); } catch (e) {}
    }
    // unread DM badge refreshes periodically and idles in the background
    App.refreshDmBadge();
    API.poll(15000, () => App.refreshDmBadge());
    // quiet badge refresh when returning to the tab
    API.onVisible(() => App.refreshDmBadge());
    API.onAuth((evt, session) => App.handleAuthEvent(evt, session));
  })();
})();
