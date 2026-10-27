-- Chess site schema (Supabase / PostgreSQL 17): tables, RLS,
-- triggers, Realtime. Functions live in 03/04 and later files;
-- depends on the engine in 01_chess_engine.sql.

-- 1. Profiles
create table if not exists public.profiles (
    id           uuid primary key references auth.users(id) on delete cascade,
    username     text not null check (char_length(username) between 2 and 20),
    rating       int  not null default 1200 check (rating between 100 and 3500),
    games        int  not null default 0,
    wins         int  not null default 0,
    losses       int  not null default 0,
    draws        int  not null default 0,
    is_banned    boolean not null default false,
    ban_reason   text,
    created_at   timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));
create index if not exists profiles_rating_idx on public.profiles (rating desc);

alter table public.profiles enable row level security;

-- profiles are public (leaderboard, player names in games)
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public" on public.profiles for select using (true);
-- no insert/update/delete policies: only security definer functions and triggers

-- profile auto-creation on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    v_base text;
    v_candidate text;
    v_n int := 0;
begin
    v_base := coalesce(
        nullif(new.raw_user_meta_data ->> 'username', ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'player');
    v_base := regexp_replace(v_base, '[^a-zA-Z0-9_-]', '', 'g');
    if char_length(v_base) < 2 then v_base := 'player'; end if;
    v_base := left(v_base, 15);
    v_candidate := v_base;
    while exists (select 1 from public.profiles where lower(username) = lower(v_candidate)) loop
        v_n := v_n + 1;
        v_candidate := v_base || v_n::text;
        exit when v_n > 500;
    end loop;
    insert into public.profiles (id, username) values (new.id, v_candidate);
    return new;
end $$;

-- trigger on auth.users, created only when absent (a plain postgres
-- role may lack rights to drop/create triggers on auth.users, in which
-- case the existing one is kept)
do $$
begin
    if not exists (
        select 1 from pg_trigger
        where tgname = 'on_auth_user_created'
          and tgrelid = 'auth.users'::regclass
          and not tgisinternal
    ) then
        drop trigger if exists on_auth_user_created on auth.users;
        create trigger on_auth_user_created
            after insert on auth.users
            for each row execute procedure public.handle_new_user();
    end if;
exception when insufficient_privilege then
    raise notice 'on_auth_user_created: нет прав на триггеры auth.users (триггер уже должен существовать)';
end $$;

-- 2. Games
create table if not exists public.games (
    id               uuid primary key default gen_random_uuid(),
    white            uuid references public.profiles(id) on delete cascade,
    black            uuid references public.profiles(id) on delete cascade,
    status           text not null default 'waiting'
                     check (status in ('waiting','active','finished','aborted')),
    start_fen        text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fen              text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves            jsonb not null default '[]'::jsonb,
    position_history text[] not null default array[]::text[],
    result           text check (result in ('1-0','0-1','1/2-1/2')),
    reason           text,   -- checkmate|stalemate|insufficient_material|fifty_moves|repetition|
                             -- resign|timeout|fraud|abandonment|agreement|forfeit
    winner           uuid references public.profiles(id) on delete set null,
    rated            boolean not null default true,
    initial_ms       int not null check (initial_ms between 30000 and 7200000),
    increment_ms     int not null default 0 check (increment_ms between 0 and 60000),
    white_ms         int not null check (white_ms between 0 and 7200000),
    black_ms         int not null check (black_ms between 0 and 7200000),
    last_move_at     timestamptz not null default now(),
    draw_offer_by    uuid,
    draw_offer_at    timestamptz,
    takeback_by      uuid,
    takeback_at      timestamptz,
    rating_delta     jsonb,
    created_at       timestamptz not null default now(),
    finished_at      timestamptz,
    check (white is null or black is null or white <> black),
    check (status <> 'active' or (white is not null and black is not null)),
    check (status <> 'finished' or finished_at is not null)
);
create index if not exists games_white_idx on public.games (white);
create index if not exists games_black_idx on public.games (black);
create index if not exists games_status_idx on public.games (status) where status in ('waiting','active');
create index if not exists games_created_idx on public.games (created_at desc);
-- migration for pre-existing tables (idempotent)
alter table public.games add column if not exists takeback_by uuid;
alter table public.games add column if not exists takeback_at timestamptz;

alter table public.games enable row level security;
-- games are publicly readable (spectating, as on Lichess)
drop policy if exists "games_select_public" on public.games;
create policy "games_select_public" on public.games for select using (true);
-- writes only through security definer functions (no policies)

-- 3. Quick pairing queue
create table if not exists public.seeks (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null unique references public.profiles(id) on delete cascade,
    initial_ms   int not null check (initial_ms between 500 and 7200000),
    increment_ms int not null default 0 check (increment_ms between 0 and 60000),
    created_at   timestamptz not null default now()
);
alter table public.seeks enable row level security;
-- seeks are readable by everyone: they are the open challenges list in
-- the lobby (guests see them read-only, joining requires sign-in)
drop policy if exists "seeks_select_auth" on public.seeks;
drop policy if exists "seeks_select_public" on public.seeks;
create policy "seeks_select_public" on public.seeks for select using (true);
drop policy if exists "seeks_insert_own" on public.seeks;
create policy "seeks_insert_own" on public.seeks for insert to authenticated
    with check (
        user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
    );
drop policy if exists "seeks_delete_own" on public.seeks;
create policy "seeks_delete_own" on public.seeks for delete to authenticated
    using (user_id = auth.uid());

-- 4. Game chat
create table if not exists public.game_chat (
    id         uuid primary key default gen_random_uuid(),
    game_id    uuid not null references public.games(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    body       text not null check (char_length(btrim(body)) between 1 and 500),
    created_at timestamptz not null default now()
);
create index if not exists game_chat_game_idx on public.game_chat (game_id, created_at);
alter table public.game_chat enable row level security;
drop policy if exists "chat_select_participant" on public.game_chat;
create policy "chat_select_participant" on public.game_chat for select
    using (
        exists (select 1 from public.games g
                where g.id = game_id and (g.white = auth.uid() or g.black = auth.uid()))
    );
-- writes only through the send_chat RPC (rate limiting and checks live
-- in the function): no separate INSERT policy, direct INSERT is denied
-- to all. A policy with a subquery on its own table would recurse in
-- RLS forever.
drop policy if exists "chat_insert_participant" on public.game_chat;

-- 4.1 Rejected move log
-- The database engine rejects illegal moves with ok:false and no
-- penalty: bans for moves or clock claims do not exist. The table is a
-- historical log kept as is; nothing writes to it anymore.
create table if not exists public.move_violations (
    id         bigint generated always as identity primary key,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    game_id    uuid,
    uci        text,
    fen        text,
    created_at timestamptz not null default now()
);
create index if not exists move_violations_user_time_idx
    on public.move_violations (user_id, created_at);
alter table public.move_violations enable row level security;
drop policy if exists "mv_select_all" on public.move_violations;

-- 5. Forum
create table if not exists public.forum_threads (
    id         uuid primary key default gen_random_uuid(),
    author_id  uuid not null references public.profiles(id) on delete cascade,
    title      text not null check (char_length(btrim(title)) between 3 and 120),
    body       text not null check (char_length(btrim(body)) between 1 and 10000),
    created_at timestamptz not null default now()
);
create index if not exists forum_threads_created_idx on public.forum_threads (created_at desc);
alter table public.forum_threads enable row level security;
drop policy if exists "threads_select_public" on public.forum_threads;
create policy "threads_select_public" on public.forum_threads for select using (true);
drop policy if exists "threads_insert_auth" on public.forum_threads;
create policy "threads_insert_auth" on public.forum_threads for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
    );
drop policy if exists "threads_update_own" on public.forum_threads;
create policy "threads_update_own" on public.forum_threads for update to authenticated
    using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists "threads_delete_own" on public.forum_threads;
create policy "threads_delete_own" on public.forum_threads for delete to authenticated
    using (author_id = auth.uid());

create table if not exists public.forum_replies (
    id         uuid primary key default gen_random_uuid(),
    thread_id  uuid not null references public.forum_threads(id) on delete cascade,
    author_id  uuid not null references public.profiles(id) on delete cascade,
    body       text not null check (char_length(btrim(body)) between 1 and 5000),
    created_at timestamptz not null default now()
);
create index if not exists forum_replies_thread_idx on public.forum_replies (thread_id, created_at);
alter table public.forum_replies enable row level security;
drop policy if exists "replies_select_public" on public.forum_replies;
create policy "replies_select_public" on public.forum_replies for select using (true);
drop policy if exists "replies_insert_auth" on public.forum_replies;
create policy "replies_insert_auth" on public.forum_replies for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
        and exists (select 1 from public.forum_threads t where t.id = thread_id)
    );
