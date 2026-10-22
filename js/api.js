// Supabase client and RPC wrappers.
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // confirmation email links carry the token in the URL; the client
      // picks up the session automatically (implicit flow)
      detectSessionInUrl: true
    }
  });

  const API = { sb };

  // session helpers
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
      // return to the page the site was opened from when auth settings
      // allow it; otherwise Supabase redirects to the project Site URL
      emailRedirectTo: window.location.origin + window.location.pathname
    } });
  API.signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
  API.signOut = () => sb.auth.signOut();
  API.resetPassword = (email) => sb.auth.resetPasswordForEmail(email);

  // RPC helpers: returns {data, error} where error.message carries
  // the human-readable database text
  API.rpc = async function (fn, params) {
    const { data, error } = await sb.rpc(fn, params || {});
    if (error) {
      let msg = error.message || "Ошибка";
      try {
        const j = JSON.parse(msg);
        if (j && j.message) msg = j.message;
      } catch (e) { /* not JSON */ }
      // map network failures to a friendly message
      if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg))
        msg = "Нет связи с сервером";
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
  // player blocks
  API.blockUser = (id) => API.rpc("block_user", { p_target: id });
  API.unblockUser = (id) => API.rpc("unblock_user", { p_target: id });
  // own blocked list (RLS: own rows only), used to filter chat and UI
  API.blockedIds = async function () {
    if (!API._blockedCache) API._blockedCache = _fetchBlocked();
    return API._blockedCache;
  };
  API.invalidateBlocked = () => { API._blockedCache = null; };
  async function _fetchBlocked() {
    const { data, error } = await sb.from("blocked_users").select("blocked_id");
    return error ? new Set() : new Set((data || []).map(r => r.blocked_id));
  }
  // social: global chat, DMs, online pulse, direct challenges
  API.sendGlobalChat = (body) => API.rpc("send_global_chat", { p_body: body });
  API.sendDm = (rcpt, body) => API.rpc("send_dm", { p_recipient: rcpt, p_body: body });
  API.markDmsRead = (partner) => API.rpc("mark_dms_read", { p_partner: partner });
  API.heartbeat = () => API.rpc("heartbeat");
  // moderation (creator/admin; role checks live in the database)
  API.adminDeleteMessage = (kind, id) => API.rpc("admin_delete_public_message", { p_kind: kind, p_id: id });
  API.adminMute = (userId, minutes, reason) => API.rpc("admin_mute", {
    p_target: userId, p_minutes: minutes || 15, p_reason: reason || null });
  API.adminUnmute = (userId) => API.rpc("admin_unmute", { p_target: userId });
  API.adminBan = (userId, reason) => API.rpc("admin_ban", { p_target: userId, p_reason: reason || null });
  API.adminUnban = (userId) => API.rpc("admin_unban", { p_target: userId });
  API.adminDeleteAccount = (userId) => API.rpc("admin_delete_account", { p_target: userId });
  API.adminDeleteClub = (clubId) => API.rpc("admin_delete_club", { p_club_id: clubId });
  API.adminDeleteThread = (threadId) => API.rpc("admin_delete_thread", { p_thread_id: threadId });
  API.adminDeleteReply = (replyId) => API.rpc("admin_delete_public_message", { p_kind: "forum_reply", p_id: replyId });
  API.adminDeleteBlogPost = (postId) => API.rpc("admin_delete_blog_post", { p_post_id: postId });
  API.adminSetRole = (userId, role) => API.rpc("admin_set_role", { p_target: userId, p_role: role });
  // replay positions are computed client-side with chess.js

  // Realtime subscriptions. Each channel remembers its status:
  // "SUBSCRIBED" means the websocket is up and page fallback polling
  // switches off (see API.poll). onStatus fires on every status change
  // so the page can quietly refetch after a reconnect.
  function track(ch, onStatus) {
    return (status) => {
      ch._rt = status;
      if (onStatus) { try { onStatus(status); } catch (e) {} }
    };
  }
  API.chUp = (ch) => !!(ch && ch._rt === "SUBSCRIBED");

  API.subscribeGame = function (gameId, onUpdate, onStatus) {
    const ch = sb.channel(`game:${gameId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
        (payload) => onUpdate(payload.new));
    ch.subscribe(track(ch, onStatus));
    return ch;
  };
  API.subscribeChat = function (gameId, onInsert, onStatus) {
    const ch = sb.channel(`chat:${gameId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "game_chat", filter: `game_id=eq.${gameId}` },
        (payload) => onInsert(payload.new));
    ch.subscribe(track(ch, onStatus));
    return ch;
  };
  API.subscribeClubChat = function (clubId, onInsert, onStatus) {
    const ch = sb.channel(`club:${clubId}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "club_chat", filter: `club_id=eq.${clubId}` },
        (payload) => onInsert(payload.new));
    ch.subscribe(track(ch, onStatus));
    return ch;
  };
  API.unsubscribe = (ch) => { if (ch) sb.removeChannel(ch); };

  // generic table subscription; RLS filters foreign rows. events defaults
  // to "INSERT" and may be an array such as ["INSERT","UPDATE"]
  API.subscribeInserts = function (table, filter, onInsert, onStatus, events) {
    const evs = events || ["INSERT"];
    const ch = sb.channel(`tbl:${table}:${Math.random().toString(36).slice(2, 8)}`);
    for (const ev of evs) {
      ch.on("postgres_changes",
        { event: ev, schema: "public", table, ...(filter ? { filter } : {}) },
        (payload) => onInsert(payload.new, ev));
    }
    ch.subscribe(track(ch, onStatus));
    return ch;
  };
  // Fallback polling. Ticks only while realtime is unavailable; with a
  // live channel it never fires. Hidden tabs are skipped entirely.
  // gate() skips a tick when polling is not needed, usually
  // () => API.chUp(chan).
  API.poll = function (ms, fn, gate) {
    const t = setInterval(() => {
      if (document.hidden) return;              // background tab: stay idle
      if (gate && gate()) return;               // realtime is up: no polling needed
      Promise.resolve().then(fn).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  };

  // Quiet refetch when the tab becomes visible again; page-level dedup handles changes.
  API.onVisible = function (fn) {
    const h = () => { if (!document.hidden) Promise.resolve().then(fn).catch(() => {}); };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  };

  // Guards against applying the same state twice (realtime plus polling).
  API.stateKey = function (g) {
    if (!g) return "";
    return [(g.moves || []).length, g.status, g.fen,
            g.draw_offer_by || "", g.takeback_by || "",
            g.white_ms, g.black_ms].join("|");
  };

  window.API = API;
})();
