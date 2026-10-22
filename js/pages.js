// Pages: login/signup, profile, leaderboard. The leaderboard adds the
// online pulse, player challenges, and recent games with replay.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);

  // online: heartbeat every 30 s plus a grace window
  function isOnline(p) {
    if (!p || !p.last_seen_at) return false;
    return (ServerTime.now() - U.parseTs(p.last_seen_at)) < 75000;
  }

  const dotHtml = (p) =>
    `<span class="online-dot ${isOnline(p) ? "" : "off"}" title="${U.esc(isOnline(p) ? t("status.online") : t("status.offline"))}"></span>`;

  // login
  const LoginPage_render = function (container) {
    container.innerHTML = `
      <div class="card" style="max-width:420px;margin:30px auto">
        <h2>${U.esc(t("auth.loginTitle"))}</h2>
        <label>${U.esc(t("auth.email"))}</label><input id="l-email" type="email" autocomplete="email">
        <label>${U.esc(t("auth.password"))}</label><input id="l-pass" type="password" autocomplete="current-password">
        <div class="err" id="l-err"></div>
        <button class="btn primary block" id="l-go">${U.esc(t("auth.loginBtn"))}</button>
        <p class="small" style="margin-top:14px">${U.esc(t("auth.noAccount"))} <a href="#/signup">${U.esc(t("nav.signup"))}</a>
          · <a href="#" id="l-reset">${U.esc(t("auth.forgot"))}</a></p>
      </div>`;
    U.qs("#l-go").addEventListener("click", doLogin);
    U.qs("#l-pass").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
    U.qs("#l-reset").addEventListener("click", async (e) => {
      e.preventDefault();
      const email = U.qs("#l-email").value.trim();
      if (!email) return U.toast(t("auth.enterEmail"), "error");
      const { error } = await API.resetPassword(email);
      U.toast(error ? I18n.s(error.message) : t("auth.resetSent"), error ? "error" : "good");
    });
    async function doLogin() {
      const email = U.qs("#l-email").value.trim();
      const pass = U.qs("#l-pass").value;
      const { error } = await API.signIn(email, pass);
      if (error) { U.qs("#l-err").textContent = I18n.s(error.message); return; }
      U.toast(t("auth.loggedIn"), "good");
      location.hash = "#/";
      App.refreshNav();
    }
  };

  // signup
  const SignupPage_render = function (container) {
    container.innerHTML = `
      <div class="card" style="max-width:420px;margin:30px auto">
        <h2>${U.esc(t("auth.signupTitle"))}</h2>
        <label>${U.esc(t("auth.usernameLabel"))}</label><input id="s-user" maxlength="20">
        <label>${U.esc(t("auth.email"))}</label><input id="s-email" type="email">
        <label>${U.esc(t("auth.passwordLabel"))}</label><input id="s-pass" type="password">
        <div class="err" id="s-err"></div>
        <button class="btn primary block" id="s-go">${U.esc(t("auth.createBtn"))}</button>
        <p class="small" style="margin-top:14px">${U.esc(t("auth.haveAccount"))} <a href="#/login">${U.esc(t("nav.login"))}</a></p>
      </div>`;
    U.qs("#s-go").addEventListener("click", doSignup);
    async function doSignup() {
      const username = U.qs("#s-user").value.trim();
      const email = U.qs("#s-email").value.trim();
      const pass = U.qs("#s-pass").value;
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
        U.qs("#s-err").textContent = t("auth.usernameInvalid"); return;
      }
      const { data, error } = await API.signUp(email, pass, username);
      if (error) { U.qs("#s-err").textContent = I18n.s(error.message); return; }
      if (data.session) {
        U.toast(t("auth.created"), "good");
        location.hash = "#/";
        App.refreshNav();
      } else {
        U.infoModal(`<h3>${U.esc(t("auth.confirmEmailTitle"))}</h3>
          <p>${t("auth.confirmEmailText", { email: U.esc(email) })}</p>
          <p class="muted small">${t("auth.confirmEmailNote")}</p>`);
        location.hash = "#/login";
      }
    }
  };

  // player challenge (shared modal)
  const TC_OPTIONS = [
    [60000, 0, "1+0", "bullet"], [120000, 1000, "2+1", "bullet"],
    [180000, 0, "3+0", "blitz"], [180000, 2000, "3+2", "blitz"], [300000, 0, "5+0", "blitz"],
    [600000, 0, "10+0", "rapid"], [900000, 10000, "15+10", "rapid"],
    [1800000, 0, "30+0", "classic"], [1800000, 20000, "30+20", "classic"]
  ];

  async function challengeModal(target) {
    const res = await U.formModal(t("challenge.title", { name: target.username }), [
      { id: "tc", label: t("lobby.timeControl"), type: "select",
        value: "600000|0",
        options: TC_OPTIONS.map(o => ({ v: `${o[0]}|${o[1]}`, l: `${o[2]} · ${t("tc." + o[3])}` })) },
      { id: "color", label: t("lobby.yourColor"), type: "select", value: "random",
        options: [{ v: "random", l: t("color.random") }, { v: "white", l: t("color.white") }, { v: "black", l: t("color.black") }] },
      { id: "rated", label: t("challenge.type"), type: "select", value: "1",
        options: [{ v: "1", l: t("challenge.rated") }, { v: "0", l: t("challenge.casual") }] }
    ], t("challenge.send"));
    if (!res) return;
    const [ms, inc] = res.tc.split("|").map(Number);
    const rated = res.rated === "1";
    const { data: gid, error } = await API.createChallenge(ms, inc, rated, res.color, target.id);
    if (error) return U.toast(error.message, "error");
    // best-effort DM invitation
    API.sendDm(target.id,
      t("challenge.dm", { tc: U.fmtTc(ms, inc), kind: rated ? t("challenge.rated").toLowerCase() : t("challenge.casual").toLowerCase(), id: gid }))
      .then(({ error: e2 }) => { if (e2) console.warn(e2.message); });
    U.toast(t("challenge.sent"), "good");
    location.hash = `#/game/${gid}`;
  }

  // profile
  const ProfilePage_render = async function (container, userId) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = await API.user();
    const { data: p } = await API.sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">${U.esc(t("profile.notFound"))}</div>`; return () => {}; }
    const own = me && me.id === p.id;
    // whether this player is blocked by me (UI only; the server rechecks)
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
    // moderating someone else: the creator is untouchable, an admin answers only to the creator
    const canModerate = iAmMod && !own && p.role !== "creator" &&
                        !(p.role === "admin" && myProfile.role !== "creator");
    container.innerHTML = `
      <div class="card">
        <div class="row spread">
          <div class="row">
            <span class="avatar big">${U.esc((p.username || "?")[0].toUpperCase())}</span>
            <div>
              <h2 style="margin:0">${U.esc(p.username)} ${U.roleBadge(p.role)} ${dotHtml(p)} ${p.is_banned ? `<span class="badge danger">${U.esc(t("profile.bannedBadge"))}</span>` : ""}</h2>
              <span class="muted small">${U.esc(t("profile.joined", { date: U.fmtDate(p.created_at) }))}</span>
            </div>
          </div>
          <div class="row">
            ${!own && me && !iBlocked ? `<button class="btn" id="p-dm">${U.esc(t("profile.write"))}</button>
                            <button class="btn primary" id="p-challenge">${U.esc(t("profile.challenge"))}</button>` : ""}
            ${!own && me ? `<button class="btn ghost" id="p-block" title="${U.esc(t("profile.blockTitle"))}">${iBlocked ? U.esc(t("profile.unblock")) : U.esc(t("profile.block"))}</button>` : ""}
            ${own ? `<button class="btn" id="p-rename">${U.esc(t("profile.rename"))}</button>` : ""}
          </div>
        </div>
        <div class="stat-cards" style="margin-top:16px">
          <div class="stat-card"><b>${p.rating}</b><span>${U.esc(t("profile.elo"))}</span></div>
          <div class="stat-card"><b>${p.rating_bullet ?? 1000}</b><span>${U.esc(t("tc.bullet"))}</span></div>
          <div class="stat-card"><b>${p.rating_blitz ?? 1000}</b><span>${U.esc(t("tc.blitz"))}</span></div>
          <div class="stat-card"><b>${p.rating_rapid ?? 1000}</b><span>${U.esc(t("tc.rapid"))}</span></div>
          <div class="stat-card"><b>${p.rating_classic ?? 1000}</b><span>${U.esc(t("tc.classic"))}</span></div>
          <div class="stat-card"><b>${p.games}</b><span>${U.esc(t("profile.gamesCount", { wld }))}</span></div>
          <div class="stat-card"><b>${p.games ? Math.round(100 * p.wins / p.games) : 0}%</b><span>${U.esc(t("profile.winRate"))}</span></div>
        </div>
      </div>
      ${canModerate ? `
      <div class="card mod-panel">
        <h3>${U.esc(t("profile.moderation"))}${p.role === "admin" ? U.esc(t("profile.adminTag")) : ""}</h3>
        <div class="row wrap">
          <button class="btn" id="mod-mute">${U.esc(t("profile.muteBtn"))}</button>
          <button class="btn ghost" id="mod-unmute" title="${U.esc(t("profile.unmuteTitle"))}">${U.esc(t("profile.unmuteBtn"))}</button>
          <button class="btn" id="mod-role">${U.esc(t("profile.roleBtn", { role: p.role === "admin" ? t("role.adminShort") : t("role.userShort") }))}</button>
          ${p.is_banned
            ? `<button class="btn" id="mod-ban">${U.esc(t("profile.unbanBtn"))}</button>`
            : `<button class="btn danger" id="mod-ban">${U.esc(t("profile.banBtn"))}</button>`}
          <button class="btn danger" id="mod-delacc">${U.esc(t("profile.deleteAccBtn"))}</button>
        </div>
        <p class="muted small">${U.esc(t("profile.modHint"))}</p>
      </div>` : ""}
      <div class="card">
        <h2>${U.esc(t("profile.recentGames"))}</h2>
        <div id="recent"></div>
      </div>
      ${own ? `<div class="card"><h3>${U.esc(t("profile.blockedTitle"))}</h3>
        <p class="muted small">${U.esc(t("profile.blockedHint"))}</p>
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
        U.toast(iBlocked ? t("profile.unblocked") : t("profile.blocked"), "good");
        App.route();
      });
    }
    if (own) {
      U.qs("#p-rename").addEventListener("click", async () => {
        const res = await U.formModal(t("profile.rename"), [
          { id: "name", label: t("profile.newNickLabel"),
            value: p.username, maxlength: 20, placeholder: t("profile.nickPlaceholder") }
        ], t("common.save"));
        if (!res) return;
        const name = res.name.trim();
        if (!name || name === p.username) return;
        const { error } = await API.setUsername(name);
        if (error) U.toast(error.message, "error");
        else { U.toast(t("profile.nickUpdated"), "good"); App.route(); }
      });
    }

    // profile moderation (creator/admin; roles verified in the database)
    if (canModerate) {
      const modMute = U.qs("#mod-mute");
      if (modMute) modMute.addEventListener("click", async () => {
        const res = await U.formModal(t("mod.muteTitle", { name: p.username }), [
          { id: "mins", label: t("mod.minutes"), value: "15", type: "text" },
          { id: "reason", label: t("mod.reason"), maxlength: 200, placeholder: t("mod.spam") }
        ], t("mod.muteBtn"));
        if (!res) return;
        const mins = Math.round(Number(res.mins));
        if (!(mins >= 1 && mins <= 10080)) return U.toast(t("mod.minutesInvalid"), "error");
        const { error } = await API.adminMute(p.id, mins, res.reason.trim());
        if (error) U.toast(error.message, "error");
        else U.toast(t("mod.muted", { name: p.username, mins }), "good");
      });
      const modUnmute = U.qs("#mod-unmute");
      if (modUnmute) modUnmute.addEventListener("click", async () => {
        const { error } = await API.adminUnmute(p.id);
        if (error) U.toast(error.message, "error");
        else U.toast(t("mod.unmuted"), "good");
      });
      const modBan = U.qs("#mod-ban");
      if (modBan) modBan.addEventListener("click", async () => {
        if (p.is_banned) {
          if (!(await U.confirmModal(t("mod.unbanQ"), p.username, t("mod.unbanBtn")))) return;
          const { error } = await API.adminUnban(p.id);
          if (error) U.toast(error.message, "error");
          else { U.toast(t("mod.unbanned"), "good"); App.route(); }
        } else {
          const res = await U.formModal(t("mod.banTitle", { name: p.username }), [
            { id: "reason", label: t("mod.reason"), maxlength: 200, placeholder: t("ban.noReason") }
          ], t("mod.banConfirm"));
          if (!res) return;
          if (!(await U.confirmDanger(t("mod.banQ", { name: p.username }),
              t("mod.banText"), t("mod.banConfirm")))) return;
          const { error } = await API.adminBan(p.id, res.reason.trim());
          if (error) U.toast(error.message, "error");
          else { U.toast(t("mod.banned"), "good"); App.route(); }
        }
      });
      const modRole = U.qs("#mod-role");
      if (modRole) modRole.addEventListener("click", async () => {
        const res = await U.formModal(t("mod.roleTitle", { name: p.username }), [
          { id: "role", label: t("mod.newRole"), type: "select", value: p.role,
            options: [
              { v: "user", l: t("mod.roleUser") },
              { v: "admin", l: t("mod.roleAdmin") },
              { v: "creator", l: t("mod.roleCreator") }
            ] }
        ], t("mod.assign"));
        if (!res || res.role === p.role) return;
        const { error } = await API.adminSetRole(p.id, res.role);
        if (error) U.toast(error.message, "error");
        else { U.toast(t("mod.roleUpdated"), "good"); App.route(); }
      });
      const modDel = U.qs("#mod-delacc");
      if (modDel) modDel.addEventListener("click", async () => {
        if (!(await U.confirmDanger(t("mod.delAccQ", { name: p.username }),
            t("mod.delAccText"), t("mod.delAccConfirm")))) return;
        const { error } = await API.adminDeleteAccount(p.id);
        if (error) U.toast(error.message, "error");
        else { U.toast(t("mod.accDeleted"), "good"); location.hash = "#/"; }
      });
    }

    const rec = U.qs("#recent");
    if (!recent || !recent.length) {
      rec.innerHTML = `<div class="empty">${U.esc(t("profile.noGames"))}</div>`;
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
          <span><b>${U.fmtTc(g.initial_ms, g.increment_ms)}</b> ${g.rated ? `<span class="badge rated">${U.esc(t("common.ratedBadge"))}</span>` : ""}</span>
          <span>${U.esc(t("profile.vs"))} <a href="#/profile/${iAmWhite ? g.black : g.white}">${U.esc(opp ? opp.username : "?")}</a></span>
          <span class="muted small">${U.fmtDate(g.finished_at)}</span>
          <a href="#/game/${g.id}">${U.esc(t("profile.open"))}</a>
        </div>`;
      }).join("");
    }
    // blocked players card (own profile only)
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
            <div class="muted small">${U.esc(t("profile.blockedSince", { date: U.fmtDate(b.created_at) }))}</div>
          </div>
          <button class="btn ghost small" data-unblock="${b.blocked_id}">${U.esc(t("profile.unblock"))}</button>
        </div>`).join("") : `<div class="empty">${U.esc(t("profile.blockedEmpty"))}</div>`;
      U.qsa("[data-unblock]", bl).forEach(btn => btn.addEventListener("click", async () => {
        const { error } = await API.unblockUser(btn.dataset.unblock);
        if (error) return U.toast(error.message, "error");
        API.invalidateBlocked();
        U.toast(t("profile.unblocked"), "good");
        App.route();
      }));
    }
    return () => {};
  };

  // leaderboard (bullet / blitz / rapid / classic pools)
  let openReplay = null; // only one replay stays expanded
  const POOLS = [
    { key: "bullet",  col: "rating_bullet",  games: "games_bullet" },
    { key: "blitz",   col: "rating_blitz",   games: "games_blitz" },
    { key: "rapid",   col: "rating_rapid",   games: "games_rapid" },
    { key: "classic", col: "rating_classic", games: "games_classic" }
  ];

  function currentPool() {
    const k = localStorage.getItem("ladya-pool");
    return POOLS.find(p => p.key === k) || POOLS[0];
  }

  async function expandReplay(slot, gameId) {
    slot.innerHTML = `<div class="center" style="padding:10px"><span class="spinner"></span> ${U.esc(t("common.loading"))}</div>`;
    // moves and the start FEN come straight from the table; positions are computed client-side with chess.js
    const { data, error } = await API.sb.from("games")
      .select("start_fen,moves").eq("id", gameId).maybeSingle();
    if (error || !data) {
      slot.innerHTML = `<div class="empty">${U.esc(t("rp.loadError"))}</div>`;
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
      slot.innerHTML = `<div class="empty">${U.esc(t("rp.restoreError"))}</div>`;
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
      `<button class="pool-tab ${p.key === pool.key ? "active" : ""}" data-pool="${p.key}">${U.esc(t("tc." + p.key))}</button>`
    ).join("") + `</div>`;

    const rows = (data || []).filter(p => !p.is_banned).map((p, i) => `
      <tr>
        <td class="muted"><span class="rank-num">${i + 1}</span></td>
        <td><span class="lb-player">${dotHtml(p)}
          <a href="#/profile/${p.id}">${U.esc(p.username)}</a></span></td>
        <td class="rt"><b>${p[pool.col]}</b></td>
        <td class="rt">${p[pool.games]}</td>
        <td class="rt">${me && me.id !== p.id
          ? `<button class="btn small" data-chal="${p.id}">${U.esc(t("lb.challenge"))}</button>` : ""}</td>
      </tr>`).join("");

    container.innerHTML = `
      <div class="card">
        <h2>${U.esc(t("lb.title"))}</h2>
        ${tabs}
        ${rows ? `<table class="lb-table">
          <tr><th>#</th><th>${U.esc(t("lb.player"))}</th><th class="rt">${U.esc(t("lb.rating", { pool: t("tc." + pool.key) }))}</th><th class="rt">${U.esc(t("lb.games"))}</th><th></th></tr>
          ${rows}
        </table>` : `<div class="empty">${U.esc(t("lb.empty"))}</div>`}
      </div>
      <div class="card">
        <h2>${U.esc(t("profile.recentGames"))}</h2>
        <p class="muted small">${U.esc(t("lb.recentHint"))}</p>
        <div id="lb-games">${renderRecent(recent || [])}</div>
      </div>`;

    // pool switching redraws the table
    U.qsa(".pool-tab", container).forEach(b =>
      b.addEventListener("click", () => {
        localStorage.setItem("ladya-pool", b.dataset.pool);
        Pages.leaderboard(container).catch(console.error);
      }));

    // challenge buttons
    const byId = {};
    (data || []).forEach(p => { byId[p.id] = p; });
    U.qsa("[data-chal]", container).forEach(b =>
      b.addEventListener("click", () => {
        const p = byId[b.dataset.chal];
        if (p) challengeModal(p);
      }));

    // replay expansion
    U.qsa("[data-watch]", container).forEach(b =>
      b.addEventListener("click", () => {
        const slot = U.qs(`#rp-${b.dataset.watch}`, container);
        if (!slot) return;
        if (!slot.classList.contains("hidden")) {
          slot.classList.add("hidden");
          b.textContent = t("lb.watch");
          if (openReplay) { openReplay.destroy(); openReplay = null; }
          return;
        }
        U.qsa(".rp-slot", container).forEach(s => s.classList.add("hidden"));
        U.qsa("[data-watch]", container).forEach(x => x.textContent = t("lb.watch"));
        if (openReplay) { openReplay.destroy(); openReplay = null; }
        slot.classList.remove("hidden");
        b.textContent = t("lb.hide");
        expandReplay(slot, b.dataset.watch);
      }));

    return () => {
      if (openReplay) { openReplay.destroy(); openReplay = null; }
    };
  }

  function renderRecent(games) {
    if (!games.length) return `<div class="empty">${U.esc(t("profile.noGames"))}</div>`;
    return games.map(g => `
      <div class="lb-game">
        <div class="list-item">
          <span class="badge ${g.result === "1-0" ? "rated" : g.result === "0-1" ? "danger" : "finished"}">
            ${g.result === "1-0" ? "1–0" : g.result === "0-1" ? "0–1" : "½–½"}</span>
          <span style="flex:1;min-width:0">
            <a href="#/profile/${g.white}">${U.esc(g.wp ? g.wp.username : "?")}</a>
            <span class="muted"> — </span>
            <a href="#/profile/${g.black}">${U.esc(g.bp ? g.bp.username : "?")}</a>
            <span class="muted small">· ${U.fmtTc(g.initial_ms, g.increment_ms)}${g.rated ? ` · ${U.esc(t("common.ratedBadge"))}` : ""} · ${U.fmtDate(g.finished_at)}</span>
          </span>
          <a class="btn small" href="#/game/${g.id}">${U.esc(t("lb.gameLink"))}</a>
          <button class="btn small" data-watch="${g.id}">${U.esc(t("lb.watch"))}</button>
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
