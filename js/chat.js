// Global chat (lobby) and direct messages. Guests read the global
// chat; posting requires signing in and goes through RPCs.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);

  // username cache for realtime rows
  const nameCache = {};
  const roleCache = {};          // id -> role (user/creator/admin) for badges
  async function fetchNames(ids) {
    const need = ids.filter(id => id && !(id in nameCache));
    if (!need.length) return;
    const { data } = await API.sb.from("profiles").select("id,username,role").in("id", need);
    (data || []).forEach(p => { nameCache[p.id] = p.username; roleCache[p.id] = p.role || "user"; });
  }
  const nameOf = (id) => nameCache[id] || "?";

  // moderator buttons on a message (creator/admin): delete, plus mute
  // for other people's messages (muting yourself is denied). Public
  // chats only; game chat and DMs are never moderated.
  function modActionsHtml(m) {
    if (!U.amMod() || !m.user_id) return "";
    const own = App.user && m.user_id === App.user.id;
    return `<span class="msg-mod">
      ${own ? "" : `<button class="mod-btn" data-amute="${m.user_id}" data-aid="${m.user_id}" title="${U.esc(t("mod.muteAuthorTitle"))}">🔇</button>`}
      <button class="mod-btn" data-adel="${m.id}" data-akind="${m.kind}" title="${U.esc(own ? t("mod.delOwnTitle") : t("mod.delTitle"))}">×</button>
    </span>`;
  }

  // shared mute dialog for delegated moderation handlers
  async function muteDialog(target, fallbackName) {
    const nm = nameCache[target] || fallbackName || t("mod.playerFallback");
    const res = await U.formModal(t("mod.muteTitle", { name: nm }), [
      { id: "mins", label: t("mod.minutes"), value: "15", type: "text" },
      { id: "reason", label: t("mod.reason"), maxlength: 200, placeholder: t("mod.spam") }
    ], t("mod.muteBtn"));
    if (!res) return;
    const mins = Math.round(Number(res.mins));
    if (!(mins >= 1 && mins <= 10080)) return U.toast(t("mod.minutesInvalid"), "error");
    const { error } = await API.adminMute(target, mins, res.reason.trim());
    if (error) U.toast(error.message, "error");
    else U.toast(t("mod.muted", { name: nm, mins }), "good");
  }

  // delegated moderation handlers for a chat log container
  function bindModHandlers(log, refresh) {
    log.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-adel]");
      const mute = e.target.closest("[data-amute]");
      if (del) {
        if (!(await U.confirmModal(t("mod.delMsgQ"), "", t("common.delete")))) return;
        const { error } = await API.adminDeleteMessage(del.dataset.akind, del.dataset.adel);
        if (error) return U.toast(error.message, "error");
        const node = del.closest(".chat-msg");
        if (node) node.remove();
        U.toast(t("mod.msgDeleted"), "good");
        if (refresh) refresh();
      } else if (mute) {
        await muteDialog(mute.dataset.amute);
      }
    });
  }

  // Global chat. container is the wrapper element; returns cleanup().
  function globalChat(container) {
    container.innerHTML = `
      <div class="chat-box small">
        <div class="chat-log" id="gchat-log"></div>
        <div class="chat-input" id="gchat-input"></div>
      </div>`;
    const log = U.qs("#gchat-log", container);
    const seen = new Set();
    let chan = null;
    let blocked = new Set();       // hide messages from players I blocked
    let pending = [];              // own optimistic messages: [{body, el}]
    const stopPollRef = { stop: null, stopVisible: null };

    function renderMsg(m) {
      const mine = App.user && m.user_id === App.user.id;
      const nm = mine ? ((App.profile && App.profile.username) || t("chat.you")) : nameOf(m.user_id);
      const who = m.user_id
        ? `<a class="user-link" href="#/profile/${m.user_id}">${U.esc(nm)}:</a> ${U.roleBadge(roleCache[m.user_id])}`
        : `<b>${U.esc(nm)}:</b>`;
      const d = U.el(`<div class="chat-msg ${mine ? "mine" : ""}" data-mid="${m.id}">
        ${who} ${U.linkify(m.body)}${modActionsHtml(Object.assign({ kind: "global" }, m))}</div>`);
      log.appendChild(d);
      while (log.children.length > 200) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
    }

    function addMsg(m) {
      if (seen.has(m.id)) return;
      // own message already shown optimistically: the match confirms it,
      // the optimistic copy is replaced by the full node (with actions)
      if (App.user && m.user_id === App.user.id) {
        const i = pending.findIndex(p => p.body === m.body);
        if (i >= 0) {
          seen.add(m.id);
          pending.splice(i, 1)[0].el.remove();
        }
      }
      seen.add(m.id);
      if (blocked.has(m.user_id) && !(App.user && m.user_id === App.user.id)) return; // hidden
      renderMsg(m);
    }

    (async function init() {
      if (App.user) blocked = await API.blockedIds();
      const { data } = await API.sb.from("chat_messages")
        .select("*, p:profiles(username,role)")
        .order("created_at", { ascending: false }).limit(50);
      const rows = (data || []).reverse();
      rows.forEach(m => { if (m.p) { nameCache[m.user_id] = m.p.username; roleCache[m.user_id] = m.p.role || "user"; } });
      if (!App.user) await fetchNames(rows.map(m => m.user_id));
      bindModHandlers(log);
      rows.forEach(addMsg);
      if (!rows.filter(m => !blocked.has(m.user_id)).length)
        log.innerHTML = `<div class="empty">${U.esc(t("chat.empty"))}</div>`;

      const me = App.user;
      const inp = U.qs("#gchat-input", container);
      if (me) {
        // own username comes from the profile (the RPC reply omits it)
        if (!nameCache[me.id]) {
          nameCache[me.id] = (App.profile && App.profile.username) || null;
          if (!nameCache[me.id]) {
            const { data: pr } = await API.sb.from("profiles")
              .select("username").eq("id", me.id).maybeSingle();
            if (pr) nameCache[me.id] = pr.username;
          }
        }
        inp.innerHTML = `
          <input id="gchat-text" maxlength="500" placeholder="${U.esc(t("chat.placeholder"))}">
          <button class="btn primary" id="gchat-send">→</button>`;
        const send = async () => {
          const inpEl = U.qs("#gchat-text", container);
          const body = inpEl.value.trim();
          if (!body) return;
          inpEl.value = "";
          log.querySelector(".empty") && log.querySelector(".empty").remove();
          // optimistic: show instantly, RPC in the background
          const nm = (App.profile && App.profile.username) || t("chat.you");
          const tmp = U.el(`<div class="chat-msg mine"><a class="user-link" href="#/profile/${me.id}">${U.esc(nm)}:</a> ${U.linkify(body)}</div>`);
          log.appendChild(tmp);
          log.scrollTop = log.scrollHeight;
          const pend = { body, el: tmp };
          pending.push(pend);
          const { data: res, error } = await API.sendGlobalChat(body);
          if (error) {
            tmp.remove();
            const i = pending.indexOf(pend);
            if (i >= 0) pending.splice(i, 1);
            U.toast(error.message, "error");
            inpEl.value = body;
            return;
          }
          if (res && res.message) {
            // confirm the optimistic copy and re-render the full node
            // (with moderation actions) unless realtime already did it
            const i = pending.indexOf(pend);
            if (!seen.has(res.message.id)) {
              seen.add(res.message.id);
              if (i >= 0) pending.splice(i, 1)[0].el.remove();
              renderMsg(res.message);
            } else if (i >= 0) pending.splice(i, 1);
          }
        };
        U.qs("#gchat-send", inp).addEventListener("click", send);
        U.qs("#gchat-text", inp).addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
      } else {
        inp.innerHTML = `<div class="empty" style="padding:6px">${t("chat.guestHint")}</div>`;
      }

      // realtime (RLS allows public reads, so guests receive rows too);
      // fetchFresh also serves fallback polling, reconnects, and tab returns
      async function fetchFresh() {
        if (App.user) blocked = await API.blockedIds();
        const { data: fresh } = await API.sb.from("chat_messages")
          .select("*, p:profiles(username,role)")
          .order("created_at", { ascending: false }).limit(50);
        if (!fresh) return;
        fresh.forEach(m => { if (m.p) { nameCache[m.user_id] = m.p.username; roleCache[m.user_id] = m.p.role || "user"; } });
        for (const m of fresh.reverse()) {
          if (seen.has(m.id)) continue;
          const isBlocked = blocked.has(m.user_id) && !(App.user && m.user_id === App.user.id);
          seen.add(m.id);
          if (isBlocked) continue;
          log.querySelector(".empty") && log.querySelector(".empty").remove();
          renderMsg(m);
          if (App.user && m.user_id !== App.user.id) U.soundMove();
        }
      }

      chan = API.subscribeInserts("chat_messages", null, async (row) => {
        if (!(row.user_id in nameCache)) await fetchNames([row.user_id]);
        log.querySelector(".empty") && log.querySelector(".empty").remove();
        addMsg(row);
      }, (status) => {
        if (status === "SUBSCRIBED" && stopPollRef._everDown) fetchFresh();
        stopPollRef._everDown = status !== "SUBSCRIBED";
      });

      // fallback polling ticks only while the websocket is down; hidden tabs and live realtime produce zero requests
      stopPollRef.stop = API.poll(4000, fetchFresh, () => API.chUp(chan));
      stopPollRef.stopVisible = API.onVisible(fetchFresh);
    })();

    return function cleanup() {
      if (stopPollRef.stop) stopPollRef.stop();
      if (stopPollRef.stopVisible) stopPollRef.stopVisible();
      API.unsubscribe(chan);
    };
  }

  const notAuthBox = (text) => `
    <div class="empty">${text || t("common.authOnly")} ·
      <a href="#/login">${t("nav.login")}</a> / <a href="#/signup">${t("nav.signup")}</a></div>`;

  // Dialog list
  const MessagesPage_render = async function (container) {
    const me = App.user || await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>${U.esc(t("dm.title"))}</h1>
        ${me ? `<button class="btn primary" id="dm-new">${U.esc(t("dm.new"))}</button>`
             : notAuthBox("")}</div>
      <div class="card" id="dm-list"><span class="spinner"></span></div>`;
    if (!me) { U.qs("#dm-list").innerHTML = ""; return () => {}; }

      U.qs("#dm-new").addEventListener("click", async () => {
      const res = await U.formModal(t("dm.newTitle"), [
        { id: "name", label: t("dm.recipient"), maxlength: 20, placeholder: t("dm.recipientPh") }
      ], t("dm.open"));
      if (!res) return;
      const name = res.name.trim();
      if (!name) return;
      const { data, error } = await API.sb.from("profiles")
        .select("id,username").ilike("username", name).limit(1);
      if (error || !data || !data.length) return U.toast(t("dm.notFound"), "error");
      App.go(`/dm/${data[0].id}`);
    });

    const box = U.qs("#dm-list");
    let stopPoll = null, stopVisible = null, chan = null;
    let lastSig = "";

    async function renderDialogs() {
      const { data: msgs } = await API.sb.from("dm_messages")
        .select("*, s:profiles!dm_messages_sender_id_fkey(id,username), r:profiles!dm_messages_recipient_id_fkey(id,username)")
        .or(`sender_id.eq.${me.id},recipient_id.eq.${me.id}`)
        .order("created_at", { ascending: false }).limit(300);

      // group by conversation partner
      const convs = {};
      (msgs || []).forEach(m => {
        const pid = m.sender_id === me.id ? m.recipient_id : m.sender_id;
        if (!convs[pid]) convs[pid] = { partner: pid, last: m, unread: 0 };
        if (m.recipient_id === me.id && !m.read_at) convs[pid].unread++;
      });
      const list = Object.values(convs).sort((a, b) =>
        U.parseTs(b.last.created_at) - U.parseTs(a.last.created_at));

      // unchanged: leave the DOM alone
      const sig = list.map(c => [c.partner, c.unread, c.last.body, c.last.sender_id === me.id ? 1 : 0].join("~")).join("|");
      if (sig === lastSig) return;
      lastSig = sig;

      if (!list.length) {
        box.innerHTML = `<div class="empty">${U.esc(t("dm.empty"))}</div>`;
        return;
      }
      box.innerHTML = list.map(c => {
        const p = c.last.s && c.last.s.id === me.id ? c.last.r : c.last.s;
        const pname = p ? p.username : (nameOf(c.partner) !== "?" ? nameOf(c.partner) : "…");
        nameCache[c.partner] = pname;
        const out = c.last.sender_id === me.id;
        return `<div class="list-item">
          <a href="#/profile/${c.partner}" title="${U.esc(t("dm.profileTitle", { name: pname }))}"><span class="avatar">${U.esc((pname || "?")[0].toUpperCase())}</span></a>
          <div style="flex:1;min-width:0">
            <a href="#/dm/${c.partner}" style="font-weight:700">${U.esc(pname)}</a>
            <a class="muted small" href="#/profile/${c.partner}" title="${U.esc(t("dm.profileTitle", { name: pname }))}">${U.esc(t("dm.profileLink"))}</a>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${out ? `<b>${U.esc(t("chat.youPrefix"))}</b> ` : ""}${U.esc(c.last.body)}</div>
          </div>
          <div style="text-align:right">
            <div class="muted small">${U.fmtDate(c.last.created_at)}</div>
            ${c.unread ? `<span class="nav-badge inline">${c.unread}</span>` : ""}
          </div>
        </div>`;
      }).join("");
    }
    await renderDialogs();
    let lastRt = null, _wasDown = false;
    // the dialog list lives on realtime; polling covers websocket outages
    chan = API.subscribeInserts("dm_messages", null, () => {
      clearTimeout(lastRt);
      lastRt = setTimeout(() => renderDialogs().catch(() => {}), 300);
    }, (status) => {
      if (status === "SUBSCRIBED" && _wasDown) renderDialogs().catch(() => {});
      _wasDown = status !== "SUBSCRIBED";
    });
    stopPoll = API.poll(8000, () => {
      // leave the DOM alone while typing in the modal
      if (U.qs("#modal-root").childElementCount) return;
      renderDialogs().catch(() => {});
    }, () => API.chUp(chan));
    stopVisible = API.onVisible(() => renderDialogs().catch(() => {}));
    return function () { if (stopPoll) stopPoll(); if (stopVisible) stopVisible(); API.unsubscribe(chan); };
  };

  // Conversation thread
  const ThreadPage_render = async function (container, partnerId) {
    const me = App.user || await API.user();
    if (!me) {
      container.innerHTML = `<div class="card">${notAuthBox(t("dm.authHint"))}</div>`;
      return () => {};
    }
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: p } = await API.sb.from("profiles")
      .select("id,username,rating,last_seen_at,is_banned").eq("id", partnerId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">${U.esc(t("dm.notFound"))}</div>`; return () => {}; }
    nameCache[p.id] = p.username;

    container.innerHTML = `
      <p><a href="#/dm">${U.esc(t("dm.back"))}</a></p>
      <div class="card">
        <div class="row">
          <span class="avatar big">${U.esc((p.username || "?")[0].toUpperCase())}</span>
          <div>
            <h2 style="margin:0"><a href="#/profile/${p.id}">${U.esc(p.username)}</a>
              ${p.is_banned ? `<span class="badge danger">${U.esc(t("profile.bannedBadge"))}</span>` : ""}
              <span class="online-dot ${Pages.isOnline(p) ? "" : "off"}" title="${U.esc(t("status.online"))}"></span></h2>
            <span class="muted small">${U.esc(t("dm.rating", { rating: p.rating }))}</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="chat-box tall">
          <div class="chat-log" id="dm-log"></div>
          <div class="chat-input">
            <input id="dm-text" maxlength="2000" placeholder="${U.esc(t("dm.placeholder"))}">
            <button class="btn primary" id="dm-send">→</button>
          </div>
        </div>
      </div>`;

    const log = U.qs("#dm-log");
    const seen = new Set();
    let chan = null, stopPoll = null, stopVisible = null;
    let pending = [];              // own optimistic messages: [{body, el}]

    function addMsg(m) {
      if (seen.has(m.id)) return;
      // own message already shown optimistically: treat the match as confirmation
      if (m.sender_id === me.id) {
        const i = pending.findIndex(p => p.body === m.body);
        if (i >= 0) {
          seen.add(m.id);
          pending.splice(i, 1);
          return;
        }
      }
      seen.add(m.id);
      const mine = m.sender_id === me.id;
      const who = mine
        ? `<a class="user-link" href="#/profile/${me.id}">${U.esc(t("chat.youPrefix"))}</a>`
        : `<a class="user-link" href="#/profile/${p.id}">${U.esc(p.username)}:</a>`;
      const d = U.el(`<div class="chat-msg ${mine ? "mine" : ""}">
        ${who} ${U.linkify(m.body)}
        <span class="muted tiny">${U.fmtDate(m.created_at)}</span></div>`);
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    const { data: msgs } = await API.sb.from("dm_messages")
      .select("*")
      .or(`and(sender_id.eq.${me.id},recipient_id.eq.${p.id}),and(sender_id.eq.${p.id},recipient_id.eq.${me.id})`)
      .order("created_at").limit(300);
    (msgs || []).forEach(addMsg);
    if (!msgs || !msgs.length) log.innerHTML = `<div class="empty">${U.esc(t("dm.startChat"))}</div>`;
    await API.markDmsRead(p.id);

    const send = async () => {
      const inpEl = U.qs("#dm-text");
      const body = inpEl.value.trim();
      if (!body) return;
      inpEl.value = "";
      log.querySelector(".empty") && log.querySelector(".empty").remove();
      // optimistic: show instantly, RPC in the background
      const tmp = U.el(`<div class="chat-msg mine"><a class="user-link" href="#/profile/${me.id}">${U.esc(t("chat.youPrefix"))}</a> ${U.linkify(body)}
        <span class="muted tiny">${U.fmtDate(new Date().toISOString())}</span></div>`);
      log.appendChild(tmp);
      log.scrollTop = log.scrollHeight;
      const pend = { body, el: tmp };
      pending.push(pend);
      const { data: res, error } = await API.sendDm(p.id, body);
      if (error) {
        tmp.remove();
        const i = pending.indexOf(pend);
        if (i >= 0) pending.splice(i, 1);
        U.toast(error.message, "error");
        inpEl.value = body;
        return;
      }
      if (res && res.message) seen.add(res.message.id); // no duplicates later
      const i = pending.indexOf(pend);
      if (i >= 0) pending.splice(i, 1);
    };
    U.qs("#dm-send").addEventListener("click", send);
    U.qs("#dm-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

    // fresh fetch shared by fallback polling, reconnects, and tab returns; seen dedup prevents extra renders
    async function fetchFresh() {
      const { data: fresh } = await API.sb.from("dm_messages")
        .select("*")
        .or(`and(sender_id.eq.${me.id},recipient_id.eq.${p.id}),and(sender_id.eq.${p.id},recipient_id.eq.${me.id})`)
        .order("created_at", { ascending: false }).limit(30);
      if (!fresh) return;
      let gotNew = false;
      for (const m of fresh.reverse()) {
        if (seen.has(m.id)) continue;
        log.querySelector(".empty") && log.querySelector(".empty").remove();
        addMsg(m);
        if (m.sender_id === p.id) gotNew = true;
      }
      if (gotNew) { U.soundMove(); await API.markDmsRead(p.id); }
    }

    let _wasDown = false;
    chan = API.subscribeInserts("dm_messages", null, async (row) => {
      const involved = (row.sender_id === me.id && row.recipient_id === p.id) ||
                       (row.sender_id === p.id && row.recipient_id === me.id);
      if (!involved) return;
      log.querySelector(".empty") && log.querySelector(".empty").remove();
      addMsg(row);
      if (row.sender_id === p.id) {
        U.soundMove();
        await API.markDmsRead(p.id);
      }
    }, (status) => {
      if (status === "SUBSCRIBED" && _wasDown) fetchFresh();
      _wasDown = status !== "SUBSCRIBED";
    });

    // fallback polling only while the websocket is down; sleeps in hidden tabs
    stopPoll = API.poll(3000, fetchFresh, () => API.chUp(chan));
    stopVisible = API.onVisible(fetchFresh);

    return function cleanup() { if (stopPoll) stopPoll(); if (stopVisible) stopVisible(); API.unsubscribe(chan); };
  };

  window.Social = {
    globalChat,
    messages: MessagesPage_render,
    thread: ThreadPage_render
  };
})();
