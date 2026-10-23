// Lobby: quick pairing, link challenges, own games, open challenges
// (visible to guests too), and the global chat.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);

  const PRESETS = [
    { name: "1+0", ms: 60000, inc: 0, pool: "bullet" },
    { name: "2+1", ms: 120000, inc: 1000, pool: "bullet" },
    { name: "3+0", ms: 180000, inc: 0, pool: "blitz" },
    { name: "3+2", ms: 180000, inc: 2000, pool: "blitz" },
    { name: "5+0", ms: 300000, inc: 0, pool: "blitz" },
    { name: "10+0", ms: 600000, inc: 0, pool: "rapid" },
    { name: "15+10", ms: 900000, inc: 10000, pool: "rapid" },
    { name: "30+0", ms: 1800000, inc: 0, pool: "classic" },
    { name: "30+20", ms: 1800000, inc: 20000, pool: "classic" }
  ];

  const LobbyPage_render = async function (container) {
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const me = await API.user();
    const myProfile = me
      ? (App.profile && App.profile.id === me.id ? App.profile : await API.profile(me.id))
      : null;

    container.innerHTML = `
      <h1>${U.esc(t("lobby.title"))}</h1>
      ${!me ? `
        <div class="card center">
          <h2>${U.esc(t("lobby.welcome"))}</h2>
          <p class="muted">${U.esc(t("lobby.intro"))}</p>
          <div class="row" style="justify-content:center">
            <a class="btn primary big" href="#/signup">${U.esc(t("nav.signup"))}</a>
            <a class="btn big" href="#/login">${U.esc(t("nav.login"))}</a>
          </div>
        </div>
        <div class="card">
          <h2>${U.esc(t("lobby.openChallenges"))}</h2>
          <p class="muted small">${U.esc(t("lobby.openGuestHint"))}</p>
          <div id="open-list"><span class="spinner"></span></div>
        </div>` : `
        <div class="card hidden" id="my-games"></div>
        <div class="grid2">
          <div class="card">
            <h2>${U.esc(t("lobby.quickGame"))}</h2>
            <p class="muted small">${U.esc(t("lobby.quickHint"))}</p>
            <div class="tc-grid" id="tc-grid">
              ${PRESETS.map(p => `
                <button class="tc-btn" data-ms="${p.ms}" data-inc="${p.inc}">
                  <b>${p.name}</b><span>${U.esc(t("tc." + p.pool))}</span>
                </button>`).join("")}
            </div>
            <div class="row" style="margin-top:12px">
              <input id="custom-min" type="number" min="1" max="120" value="5" style="width:80px"> ${U.esc(t("common.min"))}
              <input id="custom-inc" type="number" min="0" max="60" value="0" style="width:80px"> ${U.esc(t("common.sec"))}
              <button class="btn" id="custom-go">${U.esc(t("lobby.pair"))}</button>
            </div>
            <div id="seek-status" class="center" style="margin-top:14px"></div>
          </div>
          <div class="card">
            <h2>${U.esc(t("lobby.linkChallenge"))}</h2>
            <p class="muted small">${U.esc(t("lobby.linkHint"))}</p>
            <label>${U.esc(t("lobby.yourColor"))}</label>
            <select id="ch-color">
              <option value="random">${U.esc(t("color.random"))}</option>
              <option value="white">${U.esc(t("color.white"))}</option>
              <option value="black">${U.esc(t("color.black"))}</option>
            </select>
            <label>${U.esc(t("lobby.timeControl"))}</label>
            <div class="row">
              <input id="ch-min" type="number" min="1" max="120" value="10" style="width:80px"> ${U.esc(t("common.min"))}
              <input id="ch-inc" type="number" min="0" max="60" value="0" style="width:80px"> ${U.esc(t("common.sec"))}
            </div>
            <label><input type="checkbox" id="ch-rated" checked style="width:auto"> ${U.esc(t("lobby.rated"))}</label>
            <button class="btn primary block" id="ch-create" style="margin-top:12px">${U.esc(t("lobby.create"))}</button>
          </div>
        </div>
        <div class="card">
          <h2 class="spread row">${U.esc(t("lobby.openChallenges"))}
            <button class="btn ghost small" id="open-refresh" title="${U.esc(t("common.refreshTitle"))}">${U.esc(t("common.refresh"))}</button></h2>
          <p class="muted small">${U.esc(t("lobby.openHint"))}</p>
          <div id="open-list"><span class="spinner"></span></div>
        </div>`}
      <div class="card">
        <h2>${U.esc(t("lobby.globalChat"))}</h2>
        <div id="global-chat"></div>
      </div>
    `;

    // global chat; guests read only
    const gcCleanup = Social.globalChat(U.qs("#global-chat"));
    let disposed = false;
    const cleanupFns = [() => { if (!disposed) gcCleanup(); }];

    // Open challenges = quick-pairing seeks. They are exactly the players
    // who searched an opponent through quick pairing: accepting a seek
    // joins the same pool and pairs with its owner at once. Link
    // challenges stay private (joinable only through their link) and
    // direct challenges reach the invitee as a DM, so neither shows here.
    // Own seeks render optimistically: the row appears the moment the
    // button is pressed, before the RPC confirms it, and disappears at
    // once on cancel — from both panels, since they share the state below.
    let openDebounce = null;
    const scheduleOpen = () => { clearTimeout(openDebounce); openDebounce = setTimeout(loadOpen, 250); };
    let cachedSeeks = [];
    let optimisticSeek = null; // { initial_ms, increment_ms } until the server confirms

    function renderOpen() {
      const box = U.qs("#open-list");
      if (!box) return;
      let rows = cachedSeeks;
      if (optimisticSeek && me && !rows.some(s => s.user_id === me.id)) {
        rows = rows.concat([{ user_id: me.id, initial_ms: optimisticSeek.initial_ms,
                              increment_ms: optimisticSeek.increment_ms,
                              p: myProfile, optimistic: true }]);
      }
      const trs = rows.map(s => {
        const own = me && s.user_id === me.id;
        return `<tr>
          <td><a href="#/profile/${s.user_id}">${U.esc(s.p ? s.p.username : "?")}</a>
              <span class="muted">(${s.p ? s.p.rating : "?"})</span>
              ${own ? `<span class="badge finished">${U.esc(t("lobby.yourSeek"))}</span>` : ""}</td>
          <td><b>${U.fmtTc(s.initial_ms, s.increment_ms)}</b></td>
          <td><span class="badge rated">${U.esc(t("common.ratedBadge"))}</span></td>
          <td>${own
            ? `<button class="btn small" data-unseek="${s.id}">${U.esc(t("common.cancel"))}</button>`
            : me
              ? `<button class="btn primary small" data-accept="${s.initial_ms}:${s.increment_ms}">${U.esc(t("common.accept"))}</button>`
              : `<a class="btn small" href="#/login">${U.esc(t("nav.login"))}</a>`}</td>
        </tr>`;
      });
      const html = trs.length
        ? `<table class="lobby-list"><tr><th>${U.esc(t("lobby.player"))}</th><th>${U.esc(t("lobby.control"))}</th><th>${U.esc(t("lobby.type"))}</th><th></th></tr>${trs.join("")}</table>`
        : `<div class="empty">${U.esc(t("lobby.openEmpty"))}</div>`;
      const sig = rows.map(s => `${s.user_id}:${s.initial_ms}:${s.increment_ms}:${s.optimistic ? 1 : 0}`).join(",");
      if (box.dataset.sig === sig && box.dataset.err !== "1") return; // unchanged: skip redraw
      box.dataset.sig = sig;
      box.dataset.err = "0";
      box.innerHTML = html;
      U.qsa("[data-unseek]", box).forEach(b => b.addEventListener("click", async () => {
        b.disabled = true;
        cancelSeek();
      }));
      U.qsa("[data-accept]", box).forEach(b => b.addEventListener("click", () => {
        const [ms, inc] = b.dataset.accept.split(":").map(Number);
        startSeek(ms, inc);
      }));
    }

    async function loadOpen() {
      const box = U.qs("#open-list");
      if (!box) return;
      const { data, error } = await API.sb.from("seeks")
        .select("id,user_id,initial_ms,increment_ms,created_at,p:profiles!seeks_user_id_fkey(id,username,rating)")
        .order("created_at", { ascending: true })
        .limit(20);
      if (error) {
        box.dataset.err = "1";
        box.innerHTML = `<div class="empty">${t("lobby.openLoadError")}</div>`;
        return;
      }
      cachedSeeks = data || [];
      // the real row arrived: the optimistic copy is no longer needed
      if (optimisticSeek && me && cachedSeeks.some(s => s.user_id === me.id)) optimisticSeek = null;
      renderOpen();
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

    // quick pairing state, shared by the quick-pairing panel and the
    // open-challenges table so a cancel in either place stops both
    let seeking = false;
    let seekTimer = null;
    let pairInFlight = false;   // quick_pair RPC is still running
    let cancelRequested = false; // cancel arrived while the RPC was in flight

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
      box.innerHTML = `<h2>${U.esc(t("lobby.myGames"))}</h2>` + data.map(g =>
        `<div class="list-item">
          <span class="badge ${g.status}">${U.esc(g.status === "active" ? t("lobby.active") : t("lobby.waiting"))}</span>
          <a href="#/game/${g.id}">${U.esc(t("lobby.gameItem", { tc: U.fmtTc(g.initial_ms, g.increment_ms) }))}</a>
        </div>`).join("");
    }
    loadMyGames();

    // quick pairing
    async function startSeek(ms, inc) {
      if (seeking) return;
      seeking = true;
      // optimistic: the seek row shows in the open list at once
      optimisticSeek = { initial_ms: ms, increment_ms: inc };
      renderOpen();
      const st = U.qs("#seek-status");
      st.innerHTML = `<span class="spinner"></span> ${U.esc(t("lobby.searching", { tc: U.fmtTc(ms, inc) }))}
        <button class="btn ghost small" id="seek-cancel">${U.esc(t("common.cancel"))}</button>`;
      U.qs("#seek-cancel", st).addEventListener("click", cancelSeek);

      pairInFlight = true;
      const { data, error } = await API.quickPair(ms, inc);
      pairInFlight = false;
      if (error) {
        seeking = false;
        optimisticSeek = null;
        renderOpen();
        st.innerHTML = "";
        U.toast(error.message, "error");
        return;
      }
      if (data) { App.go(`/game/${data}`); return; }
      // the cancel button was pressed while the RPC was running: the seek
      // it just created has to be removed too
      if (cancelRequested) { cancelRequested = false; await API.cancelSeek(); return; }
      // wait for the pair by polling own active games
      seekTimer = setInterval(async () => {
        const { data: games } = await API.sb.from("games")
          .select("id").or(`white.eq.${me.id},black.eq.${me.id}`)
          .eq("status", "active").limit(1);
        if (games && games.length) { stopSeek(); App.go(`/game/${games[0].id}`); }
      }, 2500);
    }
    // single cancel path for both panels: clears the search status and
    // the open-list row immediately, then tells the server. Also covers
    // a seek left on the server after a page reload (local state empty).
    async function cancelSeek() {
      const wasInFlight = pairInFlight && seeking;
      stopSeek();
      cancelRequested = wasInFlight;
      optimisticSeek = null;
      cachedSeeks = cachedSeeks.filter(s => !me || s.user_id !== me.id);
      renderOpen();
      await API.cancelSeek();
      loadOpen();
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
      App.go(`/game/${data}`);
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
      if (seeking) API.cancelSeek();
      openTimer();
      myTimer();
      stopVisible();
      clearTimeout(rtDebounce);
      clearTimeout(openDebounce);
      API.unsubscribe(rtChan);
      API.unsubscribe(seekChan);
      cleanupFns.forEach(f => f());
    };
  };

  window.LobbyPage = { render: LobbyPage_render };
})();
