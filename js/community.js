// ============================================================
//  Сообщество: форум, клубы, блог
// ============================================================
(function () {
  "use strict";

  const notAuthBox = (text) => `
    <div class="empty">${text || "Только для авторизованных"} ·
      <a href="#/login">войти</a> / <a href="#/signup">регистрация</a></div>`;

  // ================= ФОРУМ =================
  const ForumPage_render = async function (container) {
    const me = await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>Форум</h1>
        ${me ? `<button class="btn primary" id="f-new">+ Новая тема</button>` : notAuthBox("")}</div>
      <div class="card" id="threads"><span class="spinner"></span></div>`;
    if (me) {
      U.qs("#f-new").addEventListener("click", async () => {
        const res = await U.formModal("Новая тема", [
          { id: "title", label: "Заголовок (3–120 символов)", maxlength: 120,
            placeholder: "О чём тема?" },
          { id: "body", label: "Первое сообщение", type: "textarea", rows: 7,
            maxlength: 10000, placeholder: "Текст сообщения…" }
        ], "Создать тему");
        if (!res) return;
        const title = res.title.trim();
        const body = res.body.trim();
        if (title.length < 3) return U.toast("Заголовок — минимум 3 символа", "error");
        if (!body) return U.toast("Введите текст первого сообщения", "error");
        const { error } = await API.sb.from("forum_threads").insert({
          author_id: me.id, title, body
        });
        if (error) U.toast(error.message, "error");
        else { U.toast("Тема создана", "good"); App.route(); }
      });
    }
    const { data } = await API.sb.from("forum_threads")
      .select("*, a:profiles!forum_threads_author_id_fkey(id,username)")
      .order("created_at", { ascending: false }).limit(50);
    const { count } = await API.sb.from("forum_replies").select("id", { count: "exact", head: true });
    const box = U.qs("#threads");
    const replies = await API.sb.from("forum_replies").select("thread_id").limit(500);
    const cnt = {};
    (replies.data || []).forEach(r => cnt[r.thread_id] = (cnt[r.thread_id] || 0) + 1);
    box.innerHTML = (data || []).length ? (data || []).map(t => `
      <div class="list-item">
        <div style="flex:1">
          <a href="#/forum/${t.id}" style="font-weight:700;font-size:16px">${U.esc(t.title)}</a>
          <div class="muted small">${U.esc(t.a ? t.a.username : "?")} · ${U.fmtDate(t.created_at)}</div>
        </div>
        <span class="badge">${cnt[t.id] || 0} ответов</span>
      </div>`).join("") : `<div class="empty">Тем пока нет. Будьте первым!</div>`;
    return () => {};
  };

  const ThreadPage_render = async function (container, threadId) {
    const me = await API.user();
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: t } = await API.sb.from("forum_threads")
      .select("*, a:profiles!forum_threads_author_id_fkey(id,username)").eq("id", threadId).maybeSingle();
    if (!t) { container.innerHTML = `<div class="card center">Тема не найдена</div>`; return () => {}; }
    const { data: reps } = await API.sb.from("forum_replies")
      .select("*, a:profiles!forum_replies_author_id_fkey(id,username)")
      .eq("thread_id", threadId).order("created_at");

    container.innerHTML = `
      <p><a href="#/forum">← Форум</a></p>
      <div class="card">
        <h1>${U.esc(t.title)}</h1>
        <div class="row"><span class="avatar">${U.esc((t.a && t.a.username || "?")[0].toUpperCase())}</span>
          <a href="#/profile/${t.a ? t.a.id : ""}"><b>${U.esc(t.a ? t.a.username : "?")}</b></a>
          <span class="muted small">${U.fmtDate(t.created_at)}</span>
          ${me && t.author_id === me.id ? `<button class="btn ghost small" id="t-del">Удалить</button>` : ""}
        </div>
        <div class="content-text" style="margin-top:12px">${U.esc(t.body)}</div>
      </div>
      <div class="card"><h3>Ответы (${(reps || []).length})</h3><div id="replies">
        ${(reps || []).map(r => `
          <div class="list-item">
            <span class="avatar">${U.esc((r.a && r.a.username || "?")[0].toUpperCase())}</span>
            <div style="flex:1"><a href="#/profile/${r.a ? r.a.id : ""}"><b>${U.esc(r.a ? r.a.username : "?")}</b></a>
              <span class="muted small">${U.fmtDate(r.created_at)}</span>
              <div class="content-text">${U.esc(r.body)}</div></div>
            ${me && r.author_id === me.id ? `<button class="btn ghost small" data-del="${r.id}">×</button>` : ""}
          </div>`).join("") || `<div class="empty">Ответов пока нет</div>`}
      </div></div>
      <div class="card">${me ? `
        <h3>Ваш ответ</h3>
        <textarea id="r-body" rows="4" maxlength="5000"></textarea>
        <button class="btn primary" id="r-send" style="margin-top:10px">Отправить</button>`
        : notAuthBox("Чтобы отвечать")}</div>`;

    U.qsa("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!(await U.confirmModal("Удалить ответ?", "", "Удалить"))) return;
      const { error } = await API.sb.from("forum_replies").delete().eq("id", b.dataset.del);
      if (error) U.toast(error.message, "error"); else App.route();
    }));
    const tDel = U.qs("#t-del");
    if (tDel) tDel.addEventListener("click", async () => {
      if (!(await U.confirmModal("Удалить тему со всеми ответами?", "", "Удалить"))) return;
      const { error } = await API.sb.from("forum_threads").delete().eq("id", threadId);
      if (error) U.toast(error.message, "error"); else location.hash = "#/forum";
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

  // ================= КЛУБЫ =================
  const ClubsPage_render = async function (container) {
    const me = await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>Клубы</h1></div>
      ${me ? `<div class="card">
        <h3>Создать клуб</h3>
        <div class="row">
          <input id="c-name" placeholder="Название (3-40)" maxlength="40" style="flex:1">
          <button class="btn primary" id="c-go">Создать</button>
        </div>
        <textarea id="c-desc" rows="2" maxlength="1000" placeholder="Описание (необязательно)" style="margin-top:8px"></textarea>
      </div>` : notAuthBox("Чтобы создавать клубы")}
      <div class="card" id="clubs"><span class="spinner"></span></div>`;
    if (me) U.qs("#c-go").addEventListener("click", async () => {
      const name = U.qs("#c-name").value.trim();
      const description = U.qs("#c-desc").value.trim();
      if (name.length < 3) return U.toast("Название минимум 3 символа", "error");
      const { error } = await API.sb.from("clubs").insert({ name, description, owner_id: me.id });
      if (error) U.toast(error.message, "error");
      else { U.toast("Клуб создан", "good"); App.route(); }
    });
    const { data } = await API.sb.from("clubs")
      .select("*, o:profiles!clubs_owner_id_fkey(id,username), m:club_members(count)")
      .order("created_at", { ascending: false }).limit(50);
    U.qs("#clubs").innerHTML = (data || []).map(c => `
      <div class="list-item">
        <span class="avatar">${U.esc(c.name[0].toUpperCase())}</span>
        <div style="flex:1">
          <a href="#/clubs/${c.id}" style="font-weight:700;font-size:16px">${U.esc(c.name)}</a>
          <div class="muted small">Владелец: ${U.esc(c.o ? c.o.username : "?")} · участников: ${c.m && c.m[0] ? c.m[0].count : 1}</div>
        </div>
      </div>`).join("") || `<div class="empty">Клубов пока нет</div>`;
    return () => {};
  };

  const ClubPage_render = async function (container, clubId) {
    const me = await API.user();
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: c } = await API.sb.from("clubs")
      .select("*, o:profiles!clubs_owner_id_fkey(id,username)").eq("id", clubId).maybeSingle();
    if (!c) { container.innerHTML = `<div class="card center">Клуб не найден</div>`; return () => {}; }
    const { data: members } = await API.sb.from("club_members")
      .select("*, p:profiles!club_members_user_id_fkey(id,username,rating)")
      .eq("club_id", clubId).order("joined_at");
    const myMember = me && (members || []).find(m => m.user_id === me.id);
    const isOwner = me && c.owner_id === me.id;
    const canChat = !!(me && myMember);

    // история чата клуба (RLS: только участники)
    let msgs = [];
    if (canChat) {
      const { data } = await API.sb.from("club_chat")
        .select("*, p:profiles(username)").eq("club_id", clubId).order("created_at");
      msgs = data || [];
    }

    container.innerHTML = `
      <p><a href="#/clubs">← Клубы</a></p>
      <div class="card">
        <div class="row spread">
          <div class="row">
            <span class="avatar big">${U.esc(c.name[0].toUpperCase())}</span>
            <div><h1 style="margin:0">${U.esc(c.name)}</h1>
            <span class="muted small">Владелец: <a href="#/profile/${c.owner_id}">${U.esc(c.o ? c.o.username : "?")}</a>
              · участников: ${(members || []).length}</span></div>
          </div>
          <div class="row">
            ${me && !myMember ? `<button class="btn primary" id="join">Вступить</button>` : ""}
            ${myMember && !isOwner ? `<button class="btn ghost" id="leave">Покинуть</button>` : ""}
            ${isOwner ? `<button class="btn danger" id="del">Удалить клуб</button>` : ""}
          </div>
        </div>
      </div>
      <div class="club-layout">
        <div>
          <div class="card"><h3>О клубе</h3>
            <p class="content-text">${c.description ? U.esc(c.description)
              : '<span class="muted">Описание пока не добавлено.</span>'}</p>
          </div>
          <div class="card">
            <h3>Чат клуба</h3>
            ${canChat ? `
              <div class="chat-box">
                <div class="chat-log" id="club-chat-log"></div>
                <div class="chat-input">
                  <input id="club-chat-text" maxlength="500" placeholder="Сообщение…">
                  <button class="btn primary" id="club-chat-send">→</button>
                </div>
              </div>`
            : `<div class="empty">${me
                ? "Чат доступен только участникам клуба — вступите!"
                : "Чат клуба: войдите и вступите."}</div>`}
          </div>
        </div>
        <div class="card">
          <h3>Участники (${(members || []).length})</h3>
          ${(members || []).map(m => `
            <div class="list-item">
              <span class="avatar">${U.esc((m.p && m.p.username || "?")[0].toUpperCase())}</span>
              <div style="flex:1;min-width:0">
                <a href="#/profile/${m.user_id}"><b>${U.esc(m.p ? m.p.username : "?")}</b></a>
                <div class="muted small">${m.p ? m.p.rating : ""}${m.role === "owner" ? " · владелец" : ""}</div>
              </div>
              ${isOwner && m.role !== "owner" ? `<button class="btn ghost small" data-kick="${m.user_id}">×</button>` : ""}
            </div>`).join("") || `<div class="empty">Пока никого</div>`}
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
      if (!(await U.confirmModal("Удалить клуб?", "Это действие необратимо.", "Удалить"))) return;
      const { error } = await API.sb.from("clubs").delete().eq("id", clubId);
      if (error) U.toast(error.message, "error"); else location.hash = "#/clubs";
    });
    U.qsa("[data-kick]").forEach(b => b.addEventListener("click", async () => {
      const { error } = await API.sb.from("club_members").delete()
        .eq("club_id", clubId).eq("user_id", b.dataset.kick);
      if (error) U.toast(error.message, "error"); else App.route();
    }));

    // ---------- чат клуба ----------
    const chans = [];
    const stops = [];
    if (canChat) {
      const log = U.qs("#club-chat-log");
      const names = {};
      const seen = new Set();
      (members || []).forEach(m => { if (m.p) names[m.user_id] = m.p.username; });
      const addMsg = (m) => {
        if (seen.has(m.id)) return; // realtime + poll могут дублировать
        seen.add(m.id);
        const name = (m.p && m.p.username) || names[m.user_id] || "?";
        const d = U.el(`<div class="chat-msg"><b>${U.esc(name)}:</b> ${U.esc(m.body)}</div>`);
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
      };
      msgs.forEach(addMsg);
      const send = async () => {
        const inp = U.qs("#club-chat-text");
        const body = inp.value.trim();
        if (!body) return;
        inp.value = "";
        const { error } = await API.sendClubChat(clubId, body);
        if (error) { U.toast(error.message, "error"); inp.value = body; }
      };
      U.qs("#club-chat-send").addEventListener("click", send);
      U.qs("#club-chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
      chans.push(API.subscribeClubChat(clubId, async (row) => {
        if (!names[row.user_id]) {
          const { data: pr } = await API.sb.from("profiles")
            .select("username").eq("id", row.user_id).maybeSingle();
          if (pr) names[row.user_id] = pr.username;
        }
        addMsg(row);
        U.soundMove();
      }));
      // fallback-поллинг (если websocket недоступен)
      stops.push(API.poll(4000, async () => {
        const { data: fresh } = await API.sb.from("club_chat")
          .select("*, p:profiles(username)").eq("club_id", clubId)
          .order("created_at", { ascending: false }).limit(30);
        if (!fresh) return;
        for (const m of fresh.reverse()) {
          if (seen.has(m.id)) continue;
          if (m.p) names[m.user_id] = m.p.username;
          addMsg(m);
        }
      }));
    }
    return function cleanup() { stops.forEach(s => s()); chans.forEach(API.unsubscribe); };
  };

  // ================= БЛОГ =================
  const BlogPage_render = async function (container) {
    const me = await API.user();
    container.innerHTML = `
      <div class="row spread"><h1>Блог</h1>
        ${me ? `<a class="btn primary" href="#/blog/new">+ Написать пост</a>` : ""}</div>
      <div class="card" id="posts"><span class="spinner"></span></div>`;
    const { data } = await API.sb.from("blog_posts")
      .select("*, a:profiles!blog_posts_author_id_fkey(id,username)")
      .order("created_at", { ascending: false }).limit(50);
    U.qs("#posts").innerHTML = (data || []).map(p => `
      <div class="list-item">
        <div style="flex:1">
          <a href="#/blog/${p.id}" style="font-weight:700;font-size:17px">${U.esc(p.title)}</a>
          <div class="muted small">${U.esc(p.a ? p.a.username : "?")} · ${U.fmtDate(p.created_at)}</div>
          <div class="muted small" style="margin-top:4px">${U.esc(p.body.slice(0, 140))}${p.body.length > 140 ? "…" : ""}</div>
        </div>
      </div>`).join("") || `<div class="empty">Постов пока нет</div>`;
    return () => {};
  };

  const BlogNewPage_render = async function (container) {
    const me = await API.user();
    if (!me) { container.innerHTML = `<div class="card">${notAuthBox("Чтобы писать в блог")}</div>`; return () => {}; }
    container.innerHTML = `
      <div class="card" style="max-width:760px;margin:0 auto">
        <h2>Новый пост</h2>
        <label>Заголовок</label><input id="b-title" maxlength="120">
        <label>Текст</label><textarea id="b-body" rows="12" maxlength="20000"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="b-go">Опубликовать</button>
          <a class="btn ghost" href="#/blog">Отмена</a>
        </div>
      </div>`;
    U.qs("#b-go").addEventListener("click", async () => {
      const title = U.qs("#b-title").value.trim();
      const body = U.qs("#b-body").value.trim();
      if (title.length < 3 || !body) return U.toast("Заголовок (3+) и текст обязательны", "error");
      const { data, error } = await API.sb.from("blog_posts")
        .insert({ author_id: me.id, title, body }).select("id").single();
      if (error) return U.toast(error.message, "error");
      location.hash = `#/blog/${data.id}`;
    });
    return () => {};
  };

  const BlogPostPage_render = async function (container, postId) {
    const me = await API.user();
    container.innerHTML = `<div class="card center"><span class="spinner"></span></div>`;
    const { data: p } = await API.sb.from("blog_posts")
      .select("*, a:profiles!blog_posts_author_id_fkey(id,username)").eq("id", postId).maybeSingle();
    if (!p) { container.innerHTML = `<div class="card center">Пост не найден</div>`; return () => {}; }
    const own = me && me.id === p.author_id;
    container.innerHTML = `
      <p><a href="#/blog">← Блог</a></p>
      <div class="card">
        <h1>${U.esc(p.title)}</h1>
        <div class="row"><a href="#/profile/${p.author_id}"><b>${U.esc(p.a ? p.a.username : "?")}</b></a>
          <span class="muted small">${U.fmtDate(p.created_at)}</span>
          ${own ? `<button class="btn ghost small" id="b-edit">Редактировать</button>
                   <button class="btn ghost small" id="b-del">Удалить</button>` : ""}
        </div>
        <div class="content-text" id="b-content" style="margin-top:14px">${U.esc(p.body)}</div>
      </div>`;
    if (own) {
      U.qs("#b-edit").addEventListener("click", async () => {
        const res = await U.formModal("Редактировать пост", [
          { id: "title", label: "Заголовок", value: p.title, maxlength: 120 },
          { id: "body", label: "Текст", type: "textarea", rows: 12,
            value: p.body, maxlength: 20000 }
        ], "Сохранить");
        if (!res) return;
        const title = res.title.trim();
        const body = res.body.trim();
        if (title.length < 3 || !body) return U.toast("Заголовок (3+) и текст обязательны", "error");
        const { error } = await API.sb.from("blog_posts")
          .update({ title, body, updated_at: new Date().toISOString() })
          .eq("id", postId);
        if (error) U.toast(error.message, "error");
        else { U.toast("Сохранено", "good"); App.route(); }
      });
      U.qs("#b-del").addEventListener("click", async () => {
        if (!(await U.confirmModal("Удалить пост?", "", "Удалить"))) return;
        const { error } = await API.sb.from("blog_posts").delete().eq("id", postId);
        if (error) U.toast(error.message, "error"); else location.hash = "#/blog";
      });
    }
    return () => {};
  };

  window.Community = {
    forum: ForumPage_render, thread: ThreadPage_render,
    clubs: ClubsPage_render, club: ClubPage_render,
    blog: BlogPage_render, blogNew: BlogNewPage_render, blogPost: BlogPostPage_render
  };
})();
