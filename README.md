# Ladya — Free Online Chess

Online chess in the spirit of Lichess on a serverless stack: a static
frontend plus Supabase (PostgreSQL 17, Auth, Realtime). There is no
application server; the client talks to the database directly, and all
logic and security live in PostgreSQL (RLS plus security definer functions).

Chess logic is split in two:

- Client: the vendored chess.js 1.4.0 (`vendor/chess.js`, local, no
  external requests) powers legal-move highlights, premove filtering
  (an illegal premove is dropped locally and never sent), and game
  replay (positions after each half-move are computed in the browser,
  no RPC needed).
- Server: a PL/pgSQL engine equivalent to chess.js
  (`sql/01_chess_engine.sql`) with bitboards validates every submitted
  move and decides the game result (checkmate, stalemate, fifty-move
  rule, insufficient material). The client cannot play an illegal move
  or fabricate a game.

The hot path is light: one move means one FEN parse, one move
application, and one SAN computation, with no redundant move
generation (mid-game measurements: ~0.47 ms versus ~1.9 ms in the
original design; `get_game_state` ~0.23 ms versus ~0.82 ms).

## Quick start

The Supabase project is already configured (schema applied, keys set in
`js/config.js`), so serving the static files is enough:

```bash
# port 3000 is recommended: the confirmation email links to it
python3 -m http.server 3000    # in the site folder -> http://localhost:3000
# any other static host or port works too, but see the note below
```

1. Sign up (email plus password, nickname 2-20 characters).
2. Follow the link from the confirmation email: you are signed in
   automatically, no login form needed (the session is picked up from
   the URL, `detectSessionInUrl`).
3. Use Quick pairing to find an opponent from the queue, or create a
   link challenge and send it to a friend.

If emails are not delivered: in the Supabase dashboard, Authentication,
turn "Confirm email" OFF and sign-in works right after signup. If the
site will not live on localhost:3000, set the site address as the Site
URL in Authentication, URL Configuration (and add it to Redirect URLs)
so email links lead back to it.

## Features

- Games: bullet, blitz, rapid, and classic (0.5+0 up to 30+20, custom
  controls with a 30 second minimum), rating pools with separate Elo
  per class (start 1000, K=32, class derived from the control), link
  challenges, direct challenges to a player (only the invitee can
  accept, the invite arrives as a DM), and spectating other games.
- Premoves, Lichess style: while the opponent is thinking, stage a move
  by click or drag (including promotion) to any square with no local
  legality checks; it is sent automatically once the opponent moves,
  and the server rejects it if illegal. Cancel with a click on the
  premove, the Cancel button, or a right-click anywhere on the board.
- Optimistic UI: own moves render instantly (chess.js recomputes the
  position) while the RPC runs in the background; if the server rejects
  the move the board rolls back. Chats behave the same way.
- Board arrows: right-drag green, Ctrl/Shift right-drag red, Alt
  right-drag blue; left-click clears them, redrawing the same arrow
  removes it.
- Mobile support: touch-action none on the board and pointercancel
  handling keep drag-and-drop and premoves working on touchscreens.
- Theme: light and dark toggle in the navbar, choice persisted.
- Clocks are server-backed; see below.
- Game endings: checkmate, stalemate, resign, flag, threefold
  repetition, fifty-move rule, insufficient material, agreement draw,
  and abandonment (claimable after 3/5 minutes of inactivity).
- In game: chat (participants only, Realtime, rate limited), draw
  offers, resign, and takeback. A takeback asks the opponent to allow
  replaying the last move; on approval the engine recomputes the
  position and both clocks are restored.
- Pieces: the cburnett vector set (the Lichess classic) inlined as SVG,
  sharp at any scale, no external requests.
- Community: forum (threads plus replies), clubs (club page with
  description, member list, and live club chat), blog (posts with
  editing), leaderboard, and profiles.
- Pool leaderboards with tabs for bullet, blitz, rapid, and classic;
  profiles show every rating.
- Moderation (CREATOR and ADMIN roles): badges in profiles and chats,
  deleting any public message (global chat, club chat, forum replies),
  muting authors for N minutes (default 15; a mute blocks global chat,
  club chat, forum, and blog, but never game chat or DMs), deleting any
  club, forum thread, blog post, or account (double confirmation),
  banning and unbanning (a ban ends the offender's active games as a
  forfeit), and assigning user/creator/admin roles. The hierarchy is
  protected: the creator cannot be muted, banned, deleted, or demoted,
  and only the creator manages admins.
- Global chat on the home page (guests read, signing in to write,
  Realtime, rate limited) and direct messages: a dialog list with an
  unread badge, live conversations, and clickable game links. Write and
  Challenge buttons live in profiles.
- Online pulse: a heartbeat every 30 s lights a pulsing online
  indicator in leaderboards and profiles.
- Replay: recent games on the leaderboard expand into a replay (board,
  controls, clickable move list, keyboard arrows, autoplay that does
  not stall after the first half-move); finished games have the same
  replay on their page.
- Open challenges are always visible: the list refreshes through both
  Realtime and plain polling even with a live websocket, plus a manual
  refresh button and a server-time freshness window. The author sees an
  Open button, everyone else sees Accept with an immediate start.
