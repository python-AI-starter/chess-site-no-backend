// Router and shell: navbar, session, ban banner. Pages render instantly
// before any network call; session and server time arrive in the
// background. Active menu highlighting is synchronous per navigation.
//
// Routing uses the History API, so every tab lives on a clean path
// (/forum, /dm, /game/<id>) with no hash. The app base is detected at
// load time, which keeps root deployments (custom domain, user pages)
// and subpath deployments (project pages) working: coi-sw.js injects a
// <base> tag for client-side routes it serves, and 404.html hands
// first-visit deep links over to the real entry point.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);

  // App base directory, always with a trailing slash. document.baseURI
  // carries the injected <base> on SPA fallback loads and equals the page
  // URL on normal loads, so the directory of index.html comes out right
  // in both cases.
  const BASE = (function () {
    try {
      const u = new URL(document.baseURI, location.href);
      if (u.origin === location.origin) {
        const p = u.pathname;
        return p.endsWith("/") ? p : (p.slice(0, p.lastIndexOf("/") + 1) || "/");
      }
    } catch (e) {}
    return "/";
  })();

  // Game endings decided by the rules of chess itself (the database
  // engine): on such games the engine panel shows "game over" and the
  // Stockfish worker is never started. Player-decided endings (resign,
  // flag, agreement, ...) keep the engine available.
  const RULE_ENDS = ["checkmate", "stalemate", "insufficient_material", "fifty_moves", "repetition"];

  // Theme: applied instantly by the inline head script, so here is only
  // the toggle and persistence.
  function applyTheme(t2) {
    document.documentElement.classList.toggle("dark", t2 === "dark");
    const b = U.qs("#theme-toggle");
    if (b) b.textContent = t2 === "dark" ? "☀" : "☾";
  }
  function toggleTheme() {
    const t2 = document.documentElement.classList.contains("dark") ? "light" : "dark";
    try { localStorage.setItem("ladya-theme", t2); } catch (e) {}
    applyTheme(t2);
  }

  function routeFromLocation() {
    let path = location.pathname;
    if (path.startsWith(BASE)) path = path.slice(BASE.length);
    else if (path.startsWith("/")) path = path.slice(1);
    path = path.replace(/index\.html$/, "").replace(/\/+$/, "");
    let query = null;
    try { query = new URLSearchParams(location.search); } catch (e) {}
    const parts = path.split("/").filter(Boolean);
    return {
      page: parts[0] || "",
      // the editor carries a full FEN in the path (/editor/<fen>), where
      // the FEN keeps its rank slashes; every other route uses one argument
      arg: parts.length > 1 ? (parts[0] === "editor" ? parts.slice(1).join("/") : parts[1]) : null,
      query
    };
  }

  const App = {
    cleanup: null,
    user: null,
    profile: null,
    base: BASE,
    ruleEnds: RULE_ENDS,
    _routedOnce: false,
    _fixTimer: null,

    // href for a route ("/forum" -> base + "forum"); route "" or "/" is home
    href(route) { return BASE + String(route || "").replace(/^\//, ""); },

    // SPA navigation: push a clean path and render it
    go(route) {
      const url = this.href(route);
      try { history.pushState({}, "", url); } catch (e) { location.assign(url); return; }
      this.route();
    },

    // rewrite route-style anchors (#/forum) to real path URLs so the
    // address bar, hover status and copied links never contain a hash
    fixLinks(rootEl) {
      U.qsa('a[href^="#/"]', rootEl || document).forEach(a => {
        a.setAttribute("href", this.href(a.getAttribute("href").slice(1)));
      });
    },
    scheduleFixLinks() {
      if (this._fixTimer) return;
      this._fixTimer = setTimeout(() => {
        this._fixTimer = null;
        this.fixLinks();
      }, 0);
    },

    // instant active-menu highlight without network
    updateNav() {
      const page = routeFromLocation().page || "lobby";
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
          <a href="#" id="logout">${U.esc(t("nav.logout"))}</a>`;
          U.qs("#logout").addEventListener("click", async (e) => {
            e.preventDefault();
            await API.signOut();
            App.refreshNav().then(() => { App.go("/"); });
          });
          this.fixLinks(box);
        }
        if (this.profile.is_banned) {
          ban.textContent = t("ban.banner",
            { reason: this.profile.ban_reason || t("ban.noReason") });
          ban.classList.remove("hidden");
        } else ban.classList.add("hidden");
      } else {
        if (box.dataset.sig !== "guest") {
          box.dataset.sig = "guest";
          box.innerHTML = `<a class="nav-login" href="#/login">${U.esc(t("nav.login"))}</a>
            <a class="btn primary nav-signup" href="#/signup">${U.esc(t("nav.signup"))}</a>`;
          this.fixLinks(box);
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
      this.updateNav(); // highlight immediately and synchronously
      const app = U.qs("#app");
      if (this.cleanup) { try { this.cleanup(); } catch (e) {} this.cleanup = null; }
      const { page, arg, query } = routeFromLocation();

      const wrap = async (fn, ...args) => { this.cleanup = await fn(app, ...args); };

      try {
        if (page === "") await wrap(LobbyPage.render);
        else if (page === "game") await wrap(GamePage.render, arg);
        else if (page === "analysis") await wrap(AnalysisBoardPage.render, query ? query.get("fen") : null);
        else if (page === "editor") await wrap(EditorPage.render, arg);
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
        else app.innerHTML = `<div class="card center"><h2>404</h2><p><a href="#/">${U.esc(t("common.home"))}</a></p></div>`;
      } catch (e) {
        console.error(e);
        app.innerHTML = `<div class="card center"><h2>${U.esc(t("common.error"))}</h2><p class="muted">${U.esc(e.message || e)}</p></div>`;
      }
      this.fixLinks(app);
      this.refreshDmBadge();
      window.scrollTo(0, 0);
    }
  };

  // Browser back/forward renders the matching page.
  window.addEventListener("popstate", () => App.route());

  // Clicks on route links navigate inside the SPA. This covers both the
  // route-style markup (#/forum, also produced by U.linkify for stored
  // messages) and real path links: both push a clean path, never a hash.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a || !a.hasAttribute("href") || (a.target && a.target !== "_self")) return;
    const href = a.getAttribute("href");
    let route = null;
    if (href.startsWith("#/")) route = href.slice(1);
    else if (href.startsWith(BASE) && !href.startsWith("#")) route = href.slice(BASE.length - 1) || "/";
    if (route == null) return;
    e.preventDefault();
    App.go(route);
  });

  // Content inserted after a render (chat messages, lists, dynamic hrefs)
  // gets its anchors normalized too, so no #/ link ever stays in the DOM.
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") {
        if ((m.target.getAttribute("href") || "").startsWith("#/")) { App.scheduleFixLinks(); return; }
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if ((n.matches && n.matches('a[href^="#/"]')) || (n.querySelector && n.querySelector('a[href^="#/"]'))) {
          App.scheduleFixLinks();
          return;
        }
      }
    }
  });

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
    // language first: the dictionaries and the static shell localize
    // before the first render
    await I18n.init();
    // theme is applied before first render; only the button lives here
    applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const tbtn = U.qs("#theme-toggle");
    if (tbtn) tbtn.addEventListener("click", toggleTheme);

    // normalize anchors of the static shell before the first render
    App.fixLinks();
    obs.observe(U.qs("#app"), { childList: true, subtree: true });
    const navUser = U.qs("#nav-user");
    if (navUser) obs.observe(navUser, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });

    // old #/... bookmarks and stored links land on the clean path once
    if (/^#\//.test(location.hash)) {
      try { history.replaceState({}, "", App.href(location.hash.slice(1))); } catch (e) {}
    }

    // arriving via a confirmation email link signs in without the login
    // form; supabase-js consumes the #access_token hash on its own
    const viaEmailLink = /access_token=/.test(location.hash);

    // instant page render without waiting for the network
    App.route();
    // session and server time load in the background
    ServerTime.sync().catch(() => {});
    await App.refreshNav();
    startHeartbeat();
    // if the instant render was a guest view but a session exists, rerender once
    if (App.user && !routeFromLocation().page) App.route();
    if (viaEmailLink && App.user) {
      U.toast(I18n.t("auth.emailConfirmed"), "good");
      try { history.replaceState({}, "", location.pathname + location.search); } catch (e) {}
    }
    // unread DM badge refreshes periodically and idles in the background
    App.refreshDmBadge();
    API.poll(15000, () => App.refreshDmBadge());
    // quiet badge refresh when returning to the tab
    API.onVisible(() => App.refreshDmBadge());
    API.onAuth((evt, session) => App.handleAuthEvent(evt, session));
  })();
})();
