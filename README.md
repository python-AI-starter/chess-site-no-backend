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
generation.

## Quick start

The site is fully serverless: a static frontend hosted on GitHub Pages plus
Supabase (PostgreSQL 17, Auth, Realtime). The Supabase project is already
configured (schema applied, keys set in `js/config.js`), so publishing the
folder as a GitHub Pages site is the whole deployment:

1. Push the site files to a GitHub repository.
2. Repository Settings -> Pages -> deploy from the branch that holds the
   files (root). GitHub Pages serves the site over HTTPS automatically.
3. In Supabase, Authentication -> URL Configuration, set the Site URL to
   the Pages address and add it to Redirect URLs, so confirmation email
   links lead back to the site.

No build step and no server code are required. For a local preview any
static file server works (localhost is a secure context, so everything
including the engine runs there too); the file server should fall back
to index.html for unknown paths so the clean routes resolve directly:

```bash
python3 -m http.server 8000     # or: npx serve -s .
```

## Routing

Navigation uses the History API: every tab lives on a plain path
(/forum, /dm, /game/<id>, /editor/<fen>) with no hash. Three pieces
make that work on a static host with no server code:

- the router renders from location.pathname and pushes clean paths;
- after the service worker is installed, coi-sw.js answers navigations
  to unknown paths with index.html (plus a <base> tag with the app root,
  so assets resolve at any route depth and on project-page subpaths);
- before the worker is installed, 404.html catches deep links, finds the
  app base by probing for the service worker file and hands the route
  over to the entry point through sessionStorage.

Old #/... bookmarks and stored #/game/... message links are normalized
to the clean path on load.

### Engine multithreading without server code

The multi-threaded Stockfish build needs SharedArrayBuffer, and browsers
only expose it to a cross-origin isolated page. Static hosts such as
GitHub Pages cannot add the required response headers, so the site
generates them in the client: `coi-sw.js` is a small service worker that
intercepts page navigations and adds

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

to the response itself. The inline bootstrap in `index.html` registers the
worker and reloads the page once; from then on every load is cross-origin
isolated and the multi-threaded engine runs at full speed. Nothing is
needed from the hosting side; if a browser blocks service workers, the
engine transparently falls back to the single-threaded build with threads
fixed at 1.

## Features

- Games: bullet, blitz, rapid, and classic (0.5+0 up to 30+20, custom
  controls with a 30 second minimum), rating pools with separate Elo
  per class (start 1000, K=32, class derived from the control), link
  challenges, direct challenges to a player (only the invitee can
  accept, the invite arrives as a DM), and spectating other games.
  Either player may abort a fresh game with no rating change until
  both players have made one move (exclusive); after that the game
  ends only through its normal outcomes.
- Premoves, Lichess style: while the opponent is thinking, stage a move
  by click or drag (including promotion) to any square with no local
  legality checks. Once the opponent moves, the staged move is
  validated locally with chess.js: it plays automatically when legal
  and is cancelled silently when not — the server never receives an
  illegal move. Cancel manually with a click on the premove, the
  Cancel button, or a right-click anywhere on the board.
- Optimistic UI: own moves render instantly (chess.js recomputes the
  position) while the RPC runs in the background; if the server rejects
  the move the board rolls back. Chats behave the same way.
- Board marks: right-drag draws an arrow, right-click on a square draws
  a circle around it. Plain is green, Alt is blue, Ctrl/Shift is red;
  redrawing the same mark removes it. Arrows and circles may coexist;
  a left-click on the board clears them all. Any right-button press
  cancels a staged premove.
- Mobile support: touch-action none on the board and pointercancel
  handling keep drag-and-drop and premoves working on touchscreens.
- Languages: the interface is localized into Russian, English, and
  Chinese (`locales/ru.json`, `locales/en.json`, `locales/zh.json`).
  The language follows the browser settings: Russian or Chinese
  browsers get their translation, everyone else gets English. Server
  messages (database errors) are translated on the client as well.
- Theme: light and dark toggle in the navbar, choice persisted.
- Clocks are server-backed; see below.
- Game endings: checkmate, stalemate, resign, flag, threefold
  repetition, fifty-move rule, insufficient material, agreement draw,
  and abandonment (claimable after 3/5 minutes of inactivity).
- In game: chat (participants only, Realtime, rate limited), draw
  offers, resign, abort, and takeback. A draw offer is shown to its
  author like a premove (it stays pending until the opponent answers)
  and can be cancelled any time before the acceptance. A takeback asks
  the opponent to allow replaying the last move; on approval the
  engine recomputes the position and both clocks are restored.
- Pieces: the cburnett vector set (the Lichess classic) inlined as SVG,
  sharp at any scale, no external requests.
- Community: forum (threads plus replies), clubs (club page with an
  owner-editable description, member exclusion by the owner, member
  list, and live club chat), blog (posts with editing), leaderboard,
  and profiles.
- Pool leaderboards with tabs for bullet, blitz, rapid, and classic;
  profiles show every rating.
