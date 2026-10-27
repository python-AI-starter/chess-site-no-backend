-- Hot path optimization for the game functions. Highlights: make_move
-- computes the position key once and stops repetition checks after the
-- third match; get_game_state skips legal move generation (the client
-- computes moves with chess.js); claim_flag answers not_out to early
-- claims without any penalty; side-to-move reads come from the FEN turn
-- field; accept_takeback and get_replay parse the start FEN once and
-- replay over the board; several RPCs use RETURNING instead of a
-- second SELECT; heartbeat writes only when the pulse went stale.
-- Idempotent.

-- 1. make_move: one position key plus fast repetition counting
create or replace function public.make_move(p_game_id uuid, p_uci text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid       uuid := auth.uid();
    g           games%rowtype;
    v_is_white  boolean;
    v_opp       uuid;
    v_board     chess_board;
    v_res       chess_move_result;
    v_san       text;
    v_elapsed   bigint;
    v_mover_ms  int;
    v_remaining int;
    v_new_ms    int;
    v_key       text;
    v_rep       int;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;

    -- a malformed UCI string is rejected with no penalty: a correct
    -- client sends legal moves only (premoves are validated against
    -- chess.js before anything is sent)
    if p_uci is null or p_uci !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        return jsonb_build_object('ok', false, 'error', 'Неверный формат хода');
    end if;

    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;

    v_is_white := (v_uid = g.white);
    v_opp := case when v_is_white then g.black else g.white end;

    -- opponent banned: win without a fight
    if v_opp is not null and public.p_is_banned(v_opp) then
        perform public._finish_game(g.id,
            case when v_is_white then '1-0' else '0-1' end, v_uid, 'forfeit');
        select * into g from games where id = g.id;
        return jsonb_build_object('ok', true, 'game', to_jsonb(g), 'legal_moves', null,
                                  'server_now_ms', public.api_ms(clock_timestamp()),
                                  'event', 'forfeit');
    end if;

    -- FEN is parsed exactly once per move
    v_board := public.chess_parse_fen(g.fen);
    if v_board.white_to_move <> v_is_white then
        raise exception 'Сейчас не ваш ход';
    end if;

    -- CLOCKS: server time is the truth. Client messages may arrive late
    -- but never early; up to 1.5 s of network lag is forgiven.
    v_elapsed   := (extract(epoch from (clock_timestamp() - g.last_move_at)) * 1000)::bigint;
    v_mover_ms  := case when v_is_white then g.white_ms else g.black_ms end;
    v_remaining := v_mover_ms - v_elapsed::int;

    if v_remaining < -1500 then
        -- time is out: move rejected, loss by flag
        perform public._finish_game(g.id,
            case when v_is_white then '0-1' else '1-0' end,
            case when v_is_white then g.black else g.white end, 'timeout');
        select * into g from games where id = g.id;
        return jsonb_build_object('ok', true, 'game', to_jsonb(g), 'legal_moves', null,
                                  'server_now_ms', public.api_ms(clock_timestamp()),
                                  'event', 'flag_self');
    end if;

    -- legality, application, and status via the core over the parsed
    -- board. An illegal move raises nothing (the transaction would roll
    -- back): the move is simply rejected with ok:false and no penalty.
    v_res := public.chess_play_move_b(v_board, p_uci);
    if not v_res.is_legal then
        return jsonb_build_object('ok', false, 'error', 'Нелегальный ход');
    end if;

    -- SAN on the same board: no parse_fen, no second play_move, no full generation
    v_san := public.chess_san_b(v_board, p_uci, v_res.is_check,
                                v_res.reason = 'checkmate');

    v_new_ms := greatest(v_remaining, 0) + g.increment_ms;
    v_key    := public.pos_key(v_res.fen);   -- position key, once

    update games set
        fen              = v_res.fen,
        moves            = g.moves || jsonb_build_array(jsonb_build_object(
                             'u', p_uci, 's', v_san,
                             'w', case when v_is_white then v_new_ms else g.white_ms end,
                             'b', case when v_is_white then g.black_ms else v_new_ms end,
                             't', public.api_ms(clock_timestamp()))),
        position_history = g.position_history || v_key,
        white_ms         = case when v_is_white then v_new_ms else g.white_ms end,
        black_ms         = case when v_is_white then g.black_ms else v_new_ms end,
        last_move_at     = clock_timestamp(),
        draw_offer_by    = null,
        draw_offer_at    = null,
        takeback_by      = null,   -- moving implicitly declines a takeback
        takeback_at      = null
    where id = g.id returning * into g;

    -- engine-decided game end (mate / stalemate / material / 50 moves)
    if v_res.is_game_over then
        perform public._finish_game(g.id, v_res.result,
            case when v_res.result = '1-0' then g.white
                 when v_res.result = '0-1' then g.black
                 else null end,
            v_res.reason);
        select * into g from games where id = g.id;
    else
        -- threefold repetition: stop after 3 matches, no full scan
        select count(*) into v_rep
        from (select 1 from unnest(g.position_history) as k
               where k = v_key limit 3) t;
        if v_rep >= 3 then
            perform public._finish_game(g.id, '1/2-1/2', null, 'repetition');
            select * into g from games where id = g.id;
        end if;
    end if;

    return jsonb_build_object(
        'ok', true,
        'game', to_jsonb(g),
        -- the reply needs no legal move list: the client computes moves itself with chess.js
        'legal_moves', null,
        'server_now_ms', public.api_ms(clock_timestamp()),
        'event', case when g.status <> 'active' then 'game_over' else null end
    );
end $$;

revoke execute on function public.make_move(uuid, text) from anon;

-- 2. get_game_state: no legal move generation
-- The client computes legal moves locally (chess.js); the hottest read
-- of the site becomes a single SELECT by primary key.
create or replace function public.get_game_state(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    select * into g from games where id = p_game_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Партия не найдена'); end if;
    return jsonb_build_object(
        'ok', true,
        'game', to_jsonb(g),
        'you', case when v_uid = g.white then 'white'
                    when v_uid = g.black then 'black'
                    else null end,
        'server_now_ms', public.api_ms(clock_timestamp())
    );
end $$;

-- 3. claim_flag: no ban for premature claims
-- An early claim simply returns not_out: the client receives exact
-- server time and retries later if the opponent clock is truly out.
-- Honest clients with conservative sync can only claim late anyway.
create or replace function public.claim_flag(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid          uuid := auth.uid();
    g              games%rowtype;
    v_stm_is_white boolean;
    v_stm_ms       int;
    v_deadline     timestamptz;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;

    -- side to move from the 2nd FEN field (cheaper than a full parse)
    v_stm_is_white := split_part(g.fen, ' ', 2) = 'w';
    if v_uid = (case when v_stm_is_white then g.white else g.black end) then
        raise exception 'Нельзя заявить флаг на свой ход';
    end if;
    v_stm_ms   := case when v_stm_is_white then g.white_ms else g.black_ms end;
    v_deadline := g.last_move_at + (v_stm_ms * interval '1 millisecond');

    -- time not out yet: no penalty, the game continues
    if clock_timestamp() < v_deadline then
        return jsonb_build_object('ok', true, 'status', 'not_out',
                                  'game', to_jsonb(g),
                                  'server_now_ms', public.api_ms(clock_timestamp()));
    end if;

    -- honest flag: time is out by server clock
    perform public._finish_game(g.id,
        case when v_uid = g.white then '1-0' else '0-1' end, v_uid, 'timeout');
    select * into g from games where id = g.id;
    return jsonb_build_object('ok', true, 'status', 'timeout',
                              'game', to_jsonb(g), 'legal_moves', null,
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.claim_flag(uuid) from anon;

-- 4. claim_abandon: no chess_parse_fen
create or replace function public.claim_abandon(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
    v_i_am_stm boolean;
    v_idle_s   float;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;

    v_i_am_stm := (split_part(g.fen, ' ', 2) = 'w') = (v_uid = g.white);
    v_idle_s   := extract(epoch from (now() - g.last_move_at));

    -- when it is my move the opponent left after moving: wait longer
    if v_i_am_stm and v_idle_s < 300 then
        raise exception 'Соперник отсутствует слишком недолго (нужно 5 минут)';
    end if;
    if not v_i_am_stm and v_idle_s < 180 then
        raise exception 'Соперник отсутствует слишком недолго (нужно 3 минуты)';
    end if;

    perform public._finish_game(g.id,
        case when v_uid = g.white then '1-0' else '0-1' end, v_uid, 'abandonment');
    select * into g from games where id = g.id;
    return jsonb_build_object('ok', true, 'status', 'abandoned',
                              'game', to_jsonb(g), 'legal_moves', null,
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.claim_abandon(uuid) from anon;

-- 5. request_takeback: no chess_parse_fen, RETURNING
create or replace function public.request_takeback(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid   uuid := auth.uid();
    g       games%rowtype;
    v_i_am_stm boolean;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    if g.takeback_by is not null and g.takeback_by <> v_uid then
        raise exception 'Соперник уже просит откат — ответьте на его запрос';
    end if;
    v_i_am_stm := (split_part(g.fen, ' ', 2) = 'w') = (v_uid = g.white);
    if v_i_am_stm then
        -- my move now: only the pair (opponent reply + my move) may be reverted
        if jsonb_array_length(g.moves) < 2 then
            raise exception 'Нет вашего хода для отката';
        end if;
    else
        if jsonb_array_length(g.moves) < 1 then
            raise exception 'Ещё не сделано ни одного хода';
        end if;
    end if;
    update games set takeback_by = v_uid, takeback_at = now()
    where id = g.id returning * into g;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.request_takeback(uuid) from anon;

-- 6. accept_takeback: parse-once plus play_move_b, no final move generation
create or replace function public.accept_takeback(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid  uuid := auth.uid();
    g      games%rowtype;
    v_req  uuid;
    v_moves jsonb;
    v_hist text[];
    v_n    int;
    v_k    int;
    v_b    chess_board;
    v_res  chess_move_result;
    v_m    jsonb;
    v_req_is_white boolean;
    v_req_stm boolean;
    v_last jsonb;
    v_white_ms int;
    v_black_ms int;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    if g.takeback_by is null then raise exception 'Нет активного запроса на откат'; end if;
    if g.takeback_by = v_uid then raise exception 'Нельзя принять свой запрос — ждите соперника'; end if;

    v_req := g.takeback_by;
    v_n := jsonb_array_length(g.moves);
    if v_n < 1 then raise exception 'Нет ходов для отката'; end if;

    v_req_is_white := (v_req = g.white);
    -- side to move from the 2nd FEN field (cheaper than a full parse)
    v_req_stm := ((split_part(g.fen, ' ', 2) = 'w')) = v_req_is_white;
    v_k := case when v_req_stm then 2 else 1 end;
    if v_n < v_k then raise exception 'Нечего откатывать'; end if;

    -- truncate the move list and the position history. The history keeps
    -- 1 + remaining half-moves keys (start position plus one after every
    -- move), which keeps threefold repetition counting correct.
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_moves
      from jsonb_array_elements(g.moves) with ordinality as t(value, idx)
     where idx <= v_n - v_k;
    select coalesce(array_agg(u.k), array[]::text[]) into v_hist
      from unnest(g.position_history) with ordinality as u(k, idx)
     where idx <= v_n - v_k + 1;

    -- recompute the position from the start: the start FEN is parsed once
    -- and moves are then applied over the board
    -- (chess_validate_move_b + chess_make_move), with no per-half-move
    -- parse or to_fen.
    v_b := public.chess_parse_fen(g.start_fen);
    for v_m in select * from jsonb_array_elements(v_moves) loop
        if not public.chess_validate_move_b(v_b, v_m ->> 'u') then
            raise exception 'Партия повреждена: ход % нелегален', v_m ->> 'u';
        end if;
        v_b := public.chess_make_move(v_b,
                 public.chess_sq_from_name(substr(v_m ->> 'u', 1, 2)),
                 public.chess_sq_from_name(substr(v_m ->> 'u', 3, 2)),
                 nullif(substr(v_m ->> 'u', 5, 1), ''));
    end loop;

    -- clocks: values after the last kept half-move
    if v_n - v_k > 0 then
        v_last     := v_moves -> (v_n - v_k - 1);
        v_white_ms := (v_last ->> 'w')::int;
        v_black_ms := (v_last ->> 'b')::int;
    else
        v_white_ms := g.initial_ms;
        v_black_ms := g.initial_ms;
    end if;

    update games set
        fen              = public.chess_to_fen(v_b),
        moves            = v_moves,
        position_history = v_hist,
        white_ms         = v_white_ms,
        black_ms         = v_black_ms,
        last_move_at     = clock_timestamp(),
        draw_offer_by    = null,
        draw_offer_at    = null,
        takeback_by      = null,
        takeback_at      = null
    where id = g.id returning * into g;

    return jsonb_build_object(
        'ok', true,
        'game', to_jsonb(g),
        'server_now_ms', public.api_ms(clock_timestamp()),
        'event', 'takeback'
    );
end $$;

revoke execute on function public.accept_takeback(uuid) from anon;

-- 7. get_replay: parse-once plus play_move_b
create or replace function public.get_replay(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    g     games%rowtype;
    v_b   chess_board;
    v_fens text[] := array[]::text[];
    v_m   jsonb;
begin
    select * into g from games where id = p_game_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Партия не найдена'); end if;
    -- the start FEN is parsed once; the position then travels over the
    -- board (validate + make_move) and serializes once per half-move
    v_b := public.chess_parse_fen(g.start_fen);
    for v_m in select * from jsonb_array_elements(g.moves) loop
        if not public.chess_validate_move_b(v_b, v_m ->> 'u') then
            exit;
        end if;
        v_b := public.chess_make_move(v_b,
                 public.chess_sq_from_name(substr(v_m ->> 'u', 1, 2)),
                 public.chess_sq_from_name(substr(v_m ->> 'u', 3, 2)),
                 nullif(substr(v_m ->> 'u', 5, 1), ''));
        v_fens := v_fens || public.chess_to_fen(v_b);
    end loop;
    return jsonb_build_object(
        'ok', true,
        'start_fen', g.start_fen,
        'fens', to_jsonb(v_fens),
        'moves', g.moves,
        'white', g.white, 'black', g.black,
        'result', g.result, 'reason', g.reason, 'status', g.status,
        'rated', g.rated, 'initial_ms', g.initial_ms, 'increment_ms', g.increment_ms
    );
end $$;

-- 8. join_game: no legal_moves
create or replace function public.join_game(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;

    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;

    if g.status = 'active' and (g.white = v_uid or g.black = v_uid) then
        -- already my active game
        return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                                  'server_now_ms', public.api_ms(clock_timestamp()));
    end if;
    if g.status <> 'waiting' then raise exception 'К этой партии уже нельзя присоединиться'; end if;
    if g.white = v_uid or g.black = v_uid then
        return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                                  'server_now_ms', public.api_ms(clock_timestamp()));
    end if;
    if g.white is not null and g.black is not null then
        raise exception 'Партия уже полная'; end if;
    if g.invitee is not null and g.invitee <> v_uid then
        raise exception 'Этот вызов адресный — принять может только приглашённый';
    end if;

    update games set
        white = coalesce(white, v_uid),
        black = case when white is null then black else v_uid end,
        status = 'active',
        last_move_at = now()
    where id = g.id returning * into g;

    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.join_game(uuid) from anon;

-- 9. resign / draws: RETURNING instead of a second SELECT
create or replace function public.resign(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;

    perform public._finish_game(g.id,
        case when v_uid = g.white then '0-1' else '1-0' end,
        case when v_uid = g.white then g.black else g.white end, 'resign');
    select * into g from games where id = g.id;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g), 'legal_moves', null,
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.resign(uuid) from anon;

create or replace function public.offer_draw(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    if g.draw_offer_by is null then
        update games set draw_offer_by = v_uid, draw_offer_at = now()
        where id = g.id returning * into g;
    end if;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;
revoke execute on function public.offer_draw(uuid) from anon;

create or replace function public.decline_draw(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    -- the receiver declines the offer; the author cancels their own
    -- pending offer the same way, until the opponent accepts it
    if g.draw_offer_by is not null then
        update games set draw_offer_by = null, draw_offer_at = null
        where id = g.id returning * into g;
    end if;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;
revoke execute on function public.decline_draw(uuid) from anon;

create or replace function public.accept_draw(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    if g.draw_offer_by is null or g.draw_offer_by = v_uid then
        raise exception 'Нет активного предложения ничьей';
    end if;
    perform public._finish_game(g.id, '1/2-1/2', null, 'agreement');
    select * into g from games where id = g.id;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g), 'legal_moves', null,
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;
revoke execute on function public.accept_draw(uuid) from anon;

create or replace function public.decline_takeback(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;
    if g.status <> 'active' then raise exception 'Партия не активна'; end if;
    if v_uid <> g.white and v_uid <> g.black then raise exception 'Вы не участник партии'; end if;
    if g.takeback_by is null then raise exception 'Нет активного запроса на откат'; end if;
    update games set takeback_by = null, takeback_at = null
    where id = g.id returning * into g;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.decline_takeback(uuid) from anon;

-- 10. public.chess_san(fen): one parse_fen plus one play_move_b
-- A thin wrapper over the board functions; illegal moves still yield
-- the base SAN without check suffixes.
create or replace function public.chess_san(p_fen text, p_uci text)
returns text language plpgsql immutable as $$
declare
    v_b   chess_board;
    v_res chess_move_result;
begin
    if p_fen is null or p_uci is null then
        return p_uci;
    end if;
    if p_uci !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        return p_uci;
    end if;
    v_b := public.chess_parse_fen(p_fen);
    v_res := public.chess_play_move_b(v_b, p_uci);
    if not v_res.is_legal then
        -- illegal move: base SAN without check suffixes
        return public.chess_san_b(v_b, p_uci, false, false);
    end if;
    return public.chess_san_b(v_b, p_uci, v_res.is_check, v_res.reason = 'checkmate');
end $$;

-- 11. _finish_game: one UPDATE on games instead of two
create or replace function public._finish_game(
    p_game_id uuid, p_result text, p_winner uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
    g            games%rowtype;
    v_counted    boolean;
    v_rw         int;
    v_rb         int;
    v_score_w    float;
    v_expected_w float;
    v_delta_w    int;
    -- pool
    v_class      text;
    v_rw_c       int;
    v_rb_c       int;
    v_delta_w_c  int;
    v_pool_delta jsonb;
begin
    select * into g from games where id = p_game_id for update;
    if not found then return; end if;
    if g.status in ('finished','aborted') then return; end if; -- idempotent

    v_counted := coalesce(jsonb_array_length(g.moves), 0) >= 2; -- both players moved

    v_pool_delta := null;
    if v_counted and g.white is not null and g.black is not null then
        -- rating and stats only when both sides moved; deltas are computed
        -- before writing so games updates in a single statement
        v_score_w := case when p_result = '1-0' then 1.0
                          when p_result = '0-1' then 0.0 else 0.5 end;

        -- global rating
        select rating into v_rw from profiles where id = g.white;
        select rating into v_rb from profiles where id = g.black;

        if g.rated and v_rw is not null and v_rb is not null then
            v_expected_w := 1.0 / (1.0 + power(10.0, (v_rb - v_rw)::float / 400.0));
            v_delta_w    := round(32 * (v_score_w - v_expected_w))::int;
        else
            v_delta_w := 0;
        end if;

        -- pool (separate Elo per class)
        v_class := public.game_time_class(g.initial_ms, g.increment_ms);
        if v_class = 'bullet' then
            select rating_bullet into v_rw_c from profiles where id = g.white;
            select rating_bullet into v_rb_c from profiles where id = g.black;
        elsif v_class = 'blitz' then
            select rating_blitz into v_rw_c from profiles where id = g.white;
            select rating_blitz into v_rb_c from profiles where id = g.black;
        elsif v_class = 'rapid' then
            select rating_rapid into v_rw_c from profiles where id = g.white;
            select rating_rapid into v_rb_c from profiles where id = g.black;
        else
            select rating_classic into v_rw_c from profiles where id = g.white;
            select rating_classic into v_rb_c from profiles where id = g.black;
        end if;

        if g.rated and v_rw_c is not null and v_rb_c is not null then
            v_delta_w_c := round(32 * (v_score_w
                - 1.0 / (1.0 + power(10.0, (v_rb_c - v_rw_c)::float / 400.0))))::int;
        else
            v_delta_w_c := 0;
        end if;

        v_pool_delta := jsonb_build_object(
            'white', v_delta_w, 'black', -v_delta_w,
            'class', v_class,
            'white_class', v_delta_w_c, 'black_class', -v_delta_w_c);
    else
        v_delta_w := 0;
        v_delta_w_c := 0;
        v_class := null;
    end if;

    -- the result is always recorded (including first-move flags and
    -- cheats) in a single update
    update games set status = 'finished', result = p_result, winner = p_winner,
                     reason = p_reason, finished_at = now(),
                     rating_delta = v_pool_delta
    where id = g.id;

    if not v_counted then return; end if;
    if g.white is null or g.black is null then return; end if;

    -- white
    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '1-0' then 1 else 0 end),
        losses = losses + (case when p_result = '0-1' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating + v_delta_w) else rating end,
        games_bullet   = games_bullet   + (case when v_class = 'bullet'  then 1 else 0 end),
        games_blitz    = games_blitz    + (case when v_class = 'blitz'   then 1 else 0 end),
        games_rapid    = games_rapid    + (case when v_class = 'rapid'   then 1 else 0 end),
        games_classic  = games_classic  + (case when v_class = 'classic' then 1 else 0 end),
        rating_bullet  = case when g.rated and v_class = 'bullet'
                               then greatest(100, rating_bullet + v_delta_w_c) else rating_bullet end,
        rating_blitz   = case when g.rated and v_class = 'blitz'
                               then greatest(100, rating_blitz + v_delta_w_c) else rating_blitz end,
        rating_rapid   = case when g.rated and v_class = 'rapid'
                               then greatest(100, rating_rapid + v_delta_w_c) else rating_rapid end,
        rating_classic = case when g.rated and v_class = 'classic'
                               then greatest(100, rating_classic + v_delta_w_c) else rating_classic end
    where id = g.white;

    -- black
    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '0-1' then 1 else 0 end),
        losses = losses + (case when p_result = '1-0' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating - v_delta_w) else rating end,
        games_bullet   = games_bullet   + (case when v_class = 'bullet'  then 1 else 0 end),
        games_blitz    = games_blitz    + (case when v_class = 'blitz'   then 1 else 0 end),
        games_rapid    = games_rapid    + (case when v_class = 'rapid'   then 1 else 0 end),
        games_classic  = games_classic  + (case when v_class = 'classic' then 1 else 0 end),
        rating_bullet  = case when g.rated and v_class = 'bullet'
                               then greatest(100, rating_bullet - v_delta_w_c) else rating_bullet end,
        rating_blitz   = case when g.rated and v_class = 'blitz'
                               then greatest(100, rating_blitz - v_delta_w_c) else rating_blitz end,
        rating_rapid   = case when g.rated and v_class = 'rapid'
                               then greatest(100, rating_rapid - v_delta_w_c) else rating_rapid end,
        rating_classic = case when g.rated and v_class = 'classic'
                               then greatest(100, rating_classic - v_delta_w_c) else rating_classic end
    where id = g.black;
end $$;

-- 12. heartbeat: avoid extra row versions
create or replace function public.heartbeat()
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then return; end if;
    -- pulses arrive every 30 s; write only when more than 5 s passed
    update public.profiles set last_seen_at = now()
    where id = auth.uid()
      and (last_seen_at is null or last_seen_at < now() - interval '5 seconds');
end $$;

revoke execute on function public.heartbeat() from public, anon;
grant execute on function public.heartbeat() to authenticated;
