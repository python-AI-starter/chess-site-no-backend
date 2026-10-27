-- Social: global chat, direct messages, online pulse, direct
-- challenges, and replay. Idempotent; depends on 02/03/04/05.

-- 1. Global chat
create table if not exists public.chat_messages (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references public.profiles(id) on delete cascade,
    body       text not null check (char_length(btrim(body)) between 1 and 500),
    created_at timestamptz not null default now()
);
create index if not exists chat_messages_created_idx on public.chat_messages (created_at desc);

alter table public.chat_messages enable row level security;

-- readable by everyone including guests: lobby chat, as on Lichess
drop policy if exists "global_chat_select_public" on public.chat_messages;
create policy "global_chat_select_public" on public.chat_messages for select using (true);
-- inserts only through the send_global_chat RPC (rate limit and bans in the function)
drop policy if exists "global_chat_insert_any" on public.chat_messages;
-- authors may delete their own message
drop policy if exists "global_chat_delete_own" on public.chat_messages;
create policy "global_chat_delete_own" on public.chat_messages for delete to authenticated
    using (user_id = auth.uid());

-- 2. Direct messages
create table if not exists public.dm_messages (
    id           uuid primary key default gen_random_uuid(),
    sender_id    uuid not null references public.profiles(id) on delete cascade,
    recipient_id uuid not null references public.profiles(id) on delete cascade,
    body         text not null check (char_length(btrim(body)) between 1 and 2000),
    created_at   timestamptz not null default now(),
    read_at      timestamptz,
    check (sender_id <> recipient_id)
);
create index if not exists dm_recipient_idx on public.dm_messages (recipient_id, created_at desc);
create index if not exists dm_sender_idx on public.dm_messages (sender_id, created_at desc);

alter table public.dm_messages enable row level security;

-- readable only by the conversation participants
drop policy if exists "dm_select_participants" on public.dm_messages;
create policy "dm_select_participants" on public.dm_messages for select to authenticated
    using (sender_id = auth.uid() or recipient_id = auth.uid());
-- inserts only through the send_dm RPC (rate limit, bans, self-send checks)
drop policy if exists "dm_insert_direct" on public.dm_messages;
-- read_at is set only through the mark_dms_read RPC
drop policy if exists "dm_update_direct" on public.dm_messages;
-- authors may delete their own message
drop policy if exists "dm_delete_own" on public.dm_messages;
create policy "dm_delete_own" on public.dm_messages for delete to authenticated
    using (sender_id = auth.uid());

-- 3. Columns: online pulse and direct challenges
alter table public.profiles add column if not exists last_seen_at timestamptz;
alter table public.games   add column if not exists invitee uuid
    references public.profiles(id) on delete cascade;

-- 4. Online pulse
create or replace function public.heartbeat()
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then return; end if;
    -- pulses arrive every 30 s; write only when more than 5 s passed
    update public.profiles set last_seen_at = now()
    where id = auth.uid()
      and (last_seen_at is null or last_seen_at < now() - interval '5 seconds');
end $$;

-- 5. Global chat: sending
create or replace function public.send_global_chat(p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row chat_messages%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
        raise exception 'Сообщение должно быть от 1 до 500 символов';
    end if;
    -- rate limit: one message per 800 ms
    if exists (select 1 from public.chat_messages c
               where c.user_id = v_uid
                 and c.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into public.chat_messages (user_id, body)
    values (v_uid, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

-- 6. Direct messages: sending / read receipts
create or replace function public.send_dm(p_recipient uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row dm_messages%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_recipient is null or p_recipient = v_uid then
        raise exception 'Нельзя написать самому себе';
    end if;
    if not exists (select 1 from public.profiles where id = p_recipient) then
        raise exception 'Получатель не найден';
    end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
        raise exception 'Сообщение должно быть от 1 до 2000 символов';
    end if;
    -- rate limit
    if exists (select 1 from public.dm_messages d
               where d.sender_id = v_uid
                 and d.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into public.dm_messages (sender_id, recipient_id, body)
    values (v_uid, p_recipient, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

create or replace function public.mark_dms_read(p_partner uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    update public.dm_messages set read_at = now()
    where recipient_id = auth.uid()
      and sender_id = p_partner
      and read_at is null;
    get diagnostics v_n = row_count;
    return v_n;
end $$;

-- 7. Challenge a specific player
-- create_challenge is defined in 03_functions_core.sql (canonical
-- 5-argument form: p_initial_ms, p_increment_ms, p_rated, p_color,
-- p_invitee) and gains the block checks in 08_blocks.sql. Only the
-- legacy 4-argument overload is dropped here so a re-run of the older
-- files can never leave two candidates for PostgREST to choose from.
drop function if exists public.create_challenge(int, int, boolean, text);

-- join_game: a direct challenge can be accepted by the invitee only
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

-- 8. Replay: FEN after each half-move
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
    v_b := chess_parse_fen(g.start_fen);
    for v_m in select * from jsonb_array_elements(g.moves) loop
        if not chess_validate_move_b(v_b, v_m ->> 'u') then
            exit;
        end if;
        v_b := chess_make_move(v_b,
                 chess_sq_from_name(substr(v_m ->> 'u', 1, 2)),
                 chess_sq_from_name(substr(v_m ->> 'u', 3, 2)),
                 nullif(substr(v_m ->> 'u', 5, 1), ''));
        v_fens := v_fens || chess_to_fen(v_b);
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

-- 9. Permissions
revoke execute on function public.heartbeat()                       from public, anon;
revoke execute on function public.send_global_chat(text)            from public, anon;
revoke execute on function public.send_dm(uuid, text)               from public, anon;
revoke execute on function public.mark_dms_read(uuid)               from public, anon;
revoke execute on function public.create_challenge(int, int, boolean, text, uuid) from public, anon;
revoke execute on function public.join_game(uuid)                   from public, anon;

grant execute on function public.heartbeat()                       to authenticated;
grant execute on function public.send_global_chat(text)            to authenticated;
grant execute on function public.send_dm(uuid, text)               to authenticated;
grant execute on function public.mark_dms_read(uuid)               to authenticated;
grant execute on function public.create_challenge(int, int, boolean, text, uuid) to authenticated;
grant execute on function public.join_game(uuid)                   to authenticated;

-- get_replay stays public (games are public, as on Lichess)

-- 10. Realtime
do $$
begin
    begin
        alter publication supabase_realtime add table public.chat_messages;
    exception when others then null;
    end;
    begin
        alter publication supabase_realtime add table public.dm_messages;
    exception when others then null;
    end;
end $$;