drop policy if exists "replies_delete_own" on public.forum_replies;
create policy "replies_delete_own" on public.forum_replies for delete to authenticated
    using (author_id = auth.uid());

-- 6. Clubs
create table if not exists public.clubs (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(btrim(name)) between 3 and 40),
    description text not null default '' check (char_length(description) <= 1000),
    owner_id    uuid not null references public.profiles(id) on delete cascade,
    created_at  timestamptz not null default now()
);
create unique index if not exists clubs_name_lower_idx on public.clubs (lower(name));
alter table public.clubs enable row level security;
drop policy if exists "clubs_select_public" on public.clubs;
create policy "clubs_select_public" on public.clubs for select using (true);
drop policy if exists "clubs_insert_auth" on public.clubs;
create policy "clubs_insert_auth" on public.clubs for insert to authenticated
    with check (
        owner_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
    );
drop policy if exists "clubs_update_owner" on public.clubs;
create policy "clubs_update_owner" on public.clubs for update to authenticated
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "clubs_delete_owner" on public.clubs;
create policy "clubs_delete_owner" on public.clubs for delete to authenticated
    using (owner_id = auth.uid());

create table if not exists public.club_members (
    club_id   uuid not null references public.clubs(id) on delete cascade,
    user_id   uuid not null references public.profiles(id) on delete cascade,
    role      text not null default 'member' check (role in ('owner','member')),
    joined_at timestamptz not null default now(),
    primary key (club_id, user_id)
);
alter table public.club_members enable row level security;
drop policy if exists "members_select_public" on public.club_members;
create policy "members_select_public" on public.club_members for select using (true);
drop policy if exists "members_insert_own" on public.club_members;
create policy "members_insert_own" on public.club_members for insert to authenticated
    with check (
        user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
        and exists (select 1 from public.clubs c where c.id = club_id)
        and not exists (select 1 from public.club_members m2 where m2.club_id = club_id and m2.user_id = auth.uid())
    );
