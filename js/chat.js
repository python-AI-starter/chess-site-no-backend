// ============================================================
//  Соцсеть: общий чат (лобби) и личные сообщения.
//  Гости читают общий чат; писать — только после входа (RPC).
// ============================================================
(function () {
  "use strict";

  // кэш ников для realtime-строк
  const nameCache = {};
  async function fetchNames(ids) {
    const need = ids.filter(id => id && !(id in nameCache));
    if (!need.length) return;
    const { data } = await API.sb.from("profiles").select("id,username").in("id", need);
    (data || []).forEach(p => { nameCache[p.id] = p.username; });
  }
  const nameOf = (id) => nameCache[id] || "?";

  // ================= ОБЩИЙ ЧАТ =================
  // container: элемент-обёртка. Возвращает cleanup().
  function globalChat(container) {
    container.innerHTML = `
      <div class="chat-box small">
        <div class="chat-log" id="gchat-log"></div>
        <div class="chat-input" id="gchat-input"></div>
      </div>`;
    const log = U.qs("#gchat-log", container);
    const seen = new Set();
    let chan = null;
    let blocked = new Set();       // скрывать сообщения заблокированных мною
    const stopPollRef = { stop: null, stopVisible: null };

    function addMsg(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      if (blocked.has(m.user_id) && !(App.user && m.user_id === App.user.id)) return; // скрыто
      const mine = App.user && m.user_id === App.user.id;
      const nm = mine ? ((App.profile && App.profile.username) || "Вы") : nameOf(m.user_id);
      const who = m.user_id
        ? `<a class="user-link" href="#/profile/${m.user_id}">${U.esc(nm)}:</a>`
        : `<b>${U.esc(nm)}:</b>`;
      const d = U.el(`<div class="chat-msg ${mine ? "mine" : ""}">
        ${who} ${U.linkify(m.body)}</div>`);
      log.appendChild(d);
      while (log.children.length > 200) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
    }

    (async function init() {
      if (App.user) blocked = await API.blockedIds();
      const { data } = await API.sb.from("chat_messages")
        .select("*, p:profiles(username)")
        .order("created_at", { ascending: false }).limit(50);
      const rows = (data || []).reverse();
      rows.forEach(m => { if (m.p) nameCache[m.user_id] = m.p.username; });
      if (!App.user) await fetchNames(rows.map(m => m.user_id));
      rows.forEach(addMsg);
      if (!rows.filter(m => !blocked.has(m.user_id)).length)
        log.innerHTML = `<div class="empty">Пусто. Начните беседу!</div>`;

      const me = App.user;
      const inp = U.qs("#gchat-input", container);
      if (me) {
        // свой ник — из профиля (RPC-ответ его не содержит)
        if (!nameCache[me.id]) {
          nameCache[me.id] = (App.profile && App.profile.username) || null;
          if (!nameCache[me.id]) {
            const { data: pr } = await API.sb.from("profiles")
              .select("username").eq("id", me.id).maybeSingle();
            if (pr) nameCache[me.id] = pr.username;
          }
        }
        inp.innerHTML = `
          <input id="gchat-text" maxlength="500" placeholder="Сообщение…">
          <button class="btn primary" id="gchat-send">→</button>`;
        const send = async () => {
          const t = U.qs("#gchat-text", container);
          const body = t.value.trim();
          if (!body) return;
          t.value = "";
          const { data: res, error } = await API.sendGlobalChat(body);
          if (error) { U.toast(error.message, "error"); t.value = body; return; }
          log.querySelector(".empty") && log.querySelector(".empty").remove();
          addMsg(res.message);
        };
        U.qs("#gchat-send", inp).addEventListener("click", send);
        U.qs("#gchat-text", inp).addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
      } else {
        inp.innerHTML = `<div class="empty" style="padding:6px">Войдите, чтобы писать в общий чат ·
          <a href="#/login">вход</a> / <a href="#/signup">регистрация</a></div>`;
      }

      // realtime (RLS: публичное чтение — гостей тоже доставит)
      // доза-fetch новых сообщений: используется и поллингом-фоллбэком,
      // и при переподключении websocket, и при возврате во вкладку
      async function fetchFresh() {
        if (App.user) blocked = await API.blockedIds();
        const { data: fresh } = await API.sb.from("chat_messages")
          .select("*, p:profiles(username)")
          .order("created_at", { ascending: false }).limit(50);
        if (!fresh) return;
        fresh.forEach(m => { if (m.p) nameCache[m.user_id] = m.p.username; });
        for (const m of fresh.reverse()) {
          if (seen.has(m.id)) continue;
          const isBlocked = blocked.has(m.user_id) && !(App.user && m.user_id === App.user.id);
          seen.add(m.id);
          if (isBlocked) continue;
          log.querySelector(".empty") && log.querySelector(".empty").remove();
          addMsg(m);
          if (App.user && m.user_id !== App.user.id) U.soundMove();
        }
      }

      chan = API.subscribeInserts("chat_messages", null, async (row) => {
        if (!(row.user_id in nameCache)) await fetchNames([row.user_id]);
        log.querySelector(".empty") && log.querySelector(".empty").remove();
        addMsg(row);
        if (App.user && row.user_id !== App.user.id) U.soundMove();
      }, (status) => {
        if (status === "SUBSCRIBED" && stopPollRef._everDown) fetchFresh();
        stopPollRef._everDown = status !== "SUBSCRIBED";
      });

      // fallback-поллинг — тикает ТОЛЬКО когда websocket не поднялся;
      // в скрытой вкладке и при живом realtime — ноль запросов
      stopPollRef.stop = API.poll(4000, fetchFresh, () => API.chUp(chan));
      stopPollRef.stopVisible = API.onVisible(fetchFresh);
    })();

    return function cleanup() {
      if (stopPollRef.stop) stopPollRef.stop();
      if (stopPollRef.stopVisible) stopPollRef.stopVisible();
      API.unsubscribe(chan);
    };
  }

  // ================= СПИСОК ДИАЛОГОВ =================
  const MessagesPage_render = async function (container) {
    const me = App.user || await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>Сообщения</h1>
        ${me ? `<button class="btn primary" id="dm-new">+ Написать</button>`
             : notAuthBox("")}</div>
      <div class="card" id="dm-list"><span class="spinner"></span></div>`;
    if (!me) { U.qs("#dm-list").innerHTML = ""; return () => {}; }

      U.qs("#dm-new").addEventListener("click", async () => {
      const res = await U.formModal("Новое сообщение", [
        { id: "name", label: "Ник получателя", maxlength: 20, placeholder: "например, Magnus" }
      ], "Открыть переписку");
      if (!res) return;
      const name = res.name.trim();
      if (!name) return;
      const { data, error } = await API.sb.from("profiles")
        .select("id,username").ilike("username", name).limit(1);
      if (error || !data || !data.length) return U.toast("Игрок не найден", "error");
      location.hash = `#/dm/${data[0].id}`;
    });

    const box = U.qs("#dm-list");
    let stopPoll = null, stopVisible = null, chan = null;
    let lastSig = "";

    async function renderDialogs() {
      const { data: msgs } = await API.sb.from("dm_messages")
        .select("*, s:profiles!dm_messages_sender_id_fkey(id,username), r:profiles!dm_messages_recipient_id_fkey(id,username)")
        .or(`sender_id.eq.${me.id},recipient_id.eq.${me.id}`)
        .order("created_at", { ascending: false }).limit(300);

      // группируем по собеседнику
      const convs = {};
      (msgs || []).forEach(m => {
        const pid = m.sender_id === me.id ? m.recipient_id : m.sender_id;
        if (!convs[pid]) convs[pid] = { partner: pid, last: m, unread: 0 };
        if (m.recipient_id === me.id && !m.read_at) convs[pid].unread++;
      });
      const list = Object.values(convs).sort((a, b) =>
        U.parseTs(b.last.created_at) - U.parseTs(a.last.created_at));

      // ничего не изменилось — DOM не трогаем (без мерцания)
      const sig = list.map(c => [c.partner, c.unread, c.last.body, c.last.sender_id === me.id ? 1 : 0].join("~")).join("|");
      if (sig === lastSig) return;
      lastSig = sig;

      if (!list.length) {
        box.innerHTML = `<div class="empty">Писем пока нет. Нажмите «+ Написать» или
          напишите игроку с его профиля.</div>`;
        return;
      }
      box.innerHTML = list.map(c => {
        const p = c.last.s && c.last.s.id === me.id ? c.last.r : c.last.s;
        const pname = p ? p.username : (nameOf(c.partner) !== "?" ? nameOf(c.partner) : "…");
        nameCache[c.partner] = pname;
        const out = c.last.sender_id === me.id;
        return `<div class="list-item">
          <a href="#/profile/${c.partner}" title="Профиль ${U.esc(pname)}"><span class="avatar">${U.esc((pname || "?")[0].toUpperCase())}</span></a>
          <div style="flex:1;min-width:0">
            <a href="#/dm/${c.partner}" style="font-weight:700">${U.esc(pname)}</a>
            <a class="muted small" href="#/profile/${c.partner}" title="Профиль"> · профиль</a>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${out ? "<b>Вы:</b> " : ""}${U.esc(c.last.body)}</div>
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
    // список диалогов живёт на realtime: новое письмо — мгновенно;
    // поллинг тикает только когда websocket не поднялся
    chan = API.subscribeInserts("dm_messages", null, () => {
      clearTimeout(lastRt);
      lastRt = setTimeout(() => renderDialogs().catch(() => {}), 300);
    }, (status) => {
      if (status === "SUBSCRIBED" && _wasDown) renderDialogs().catch(() => {});
      _wasDown = status !== "SUBSCRIBED";
    });
    stopPoll = API.poll(8000, () => {
      // не трогаем DOM во время набора текста в модалке
      if (U.qs("#modal-root").childElementCount) return;
      renderDialogs().catch(() => {});
    }, () => API.chUp(chan));
    stopVisible = API.onVisible(() => renderDialogs().catch(() => {}));
    return function () { if (stopPoll) stopPoll(); if (stopVisible) stopVisible(); API.unsubscribe(chan); };
  };

  const notAuthBox = (text) => `
    <div class="empty">${text || "Только для авторизованных"} ·
      <a href="#/login">войти</a> / <a href="#/signup">регистрация</a></div>`;

  // ================= ПЕРЕПИСКА =================
  const ThreadPage_render = async function (container, partnerId) {
    const me = App.user || await API.user();
    if (!me) {
      container.innerHTML = `<div class="card">${notAuthBox("Чтобы переписываться")}</div>`;
      return () => {};
    }
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: p } = await API.sb.from("profiles")
      .select("id,username,rating,last_seen_at,is_banned").eq("id", partnerId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">Игрок не найден</div>`; return () => {}; }
    nameCache[p.id] = p.username;

    container.innerHTML = `
      <p><a href="#/dm">← Все сообщения</a></p>
      <div class="card">
        <div class="row">
          <span class="avatar big">${U.esc((p.username || "?")[0].toUpperCase())}</span>
          <div>
            <h2 style="margin:0"><a href="#/profile/${p.id}">${U.esc(p.username)}</a>
              ${p.is_banned ? '<span class="badge danger">заблокирован</span>' : ""}
              <span class="online-dot ${Pages.isOnline(p) ? "" : "off"}" title="онлайн"></span></h2>
            <span class="muted small">Рейтинг: ${p.rating}</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="chat-box tall">
          <div class="chat-log" id="dm-log"></div>
          <div class="chat-input">
            <input id="dm-text" maxlength="2000" placeholder="Личное сообщение…">
            <button class="btn primary" id="dm-send">→</button>
          </div>
        </div>
      </div>`;

    const log = U.qs("#dm-log");
    const seen = new Set();
    let chan = null, stopPoll = null, stopVisible = null;

    function addMsg(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const mine = m.sender_id === me.id;
      const who = mine
        ? `<a class="user-link" href="#/profile/${me.id}">Вы:</a>`
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
    if (!msgs || !msgs.length) log.innerHTML = `<div class="empty">Начните переписку!</div>`;
    await API.markDmsRead(p.id);

    const send = async () => {
      const t = U.qs("#dm-text");
      const body = t.value.trim();
      if (!body) return;
      t.value = "";
      const { data: res, error } = await API.sendDm(p.id, body);
      if (error) { U.toast(error.message, "error"); t.value = body; return; }
      log.querySelector(".empty") && log.querySelector(".empty").remove();
      addMsg(res.message);
    };
    U.qs("#dm-send").addEventListener("click", send);
    U.qs("#dm-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

    // доза-fetch новых писем: общий для поллинга-фоллбэка, переподключения
    // websocket и возврата во вкладку (дедуп seen — лишнего рендера нет)
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

    // fallback-поллинг — только когда websocket не поднялся; в скрытой вкладке спит
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