- Moderation (CREATOR and ADMIN roles): badges in profiles and chats,
  deleting any public message including their own (global chat, club
  chat, forum replies; muting yourself is denied),
  muting authors for N minutes (default 15; a mute blocks global chat,
  club chat, forum, and blog, but never game chat or DMs),
  banning and unbanning (a ban ends the offender's active games as a
  forfeit), deleting accounts (double confirmation), and assigning
  user/creator/admin roles. Deleting a whole club, forum thread, or
  blog post is reserved for the creator; a moderator cannot do it at
  any level and only removes individual public messages. The hierarchy is
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
  replay with the same autoplay button on their page. Every replay and
  every game page carries FEN and PGN export: FEN is taken from the
  position currently shown (any replay ply, the live position of a
  running game), PGN is assembled client-side with chess.js and tagged
  with players, Elo, result, and the time control. The export opens in
  a modal with copy and download buttons.
- Engine analysis with Stockfish 19 WASM (the npm stockfish build,
  ~94 MB with the embedded NNUE network). The engine runs entirely in
  the browser: the binaries are fetched from a third-party CDN
  (unpkg) by the client, kept in the browser Cache Storage, and the
  database never sees any engine traffic. The web worker is created
  from the cached loader, so reopening analysis after closing the tab
  neither re-downloads nor re-instantiates anything; the worker itself
  stays alive for the whole page session. The UCI bridge is hardened
  for long sessions: options are confirmed with a readyok handshake
  before every search (a Threads change followed by an immediate
  search can otherwise deadlock the build), a watchdog rebuilds the
  worker from the cache and replays the search if the engine ever goes
  silent, and positions impossible in a real game (a hand-typed FEN
  where the side not to move is already in check) are refused with a
  hint instead of being searched. Available on the standalone
  analysis board (/analysis), on finished game pages (a toggle next
  to the move list), and right inside the leaderboard "Watch" replay.
  A game that ended by the rules of chess (checkmate, stalemate,
  fifty-move rule, insufficient material, threefold repetition) shows
  "Game over" in the panel instead of a thinking state, and the
  Stockfish worker is never created for it; endings decided by the
  players (resign, flag, agreement) keep the engine available.
  The panel follows the Lichess layout everywhere: a vertical
  evaluation bar with a midpoint mark next to the board, the engine
  box at the very top of the side column (no scrolling needed), the
  move list in the middle, the interface buttons at the bottom, and
  the FEN/PGN fields directly under the board. It shows numbered SAN
  variations, depth and speed, and a gear menu with the search time
  per move (infinite or fixed), the number of variations (MultiPV
  1-5), threads, and the hash memory size; settings persist in
  localStorage. The best move is drawn on the board as a light-blue
  arrow (lighter than the Alt-drawn mark), MultiPV runner-ups as gray
  arrows that fade with each worse line, up to five in total. The
  multi-threaded build is used automatically when the browser is
  cross-origin isolated, which the site provides in the client via the
  coi-sw.js service worker (no server code needed, works on GitHub
  Pages, see Quick start); threads default to half the
  CPU cores with an Auto option in the gear menu, and without
  isolation the single-threaded build runs with threads at 1.
- Analysis board (/analysis, link in the navbar): free board for both
  colors, move list with keyboard navigation, FEN loading from a query
  parameter (/analysis?fen=...) or by pasting it into the inline field
  under the board (it applies itself, no load button), move undo,
  position reset, and the same inline PGN field for importing a game or
  copying the current line.
- Board editor (/editor, link in the navbar): Lichess-style position
  setup. Pieces of both colors sit in trays above and below the board;
  a click loads a piece for placement (clicks or drags place copies),
  board pieces move by drag or click-click, right-click deletes, and
  the trash tool deletes with a left click (sweeping works too). Flip,
  start position and clear board buttons, plus a side-to-move toggle.
  Castling checkboxes (O-O and O-O-O per side) exist only while the
  required king and rook stand on their original squares; moving them
  away removes the option entirely. The en passant control lists every
  square the side to move can capture on (for a white pawn on e5 with
  black pawns on d5 and f5 that is none, d6 or f6), none by default.
  The FEN field applies a pasted or edited position after Enter, the
  URL field holds a /editor/<fen> link that reopens the exact position
  and rules, and the analyze button sends the position to the analysis
  board with castling, en passant and turn intact.
- Open challenges mirror the quick-pairing queue: the list shows every
  player searching through "Быстрая игра" (the seeks table, publicly
  readable, so guests see it too). Own seeks appear in the list at
  once, before the server confirms them, and a cancel in either panel
  (the quick-game status or the open list) stops both. Accepting a seek
  joins the same pool and pairs with its owner at once; the author gets
  a Cancel button. Link challenges stay private (joinable only through
  their link) and direct challenges reach the invitee as a DM, so
  neither appears in the list. The list refreshes through Realtime and
  plain polling even with a live websocket, plus a manual refresh
  button.
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
  yet the claim is simply rejected with `not_out` and no penalties;
  the client receives exact server time and retries later if needed.
  A premature claim is never punished.
