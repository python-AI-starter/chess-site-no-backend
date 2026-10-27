-- Game flow: state, moves, flags and anti-cheat, resign, draws, chat.

-- Game state (for the game page)
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

-- Make a move
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
    v_board := chess_parse_fen(g.fen);
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

-- Resign
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

-- Abort: either player may cancel a fresh game with no rating or stats
-- change. Allowed strictly before both players made one move each
-- (fewer than two half-moves on the board); after that the game must
-- end through the normal outcomes.
create or replace function public.abort_game(p_game_id uuid)
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
    if coalesce(jsonb_array_length(g.moves), 0) >= 2 then
        raise exception 'Отменить партию можно, только пока оба игрока не сделали по одному ходу';
    end if;
    update games set status = 'aborted', result = null, winner = null, reason = 'abort',
                     draw_offer_by = null, draw_offer_at = null,
                     takeback_by = null, takeback_at = null,
                     finished_at = now()
    where id = g.id returning * into g;
    return jsonb_build_object('ok', true, 'game', to_jsonb(g), 'legal_moves', null,
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.abort_game(uuid) from anon;

-- Claim flag (opponent time is out)
-- A claim counts when server time has passed the deadline (small
-- tolerance for sync drift; honest clients claim with margin since
-- network delays only make them late). A premature claim returns
-- not_out without any penalty (see 09_optimization.sql).
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

-- Claim abandonment
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

-- Draws
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

-- Game chat
create or replace function public.send_chat(p_game_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row game_chat%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
        raise exception 'Сообщение должно быть от 1 до 500 символов';
    end if;
    if not exists (select 1 from games g
                   where g.id = p_game_id
                     and g.status in ('active','finished')
                     and (g.white = v_uid or g.black = v_uid)) then
        raise exception 'Чат доступен только участникам партии';
    end if;
    -- rate limit: one message per 800 ms
    if exists (select 1 from game_chat c
               where c.user_id = v_uid
                 and c.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into game_chat (game_id, user_id, body)
    values (p_game_id, v_uid, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;
revoke execute on function public.send_chat(uuid, text) from anon;

-- Takeback: a player asks the opponent for permission to replay their
-- last move. On approval one half-move is removed (the requester just
-- moved) or two (the opponent already replied), so that the requester
-- is on move again. The engine recomputes the position from the start
-- and both clocks restore to the last kept half-move.

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
    v_b := chess_parse_fen(g.start_fen);
    for v_m in select * from jsonb_array_elements(v_moves) loop
        if not chess_validate_move_b(v_b, v_m ->> 'u') then
            raise exception 'Партия повреждена: ход % нелегален', v_m ->> 'u';
        end if;
        v_b := chess_make_move(v_b,
                 chess_sq_from_name(substr(v_m ->> 'u', 1, 2)),
                 chess_sq_from_name(substr(v_m ->> 'u', 3, 2)),
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
        fen              = chess_to_fen(v_b),
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

-- Club chat
create or replace function public.send_club_chat(p_club_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row club_chat%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
        raise exception 'Сообщение должно быть от 1 до 500 символов';
    end if;
    if not exists (select 1 from club_members m
                   where m.club_id = p_club_id and m.user_id = v_uid) then
        raise exception 'Чат клуба доступен только участникам клуба';
    end if;
    -- rate limit: one message per 800 ms
    if exists (select 1 from club_chat c
               where c.user_id = v_uid
                 and c.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into club_chat (club_id, user_id, body)
    values (p_club_id, v_uid, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

revoke execute on function public.send_club_chat(uuid, text) from anon;

-- Username change
create or replace function public.set_username(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_username is null or p_username !~ '^[a-zA-Z0-9_-]{2,20}$' then
        raise exception 'Ник: 2-20 символов, латиница, цифры, _ и -';
    end if;
    if exists (select 1 from profiles p
               where lower(p.username) = lower(p_username) and p.id <> v_uid) then
        raise exception 'Ник уже занят';
    end if;
    update profiles set username = p_username where id = v_uid;
    return jsonb_build_object('ok', true, 'username', p_username);
end $$;
revoke execute on function public.set_username(text) from anon;
