// Community: forum, clubs, blog.
(function () {
  "use strict";

  const t = (key, params) => I18n.t(key, params);
  // alias: the thread page keeps a local variable named t (thread row)
  const t_ = t;

  const notAuthBox = (text) => `
    <div class="empty">${text || t("common.authOnly")} ·
      <a href="#/login">${t("nav.login")}</a> / <a href="#/signup">${t("nav.signup")}</a></div>`;

  // moderation (creator/admin; final checks live in the database)
  async function modProfile() {
    const me = App.user || await API.user();
    if (!me) return null;
    if (App.profile && App.profile.id === me.id) return App.profile;
    return await API.profile(me.id);
  }
  const isMod = (pr) => !!pr && (pr.role === "creator" || pr.role === "admin");
  // deleting whole content units (threads, clubs, blog posts) is a
  // creator-only power; moderators delete individual public messages
  const isCreator = (pr) => !!pr && pr.role === "creator";
  // moderator buttons on club chat messages, as in the global chat:
  // delete for any message including the moderator's own (muting
  // yourself is denied), mute for other people's messages only
  function clubModActionsHtml(m) {
    if (!U.amMod() || !m.user_id) return "";
    const own = App.user && m.user_id === App.user.id;
    return `<span class="msg-mod">
      ${own ? "" : `<button class="mod-btn" data-amute="${m.user_id}" title="${U.esc(t("mod.muteAuthorTitle"))}">🔇</button>`}
      <button class="mod-btn" data-adel="${m.id}" data-akind="club" title="${U.esc(own ? t("mod.delOwnTitle") : t("mod.delTitle"))}">×</button>
    </span>`;
  }

  // Forum
  const ForumPage_render = async function (container) {
    const me = await API.user();
    const creator = isCreator(await modProfile());
    container.innerHTML = `
      <div class="row spread"><h1>${U.esc(t("forum.title"))}</h1>
        ${me ? `<button class="btn primary" id="f-new">${U.esc(t("forum.new"))}</button>` : notAuthBox("")}</div>
      <div class="card" id="threads"><span class="spinner"></span></div>`;
    if (me) {
      U.qs("#f-new").addEventListener("click", async () => {
        const res = await U.formModal(t("forum.newTitle"), [
          { id: "title", label: t("forum.titleLabel"), maxlength: 120,
            placeholder: t("forum.titlePh") },
          { id: "body", label: t("forum.bodyLabel"), type: "textarea", rows: 7,
            maxlength: 10000, placeholder: t("forum.bodyPh") }
        ], t("forum.create"));
        if (!res) return;
        const title = res.title.trim();
        const body = res.body.trim();
        if (title.length < 3) return U.toast(t("forum.titleShort"), "error");
        if (!body) return U.toast(t("forum.bodyRequired"), "error");
        const { error } = await API.sb.from("forum_threads").insert({
          author_id: me.id, title, body
        });
        if (error) U.toast(error.message, "error");
        else { U.toast(t("forum.created"), "good"); App.route(); }
      });
    }
    const { data } = await API.sb.from("forum_threads")
      .select("*, a:profiles!forum_threads_author_id_fkey(id,username,role)")
      .order("created_at", { ascending: false }).limit(50);
    const { count } = await API.sb.from("forum_replies").select("id", { count: "exact", head: true });
    const box = U.qs("#threads");
    const replies = await API.sb.from("forum_replies").select("thread_id").limit(500);
    const cnt = {};
    (replies.data || []).forEach(r => cnt[r.thread_id] = (cnt[r.thread_id] || 0) + 1);
    box.innerHTML = (data || []).length ? (data || []).map(t2 => `
      <div class="list-item">
        <div style="flex:1">
          <a href="#/forum/${t2.id}" style="font-weight:700;font-size:16px">${U.esc(t2.title)}</a>
          <div class="muted small"><a href="#/profile/${t2.a ? t2.a.id : ""}">${U.esc(t2.a ? t2.a.username : "?")}</a> ${U.roleBadge(t2.a && t2.a.role)} · ${U.fmtDate(t2.created_at)}</div>
        </div>
        <span class="badge">${U.esc(t("forum.replies", { n: cnt[t2.id] || 0 }))}</span>
        ${creator ? `<button class="btn ghost small" data-tdel="${t2.id}" title="${U.esc(t("forum.delTitle"))}">🗑</button>` : ""}
      </div>`).join("") : `<div class="empty">${U.esc(t("forum.empty"))}</div>`;
    if (creator) U.qsa("[data-tdel]", box).forEach(b => b.addEventListener("click", async () => {
      if (!(await U.confirmDanger(t("forum.delThreadQ"), "", t("common.delete")))) return;
      const { error } = await API.adminDeleteThread(b.dataset.tdel);
      if (error) U.toast(error.message, "error"); else App.route();
    }));
    return () => {};
  };

  const ThreadPage_render = async function (container, threadId) {
    const me = await API.user();
    const my = await modProfile();
    const mod = isMod(my);
    const creator = isCreator(my);
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: t } = await API.sb.from("forum_threads")
      .select("*, a:profiles!forum_threads_author_id_fkey(id,username,role)").eq("id", threadId).maybeSingle();
    if (!t) { container.innerHTML = `<div class="card center">${U.esc(t_("forum.notFound"))}</div>`; return () => {}; }
    const { data: reps } = await API.sb.from("forum_replies")
      .select("*, a:profiles!forum_replies_author_id_fkey(id,username,role)")
      .eq("thread_id", threadId).order("created_at");

    container.innerHTML = `
      <p><a href="#/forum">${U.esc(t_("forum.back"))}</a></p>
      <div class="card">
        <h1>${U.esc(t.title)}</h1>
        <div class="row"><span class="avatar">${U.esc((t.a && t.a.username || "?")[0].toUpperCase())}</span>
          <a href="#/profile/${t.a ? t.a.id : ""}"><b>${U.esc(t.a ? t.a.username : "?")}</b></a>
          ${U.roleBadge(t.a && t.a.role)}
          <span class="muted small">${U.fmtDate(t.created_at)}</span>
          ${me && (t.author_id === me.id || creator) ? `<button class="btn ghost small" id="t-del">${U.esc(t_("forum.delTitle"))}</button>` : ""}
        </div>
        <div class="content-text" style="margin-top:12px">${U.esc(t.body)}</div>
      </div>
      <div class="card"><h3>${U.esc(t_("forum.repliesCount", { n: (reps || []).length }))}</h3><div id="replies">
        ${(reps || []).map(r => `
          <div class="list-item">
            <span class="avatar">${U.esc((r.a && r.a.username || "?")[0].toUpperCase())}</span>
            <div style="flex:1"><a href="#/profile/${r.a ? r.a.id : ""}"><b>${U.esc(r.a ? r.a.username : "?")}</b></a>
              ${U.roleBadge(r.a && r.a.role)}
              <span class="muted small">${U.fmtDate(r.created_at)}</span>
              <div class="content-text">${U.esc(r.body)}</div></div>
            ${me && (r.author_id === me.id || mod) ? `<button class="btn ghost small" data-del="${r.id}" data-mod="${mod && r.author_id !== me.id ? 1 : 0}">×</button>` : ""}
          </div>`).join("") || `<div class="empty">${U.esc(t_("forum.noReplies"))}</div>`}
      </div></div>
      <div class="card">${me ? `
        <h3>${U.esc(t_("forum.yourReply"))}</h3>
        <textarea id="r-body" rows="4" maxlength="5000"></textarea>
        <button class="btn primary" id="r-send" style="margin-top:10px">${U.esc(t_("common.send"))}</button>`
        : notAuthBox(t_("forum.authToReply"))}</div>`;

    U.qsa("[data-del]").forEach(b => b.addEventListener("click", async () => {
      const modAction = b.dataset.mod === "1";
      if (modAction) {
        if (!(await U.confirmModal(t_("forum.delReplyQ"), "", t_("common.delete")))) return;
        const { error } = await API.adminDeleteReply(b.dataset.del);
        if (error) U.toast(error.message, "error"); else App.route();
      } else {
        if (!(await U.confirmModal(t_("forum.delReplyQ"), "", t_("common.delete")))) return;
        const { error } = await API.sb.from("forum_replies").delete().eq("id", b.dataset.del);
        if (error) U.toast(error.message, "error"); else App.route();
      }
    }));
    const tDel = U.qs("#t-del");
    if (tDel) tDel.addEventListener("click", async () => {
      if (creator && t.author_id !== me.id) {
        // deleting someone else's thread asks for a double confirmation
        if (!(await U.confirmDanger(t_("forum.delThreadQ"), "", t_("common.delete")))) return;
        const { error } = await API.adminDeleteThread(threadId);
        if (error) U.toast(error.message, "error"); else location.hash = "#/forum";
      } else {
        if (!(await U.confirmModal(t_("forum.delThreadQ"), "", t_("common.delete")))) return;
        const { error } = await API.sb.from("forum_threads").delete().eq("id", threadId);
        if (error) U.toast(error.message, "error"); else location.hash = "#/forum";
      }
    });
    const send = U.qs("#r-send");
    if (send) send.addEventListener("click", async () => {
      const body = U.qs("#r-body").value.trim();
      if (!body) return;
      const { error } = await API.sb.from("forum_replies")
        .insert({ thread_id: threadId, author_id: me.id, body });
      if (error) U.toast(error.message, "error"); else App.route();
    });
    return () => {};
  };

  // Clubs
  const ClubsPage_render = async function (container) {
    const me = await API.user();
    const creator = isCreator(await modProfile());
    container.innerHTML = `
      <div class="row spread"><h1>${U.esc(t("clubs.title"))}</h1></div>
      ${me ? `<div class="card">
        <h3>${U.esc(t("clubs.createTitle"))}</h3>
        <div class="row">
          <input id="c-name" placeholder="${U.esc(t("clubs.namePh"))}" maxlength="40" style="flex:1">
          <button class="btn primary" id="c-go">${U.esc(t("clubs.create"))}</button>
        </div>
        <textarea id="c-desc" rows="2" maxlength="1000" placeholder="${U.esc(t("clubs.descPh"))}" style="margin-top:8px"></textarea>
      </div>` : notAuthBox(t("clubs.authHint"))}
      <div class="card" id="clubs"><span class="spinner"></span></div>`;
    if (me) U.qs("#c-go").addEventListener("click", async () => {
      const name = U.qs("#c-name").value.trim();
      const description = U.qs("#c-desc").value.trim();
      if (name.length < 3) return U.toast(t("clubs.nameShort"), "error");
      const { error } = await API.sb.from("clubs").insert({ name, description, owner_id: me.id });
      if (error) U.toast(error.message, "error");
      else { U.toast(t("clubs.created"), "good"); App.route(); }
    });
    const { data } = await API.sb.from("clubs")
      .select("*, o:profiles!clubs_owner_id_fkey(id,username,role), m:club_members(count)")
      .order("created_at", { ascending: false }).limit(50);
    U.qs("#clubs").innerHTML = (data || []).map(c => `
      <div class="list-item">
        <span class="avatar">${U.esc(c.name[0].toUpperCase())}</span>
        <div style="flex:1">
          <a href="#/clubs/${c.id}" style="font-weight:700;font-size:16px">${U.esc(c.name)}</a>
          <div class="muted small">${U.esc(t("clubs.owner"))} <a href="#/profile/${c.o ? c.o.id : ""}">${U.esc(c.o ? c.o.username : "?")}</a> ${U.roleBadge(c.o && c.o.role)} ${U.esc(t("clubs.members", { n: c.m && c.m[0] ? c.m[0].count : 1 }))}</div>
        </div>
        ${creator ? `<button class="btn ghost small" data-cdel="${c.id}" title="${U.esc(t("clubs.delTitle"))}">🗑</button>` : ""}
      </div>`).join("") || `<div class="empty">${U.esc(t("clubs.empty"))}</div>`;
    if (creator) U.qsa("[data-cdel]", U.qs("#clubs")).forEach(b => b.addEventListener("click", async () => {
      if (!(await U.confirmDanger(t("clubs.delQ"), t("common.irreversible"), t("common.delete")))) return;
      const { error } = await API.adminDeleteClub(b.dataset.cdel);
      if (error) U.toast(error.message, "error"); else App.route();
    }));
    return () => {};
  };

  const ClubPage_render = async function (container, clubId) {
    const me = await API.user();
    const my = await modProfile();
    const creator = isCreator(my);
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: c } = await API.sb.from("clubs")
      .select("*, o:profiles!clubs_owner_id_fkey(id,username)").eq("id", clubId).maybeSingle();
    if (!c) { container.innerHTML = `<div class="card center">${U.esc(t("clubs.notFound"))}</div>`; return () => {}; }
    const { data: members } = await API.sb.from("club_members")
      .select("*, p:profiles!club_members_user_id_fkey(id,username,rating,role)")
      .eq("club_id", clubId).order("joined_at");
    const myMember = me && (members || []).find(m => m.user_id === me.id);
    const isOwner = me && c.owner_id === me.id;
    const canChat = !!(me && myMember);

    // club chat history (RLS: members only)
    let msgs = [];
    if (canChat) {
      const { data } = await API.sb.from("club_chat")
        .select("*, p:profiles(username,role)").eq("club_id", clubId).order("created_at");
      msgs = data || [];
    }

    container.innerHTML = `
      <p><a href="#/clubs">${U.esc(t("clubs.back"))}</a></p>
      <div class="card">
        <div class="row spread">
          <div class="row">
            <span class="avatar big">${U.esc(c.name[0].toUpperCase())}</span>
            <div><h1 style="margin:0">${U.esc(c.name)}</h1>
            <span class="muted small">${U.esc(t("clubs.owner"))} <a href="#/profile/${c.owner_id}">${U.esc(c.o ? c.o.username : "?")}</a>
              ${U.esc(t("clubs.members", { n: (members || []).length }))}</span></div>
          </div>
          <div class="row">
            ${me && !myMember ? `<button class="btn primary" id="join">${U.esc(t("clubs.join"))}</button>` : ""}
            ${myMember && !isOwner ? `<button class="btn ghost" id="leave">${U.esc(t("clubs.leave"))}</button>` : ""}
            ${isOwner ? `<button class="btn danger" id="del">${U.esc(t("clubs.del"))}</button>` : ""}
            ${creator && !isOwner ? `<button class="btn danger" id="del-mod" title="${U.esc(t("clubs.delTitle"))}">${U.esc(t("clubs.delMod"))}</button>` : ""}
          </div>
        </div>
      </div>
      <div class="club-layout">
        <div>
          <div class="card"><h3 class="spread row">${U.esc(t("clubs.about"))}
            ${isOwner ? `<button class="btn ghost small" id="edit-desc" title="${U.esc(t("clubs.descPublicTitle"))}">${U.esc(t("clubs.editDesc"))}</button>` : ""}</h3>
            <p class="content-text">${c.description ? U.esc(c.description)
              : `<span class="muted">${U.esc(t("clubs.noDesc"))}</span>`}</p>
          </div>
          <div class="card">
            <h3>${U.esc(t("clubs.chat"))}</h3>
            ${canChat ? `
              <div class="chat-box">
                <div class="chat-log" id="club-chat-log"></div>
                <div class="chat-input">
                  <input id="club-chat-text" maxlength="500" placeholder="${U.esc(t("chat.placeholder"))}">
                  <button class="btn primary" id="club-chat-send">→</button>
                </div>
              </div>`
            : `<div class="empty">${me ? U.esc(t("clubs.chatMembers")) : U.esc(t("clubs.chatGuest"))}</div>`}
          </div>
        </div>
        <div class="card">
          <h3>${U.esc(t("clubs.membersCount", { n: (members || []).length }))}</h3>
          ${(members || []).map(m => `
            <div class="list-item">
              <span class="avatar">${U.esc((m.p && m.p.username || "?")[0].toUpperCase())}</span>
              <div style="flex:1;min-width:0">
                <a href="#/profile/${m.user_id}"><b>${U.esc(m.p ? m.p.username : "?")}</b></a>
                <div class="muted small">${m.p ? m.p.rating : ""}${m.role === "owner" ? U.esc(t("clubs.ownerTag")) : ""}</div>
              </div>
              ${isOwner && m.role !== "owner" ? `<button class="btn ghost small" data-kick="${m.user_id}">×</button>` : ""}
            </div>`).join("") || `<div class="empty">${U.esc(t("clubs.nobody"))}</div>`}
        </div>
      </div>`;

    const join = U.qs("#join");
    if (join) join.addEventListener("click", async () => {
      const { error } = await API.sb.from("club_members").insert({ club_id: clubId, user_id: me.id });
      if (error) U.toast(error.message, "error"); else App.route();
    });
    const leave = U.qs("#leave");
    if (leave) leave.addEventListener("click", async () => {
      const { error } = await API.sb.from("club_members").delete()
        .eq("club_id", clubId).eq("user_id", me.id);
      if (error) U.toast(error.message, "error"); else App.route();
    });
    const del = U.qs("#del");
    if (del) del.addEventListener("click", async () => {
      if (!(await U.confirmModal(t("clubs.delQ"), t("common.irreversible"), t("common.delete")))) return;
      const { error } = await API.sb.from("clubs").delete().eq("id", clubId);
      if (error) U.toast(error.message, "error"); else location.hash = "#/clubs";
    });
    const delMod = U.qs("#del-mod");
    if (delMod) delMod.addEventListener("click", async () => {
      if (!(await U.confirmDanger(t("clubs.delQ"), t("common.irreversible"), t("common.delete")))) return;
      const { error } = await API.adminDeleteClub(clubId);
      if (error) U.toast(error.message, "error"); else location.hash = "#/clubs";
    });
    const editDesc = U.qs("#edit-desc");
    if (editDesc) editDesc.addEventListener("click", async () => {
      const res = await U.formModal(t("clubs.descTitle"), [
        { id: "desc", label: t("clubs.descLabel"), type: "textarea", rows: 5,
          maxlength: 1000, value: c.description || "", placeholder: t("clubs.descPh2") }
      ], t("common.save"));
      if (!res) return;
      const { error } = await API.sb.from("clubs")
        .update({ description: res.desc.trim() }).eq("id", clubId);
      if (error) return U.toast(error.message, "error");
      U.toast(t("clubs.descUpdated"), "good");
      App.route();
    });
    U.qsa("[data-kick]").forEach(b => b.addEventListener("click", async () => {
      const { error } = await API.sb.from("club_members").delete()
        .eq("club_id", clubId).eq("user_id", b.dataset.kick);
      if (error) U.toast(error.message, "error"); else App.route();
    }));

    // club chat
    const chans = [];
    const stops = [];
    if (canChat) {
      const log = U.qs("#club-chat-log");
      const names = {};
      const roles = {};
      const seen = new Set();
      let pending = [];            // own optimistic messages: [{body, el}]
      (members || []).forEach(m => { if (m.p) { names[m.user_id] = m.p.username; roles[m.user_id] = m.p.role || "user"; } });
      const renderMsg = (m) => {
        const name = (m.p && m.p.username) || names[m.user_id] || "?";
        const who = m.user_id
          ? `<a class="user-link" href="#/profile/${m.user_id}">${U.esc(name)}:</a> ${U.roleBadge(m.p && m.p.role || roles[m.user_id])}`
          : `<b>${U.esc(name)}:</b>`;
        const d = U.el(`<div class="chat-msg ${m.user_id === me.id ? "mine" : ""}">${who} ${U.linkify(m.body)}${clubModActionsHtml(m)}</div>`);
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
      };
      const addMsg = (m) => {
        if (seen.has(m.id)) return; // realtime and polling may duplicate
        // own message already shown optimistically: the match confirms it,
        // the optimistic copy is replaced by the full node (with actions)
        if (m.user_id === me.id) {
          const i = pending.findIndex(p => p.body === m.body);
          if (i >= 0) {
            seen.add(m.id);
            pending.splice(i, 1)[0].el.remove();
          }
        }
        seen.add(m.id);
        renderMsg(m);
      };
      msgs.forEach(addMsg);
      // club chat moderation: delete a message or mute the author (delegated)
      log.addEventListener("click", async (e) => {
        const del = e.target.closest("[data-adel]");
        const mute = e.target.closest("[data-amute]");
        if (del) {
          if (!(await U.confirmModal(t("mod.delMsgQ"), "", t("common.delete")))) return;
          const { error } = await API.adminDeleteMessage("club", del.dataset.adel);
          if (error) return U.toast(error.message, "error");
          const node = del.closest(".chat-msg");
          if (node) node.remove();
          U.toast(t("mod.msgDeleted"), "good");
        } else if (mute) {
          const target = mute.dataset.amute;
          const nm = names[target] || t("mod.playerFallback");
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
      });
      const send = async () => {
        const inp = U.qs("#club-chat-text");
        const body = inp.value.trim();
        if (!body) return;
        inp.value = "";
        log.querySelector(".empty") && log.querySelector(".empty").remove();
        // optimistic: show instantly, RPC in the background
        const nm = (App.profile && App.profile.username) || names[me.id] || t("chat.you");
        const tmp = U.el(`<div class="chat-msg mine"><a class="user-link" href="#/profile/${me.id}">${U.esc(nm)}:</a> ${U.linkify(body)}</div>`);
        log.appendChild(tmp);
        log.scrollTop = log.scrollHeight;
        const pend = { body, el: tmp };
        pending.push(pend);
        const { data: res, error } = await API.sendClubChat(clubId, body);
        if (error) {
          tmp.remove();
          const i = pending.indexOf(pend);
          if (i >= 0) pending.splice(i, 1);
          U.toast(error.message, "error");
          inp.value = body;
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
      U.qs("#club-chat-send").addEventListener("click", send);
      U.qs("#club-chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

      // fresh fetch shared by fallback polling, reconnects, and tab returns
      async function fetchFresh() {
        const { data: fresh } = await API.sb.from("club_chat")
          .select("*, p:profiles(username)").eq("club_id", clubId)
          .order("created_at", { ascending: false }).limit(30);
        if (!fresh) return;
        for (const m of fresh.reverse()) {
          if (seen.has(m.id)) continue;
          if (m.p) names[m.user_id] = m.p.username;
          addMsg(m);
        }
      }

      let chatChan = null, _wasDown = false;
      chatChan = API.subscribeClubChat(clubId, async (row) => {
        if (!names[row.user_id]) {
          const { data: pr } = await API.sb.from("profiles")
            .select("username,role").eq("id", row.user_id).maybeSingle();
          if (pr) { names[row.user_id] = pr.username; roles[row.user_id] = pr.role || "user"; }
        }
        addMsg(row);
        U.soundMove();
      }, (status) => {
        if (status === "SUBSCRIBED" && _wasDown) fetchFresh();
        _wasDown = status !== "SUBSCRIBED";
      });
      chans.push(chatChan);
      // fallback polling only while the websocket is down; sleeps in hidden tabs
      stops.push(API.poll(4000, fetchFresh, () => API.chUp(chatChan)));
      stops.push(API.onVisible(fetchFresh));
    }
    return function cleanup() { stops.forEach(s => s()); chans.forEach(API.unsubscribe); };
  };

  // Blog
  const BlogPage_render = async function (container) {
    const me = await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>${U.esc(t("blog.title"))}</h1>
        ${me ? `<a class="btn primary" href="#/blog/new">${U.esc(t("blog.new"))}</a>` : ""}</div>
      <div class="card" id="posts"><span class="spinner"></span></div>`;
    const { data } = await API.sb.from("blog_posts")
      .select("*, a:profiles!blog_posts_author_id_fkey(id,username,role)")
      .order("created_at", { ascending: false }).limit(50);
    U.qs("#posts").innerHTML = (data || []).map(p => `
      <div class="list-item">
        <div style="flex:1">
          <a href="#/blog/${p.id}" style="font-weight:700;font-size:17px">${U.esc(p.title)}</a>
          <div class="muted small"><a href="#/profile/${p.a ? p.a.id : ""}">${U.esc(p.a ? p.a.username : "?")}</a> ${U.roleBadge(p.a && p.a.role)} · ${U.fmtDate(p.created_at)}</div>
          <div class="muted small" style="margin-top:4px">${U.esc(p.body.slice(0, 140))}${p.body.length > 140 ? "…" : ""}</div>
        </div>
      </div>`).join("") || `<div class="empty">${U.esc(t("blog.empty"))}</div>`;
    return () => {};
  };

  const BlogNewPage_render = async function (container) {
    const me = await API.user();
    if (!me) { container.innerHTML = `<div class="card">${notAuthBox(t("blog.authHint"))}</div>`; return () => {}; }
    container.innerHTML = `
      <div class="card" style="max-width:760px;margin:0 auto">
        <h2>${U.esc(t("blog.newTitle"))}</h2>
        <label>${U.esc(t("blog.titleLabel"))}</label><input id="b-title" maxlength="120">
        <label>${U.esc(t("blog.bodyLabel"))}</label><textarea id="b-body" rows="12" maxlength="20000"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="b-go">${U.esc(t("blog.publish"))}</button>
          <a class="btn ghost" href="#/blog">${U.esc(t("common.cancel"))}</a>
        </div>
      </div>`;
    U.qs("#b-go").addEventListener("click", async () => {
      const title = U.qs("#b-title").value.trim();
      const body = U.qs("#b-body").value.trim();
      if (title.length < 3 || !body) return U.toast(t("blog.required"), "error");
      const { data, error } = await API.sb.from("blog_posts")
        .insert({ author_id: me.id, title, body }).select("id").single();
      if (error) return U.toast(error.message, "error");
      location.hash = `#/blog/${data.id}`;
    });
    return () => {};
  };

  const BlogPostPage_render = async function (container, postId) {
    const me = await API.user();
    const my = await modProfile();
    const creator = isCreator(my);
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: p } = await API.sb.from("blog_posts")
      .select("*, a:profiles!blog_posts_author_id_fkey(id,username,role)").eq("id", postId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">${U.esc(t("blog.notFound"))}</div>`; return () => {}; }
    const own = me && me.id === p.author_id;
    container.innerHTML = `
      <p><a href="#/blog">${U.esc(t("blog.back"))}</a></p>
      <div class="card">
        <h1>${U.esc(p.title)}</h1>
        <div class="row"><a href="#/profile/${p.author_id}"><b>${U.esc(p.a ? p.a.username : "?")}</b></a>
          ${U.roleBadge(p.a && p.a.role)}
          <span class="muted small">${U.fmtDate(p.created_at)}</span>
          ${own ? `<button class="btn ghost small" id="b-edit">${U.esc(t("blog.edit"))}</button>
                   <button class="btn ghost small" id="b-del">${U.esc(t("common.delete"))}</button>` : ""}
          ${creator && !own ? `<button class="btn danger small" id="b-del-mod" title="${U.esc(t("blog.delMod"))}">${U.esc(t("blog.delMod"))}</button>` : ""}
        </div>
        <div class="content-text" id="b-content" style="margin-top:14px">${U.esc(p.body)}</div>
      </div>`;
    if (own) {
      U.qs("#b-edit").addEventListener("click", async () => {
        const res = await U.formModal(t("blog.editTitle"), [
          { id: "title", label: t("blog.titleLabel"), value: p.title, maxlength: 120 },
          { id: "body", label: t("blog.bodyLabel"), type: "textarea", rows: 12,
            value: p.body, maxlength: 20000 }
        ], t("common.save"));
        if (!res) return;
        const title = res.title.trim();
        const body = res.body.trim();
        if (title.length < 3 || !body) return U.toast(t("blog.required"), "error");
        const { error } = await API.sb.from("blog_posts")
          .update({ title, body, updated_at: new Date().toISOString() })
          .eq("id", postId);
        if (error) U.toast(error.message, "error");
        else { U.toast(t("common.saved"), "good"); App.route(); }
      });
      U.qs("#b-del").addEventListener("click", async () => {
        if (!(await U.confirmModal(t("blog.delQ"), "", t("common.delete")))) return;
        const { error } = await API.sb.from("blog_posts").delete().eq("id", postId);
        if (error) U.toast(error.message, "error"); else location.hash = "#/blog";
      });
    }
    const delMod = U.qs("#b-del-mod");
    if (delMod) delMod.addEventListener("click", async () => {
      if (!(await U.confirmDanger(t("blog.delQ"), "", t("common.delete")))) return;
      const { error } = await API.adminDeleteBlogPost(postId);
      if (error) U.toast(error.message, "error"); else location.hash = "#/blog";
    });
    return () => {};
  };

  window.Community = {
    forum: ForumPage_render, thread: ThreadPage_render,
    clubs: ClubsPage_render, club: ClubPage_render,
    blog: BlogPage_render, blogNew: BlogNewPage_render, blogPost: BlogPostPage_render
  };
})();