- Realtime with a smart fallback: opponent moves, chats, DMs,
  challenges, and notifications arrive instantly over websockets.
  While a websocket is up, polling is fully off; if Realtime is
  unavailable, polling takes over. Hidden tabs sleep, and returning to
  a tab does one quiet refetch without redrawing the UI unless data
  actually changed.
- Player blocks: block from any profile. A blocked player cannot DM you
  or challenge you (enforced in the database, both directions), their
  global chat messages are hidden, and quick pairing never pairs
  blocked players (`10_fix_quick_pair_blocks.sql`). Your profile keeps
  a private blocked-players card with unblocking.
- Profile links everywhere nicknames appear: chats, forum and blog
  authors, club owners and members, game histories, leaderboard.
- The home page renders instantly (skeleton before network calls), and
  the active menu item is highlighted synchronously on every navigation.
- All input happens in modal forms or dedicated pages; no browser
  prompt() dialogs.

## Clocks and anti-cheat

The client renders the clocks using server time, but the database
decides everything:

- Every RPC reply carries `server_now_ms`; the client syncs
  conservatively, so its estimate always runs late and never early.
- `claim_flag` (opponent is out of time): if server time passed the
  deadline the claim stands and the claimer wins. If time is not out
  yet the claim is simply rejected with `not_out` and no penalties; the
  client receives exact server time and retries later if needed. An
  honest client with conservative sync can only claim late.
- Moves arriving after the clock expired are rejected with a 1.5 s
  allowance for network lag; a message can only be late, never early.
- Illegal moves: a correct client sends only legal moves (premoves are
  filtered locally through chess.js), and the database rejects any
  illegal ones; three strikes within 24 hours auto-ban the account.
- Abandonment: either player may claim a win when the opponent has been
  idle for 3 minutes (while it is the opponent's move) or 5 minutes
  (while it is yours).

## Security model

| Layer | Protection |
|---|---|
| RLS on every table | `profiles`, `games`, `seeks`, `game_chat`, `club_chat`, `chat_messages`, `dm_messages`, `forum_*`, `clubs`, `club_members`, `blog_posts`; global chat and games are publicly readable, DMs only for the participants, writes through policies or RPC-only |
| Games via RPC only | `games` has no INSERT/UPDATE/DELETE policies, so a game cannot be modified directly; `make_move` checks membership, turn, legality (the database engine), and clocks |
| Keys | only the `sb_publishable_...` key ships with the frontend; the secret key was used only during setup and never reaches the client |
| Functions | all `security definer` with `SET search_path = public`; mutation rights revoked from `anon` |
| Bans | `make_move`, chat, forum, clubs, blog, and matchmaking all check `is_banned`; auto-ban applies only to repeated illegal moves (3 in 24 h) |
| Anti-spam | chats and DMs are limited to one message per 0.8 s, enforced in the RPCs |

## Structure

```text
index.html              entry point
css/style.css           styles, Lichess-inspired
js/config.js            Supabase URL and publishable key
js/api.js               Supabase client, RPC wrappers, Realtime helpers
js/time.js              conservative server-time synchronization
js/pieces.js            cburnett pieces (inline SVG, CC-BY-SA 3.0)
js/board.js             board rendering, click-click and drag&drop
js/game.js              game page: clocks, Realtime, chat, actions, replay
js/replay.js            replay component (controls, autoplay, move list)
js/lobby.js             quick pairing, challenges, global chat on the home page
js/pages.js             login/signup, profile, leaderboard (pulse, replays)
js/community.js         forum, clubs with club chat, blog
js/chat.js              global chat and direct messages
js/app.js               router, navbar, heartbeat, instant rendering
vendor/supabase.js      supabase-js v2 (UMD, local)
vendor/chess.js         chess.js 1.4.0 (MIT, local): legal moves,
                        premoves, and replay on the client
sql/01_chess_engine.sql chess engine in PL/pgSQL (chess.js equivalent)
sql/02_schema.sql       tables, RLS, triggers, Realtime
sql/03_functions_core.sql  SAN, matchmaking, finalization with Elo
sql/04_functions_game.sql  moves, flags and anti-cheat, draws, takeback, chats
sql/05_hardening.sql    permissions: mutations require authenticated
sql/06_social.sql       global chat, DMs, online pulse, direct challenges, replay
sql/07_pools.sql        rating pools (bullet/blitz/rapid/classic), start 1000
sql/08_blocks.sql       player blocks (DMs and challenges denied both ways)
sql/09_optimization.sql hot path optimization
sql/10_fix_quick_pair_blocks.sql  quick pairing respects blocks
sql/11_admin_moderation.sql  creator/admin roles, mutes, deletions, bans
```

## Installing on a fresh Supabase project

1. SQL Editor: run `sql/01` through `sql/08` in order, then the rest if
   moderation and the quick-pairing fix are wanted.
2. Authentication: enable Email, optionally disable confirmation; set
   Site URL to the site address (http://localhost:3000 for local runs).
3. Put the URL and publishable key into `js/config.js`.
4. Realtime is enabled automatically through the `supabase_realtime`
   publication in `02_schema.sql`.

## Licenses

The cburnett piece set is (c) Colin M.L. Burnett, licensed
CC-BY-SA 3.0 / GFDL, source: Wikimedia Commons
(https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces).
