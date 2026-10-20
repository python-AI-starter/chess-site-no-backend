// ---------- API: клиент Supabase + обёртки ----------
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // АВТОВХОД: ссылка из письма подтверждения приходит с токеном в URL —
      // клиент сам подхватывает сессию (implicit flow), логиниться не нужно
      detectSessionInUrl: true
    }
  });

  const API = { sb };

  // --- сессия ---
  API.user = async function () {
    const { data } = await sb.auth.getUser();
    return data && data.user ? data.user : null;
  };
  API.profile = async function (userId) {
    let id = userId;
    if (!id) { const u = await API.user(); if (!u) return null; id = u.id; }
    const { data, error } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
    if (error) { console.warn(error); return null; }
    return data;
  };
  API.onAuth = (cb) => sb.auth.onAuthStateChange((_e, s) => cb(_e, s));

  API.signUp = (email, password, username) =>
    sb.auth.signUp({ email, password, options: {
      data: { username },
      // вернуться на ту же страницу, где открыли сайт (если разрешено
      // в настройках auth; иначе Supabase пошлёт на Site URL проекта)
      emailRedirectTo: window.location.origin + window.location.pathname
    } });
  API.signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
  API.signOut = () => sb.auth.signOut();
  API.resetPassword = (email) => sb.auth.resetPasswordForEmail(email);

  // --- RPC ---
  // Возвращает {data, error} где error.message содержит текст из БД
  API.rpc = async function (fn, params) {
    const { data, error } = await sb.rpc(fn, params || {});
    if (error) {
      let msg = error.message || "Ошибка";
      try {
        const j = JSON.parse(msg);
        if (j && j.message) msg = j.message;
      } catch (e) { /* не JSON */ }
      return { data, error: { message: msg, code: error.code } };
    }
    return { data, error: null };
  };

  API.makeMove = (gameId, uci) => API.rpc("make_move", { p_game_id: gameId, p_uci: uci });
  API.gameState = (gameId) => API.rpc("get_game_state", { p_game_id: gameId });
  API.quickPair = (ms, inc) => API.rpc("quick_pair", { p_initial_ms: ms, p_increment_ms: inc });
  API.cancelSeek = () => API.rpc("cancel_seek");
  API.createChallenge = (ms, inc, rated, color, invitee) => {
    const params = { p_initial_ms: ms, p_increment_ms: inc, p_rated: rated,
                     p_color: color || "random" };
    if (invitee) params.p_invitee = invitee;
    return API.rpc("create_challenge", params);
  };
  API.cancelWaiting = (id) => API.rpc("cancel_waiting_game", { p_game_id: id });
  API.joinGame = (id) => API.rpc("join_game", { p_game_id: id });
  API.resign = (id) => API.rpc("resign", { p_game_id: id });
  API.claimFlag = (id) => API.rpc("claim_flag", { p_game_id: id });
  API.claimAbandon = (id) => API.rpc("claim_abandon", { p_game_id: id });
  API.offerDraw = (id) => API.rpc("offer_draw", { p_game_id: id });
  API.acceptDraw = (id) => API.rpc("accept_draw", { p_game_id: id });
  API.declineDraw = (id) => API.rpc("decline_draw", { p_game_id: id });
  API.requestTakeback = (id) => API.rpc("request_takeback", { p_game_id: id });
  API.acceptTakeback = (id) => API.rpc("accept_takeback", { p_game_id: id });
  API.declineTakeback = (id) => API.rpc("decline_takeback", { p_game_id: id });
  API.sendChat = (id, body) => API.rpc("send_chat", { p_game_id: id, p_body: body });
  API.sendClubChat = (id, body) => API.rpc("send_club_chat", { p_club_id: id, p_body: body });
  API.setUsername = (u) => API.rpc("set_username", { p_username: u });
  // --- соцсеть: общий чат, ЛС, онлайн-пульс, реплей, адресный вызов ---
  API.sendGlobalChat = (body) => API.rpc("send_global_chat", { p_body: body });
  API.sendDm = (rcpt, body) => API.rpc("send_dm", { p_recipient: rcpt, p_body: body });
  API.markDmsRead = (partner) => API.rpc("mark_dms_read", { p_partner: partner });
  API.heartbeat = () => API.rpc("heartbeat");
  API.getReplay = (id) => API.rpc("get_replay", { p_game_id: id });

  // --- Realtime ---
  API.subscribeGame = function (gameId, onUpdate) {
    const ch = sb.channel(`game:${gameId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
        (payload) => onUpdate(payload.new))
      .subscribe();
    return ch;
  };
  API.subscribeChat = function (gameId, onInsert) {
    const ch = sb.channel(`chat:${gameId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "game_chat", filter: `game_id=eq.${gameId}` },
        (payload) => onInsert(payload.new))
      .subscribe();
    return ch;
  };
  API.subscribeClubChat = function (clubId, onInsert) {
    const ch = sb.channel(`club:${clubId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "club_chat", filter: `club_id=eq.${clubId}` },
        (payload) => onInsert(payload.new))
      .subscribe();
    return ch;
  };
  API.unsubscribe = (ch) => { if (ch) sb.removeChannel(ch); };

  // универсальная подписка на INSERT в таблицу (RLS сам режет чужие строки)
  API.subscribeInserts = function (table, filter, onInsert) {
    const ch = sb.channel(`tbl:${table}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table, ...(filter ? { filter } : {}) },
        (payload) => onInsert(payload.new))
      .subscribe();
    return ch;
  };

  // ---------- FALLBACK-ПОЛЛИНГ ----------
  // Realtime может быть недоступен (сеть, прокси, старый браузер) —
  // поэтому всё критичное дублируется опросом. Возвращает stop().
  // fn вызывается сразу? нет: страница сама делает первый fetch.
  API.poll = function (ms, fn) {
    const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms);
    return () => clearInterval(t);
  };

  // защита от «двойного» применения состояния (realtime + poll гонят одно и то же)
  API.stateKey = function (g) {
    if (!g) return "";
    return [(g.moves || []).length, g.status, g.fen,
            g.draw_offer_by || "", g.takeback_by || "",
            g.white_ms, g.black_ms].join("|");
  };

  window.API = API;
})();