drop policy if exists "members_leave_own" on public.club_members;
create policy "members_leave_own" on public.club_members for delete to authenticated
    using (
        user_id = auth.uid()
        or exists (select 1 from public.clubs c where c.id = club_id and c.owner_id = auth.uid())
    );

-- the club owner becomes a member automatically
create or replace function public.handle_new_club()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.club_members (club_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict do nothing;
    return new;
end $$;
drop trigger if exists on_club_created on public.clubs;
create trigger on_club_created
    after insert on public.clubs
    for each row execute procedure public.handle_new_club();

-- 6.1 Club chat
create table if not exists public.club_chat (
    id         uuid primary key default gen_random_uuid(),
    club_id    uuid not null references public.clubs(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    body       text not null check (char_length(btrim(body)) between 1 and 500),
    created_at timestamptz not null default now()
);
create index if not exists club_chat_club_idx on public.club_chat (club_id, created_at);
alter table public.club_chat enable row level security;
drop policy if exists "club_chat_select_member" on public.club_chat;
create policy "club_chat_select_member" on public.club_chat for select
    using (
        exists (select 1 from public.club_members m
                where m.club_id = club_id and m.user_id = auth.uid())
    );
-- writes only through the send_club_chat RPC (membership, rate
-- limiting, and ban checks in the function): no separate INSERT policy,
-- direct INSERT is denied to all.

-- 7. Blog
create table if not exists public.blog_posts (
    id         uuid primary key default gen_random_uuid(),
    author_id  uuid not null references public.profiles(id) on delete cascade,
    title      text not null check (char_length(btrim(title)) between 3 and 120),
    body       text not null check (char_length(btrim(body)) between 1 and 20000),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists blog_posts_created_idx on public.blog_posts (created_at desc);
alter table public.blog_posts enable row level security;
drop policy if exists "blog_select_public" on public.blog_posts;
create policy "blog_select_public" on public.blog_posts for select using (true);
drop policy if exists "blog_insert_auth" on public.blog_posts;
create policy "blog_insert_auth" on public.blog_posts for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
    );
drop policy if exists "blog_update_own" on public.blog_posts;
create policy "blog_update_own" on public.blog_posts for update to authenticated
    using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists "blog_delete_own" on public.blog_posts;
create policy "blog_delete_own" on public.blog_posts for delete to authenticated
    using (author_id = auth.uid());

-- 8. Realtime
do $$
begin
    begin
        alter publication supabase_realtime add table public.games;
    exception when others then null; -- already added
    end;
    begin
        alter publication supabase_realtime add table public.game_chat;
    exception when others then null;
    end;
    begin
        alter publication supabase_realtime add table public.seeks;
    exception when others then null;
    end;
    begin
        alter publication supabase_realtime add table public.club_chat;
    exception when others then null;
    end;
end $$;