- Moves arriving after the clock expired are rejected with a 1.5 s
  allowance for network lag; a message can only be late, never early.
- Illegal moves: the client sends only legal moves (premoves are
  validated against chess.js before anything is sent), and the
  database rejects any illegal ones with no penalty. No automatic
  bans exist for moves or clock claims; bans are admin-only.
- Abandonment: either player may claim a win when the opponent has been
  idle for 3 minutes (while it is the opponent's move) or 5 minutes
  (while it is yours).

## Security model

| Layer | Protection |
|---|---|
| RLS on every table | `profiles`, `games`, `seeks`, `game_chat`, `club_chat`, `chat_messages`, `dm_messages`, `forum_*`, `clubs`, `club_members`, `blog_posts`; global chat, games, and quick-pairing seeks are publicly readable, DMs only for the participants, writes through policies or RPC-only |
| Games via RPC only | `games` has no INSERT/UPDATE/DELETE policies, so a game cannot be modified directly; `make_move` checks membership, turn, legality (the database engine), and clocks |
| Keys | only the `sb_publishable_...` key ships with the frontend; the secret key was used only during setup and never reaches the client |
| Functions | all `security definer` with `SET search_path = public`; mutation rights revoked from `anon` |
| Bans | `make_move`, chat, forum, clubs, blog, and matchmaking all check `is_banned`; bans are applied only by moderators — there are no automatic bans |
| Anti-spam | chats and DMs are limited to one message per 0.8 s, enforced in the RPCs |

## Structure

```text
index.html              entry point; registers coi-sw.js for client-side
                        cross-origin isolation (SharedArrayBuffer)
coi-sw.js               service worker adding the COOP/COEP headers to page
                        navigations: engine multithreading with no server code;
                        also serves index.html for client-side routes and
                        injects a <base> tag, which makes clean paths like
                        /forum work on any static host
404.html                hands first-visit deep links (/forum, /editor/<fen>)
                        over to the entry point; needed before the service
                        worker is installed, e.g. on GitHub Pages
css/style.css           styles, Lichess-inspired
js/config.js            Supabase URL and publishable key
js/i18n.js              language detection (ru/zh/en), dictionaries, server-message translation
locales/ru.json         Russian interface strings
locales/en.json         English interface strings
locales/zh.json         Chinese interface strings
js/api.js               Supabase client, RPC wrappers, Realtime helpers
js/exporter.js          FEN/PGN export (chess.js PGN builder, copy/download modal)
js/engine.js            Stockfish 19 WASM host: CDN fetch, Cache Storage,
                        blob worker, UCI bridge
js/analysis.js          engine analysis panel (vertical eval bar, MultiPV
                        lines, gear menu), the /analysis board page, and
                        the inline auto-applying FEN/PGN fields
js/editor.js            board editor page (/editor): piece trays, trash,
                        castling and en passant rules, FEN/URL fields
js/time.js              conservative server-time synchronization
js/pieces.js            cburnett pieces (inline SVG, CC-BY-SA 3.0)
js/board.js             board rendering, click-click and drag&drop, arrows
                        and circles (manual marks plus engine arrows)
js/game.js              game page: clocks, Realtime, chat, actions, replay
js/replay.js            replay component (controls, autoplay, move list)
js/lobby.js             quick pairing, challenges, global chat on the home page
js/pages.js             login/signup, profile, leaderboard (pulse, replays)
js/community.js         forum, clubs with club chat, blog
js/chat.js              global chat and direct messages
js/app.js               router (History API clean paths, no hash), navbar,
                        heartbeat, instant rendering
vendor/supabase.js      supabase-js v2 (UMD, local)
vendor/chess.js         chess.js 1.4.0 (MIT, local): legal moves,
                        premove validation, and replay on the client
sql/01_chess_engine.sql chess engine in PL/pgSQL (chess.js equivalent)
sql/02_schema.sql       tables, RLS, triggers, Realtime
sql/03_functions_core.sql  SAN, matchmaking, finalization with Elo
sql/04_functions_game.sql  moves, flags, draws, takeback, chats
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
   moderation and the quick-pairing fix are wanted. The `sql/` folder in
   the repository always mirrors the live database.
2. Authentication: enable Email, optionally disable confirmation; set
   Site URL to the site address (the GitHub Pages URL for production).
3. Put the URL and publishable key into `js/config.js`.
4. Realtime is enabled automatically through the `supabase_realtime`
   publication in `02_schema.sql`.

## Licenses

The cburnett piece set is (c) Colin M.L. Burnett, licensed
CC-BY-SA 3.0 / GFDL, source: Wikimedia Commons
(https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces).

Stockfish 19 (the WASM build fetched at runtime from the npm CDN) is
GPL-3.0, (c) the Stockfish developers
(https://github.com/official-stockfish/Stockfish); the engine binaries
are never bundled with the site files and are not stored in the
repository or the database.
